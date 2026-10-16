/**
 * Agent browser: a real Chromium view embedded in the desktop window,
 * driven by the model through the CDP relay (see cdp-relay.ts).
 *
 * Layout: production uses an independent top-level BrowserWindow positioned beside
 * the main window once. Its chrome strip and driven page remain WebContentsViews
 * inside that window, so native browser content cannot cover the Harness page. The
 * child-view layout remains available for isolated tests and hosts that do not
 * provide a pane window factory.
 *
 * - One view per CDP target; only the active view is attached to the window.
 * - The pane is hidden until the first CDP client connects (model started
 *   driving) or the user toggles it. Every toggle route — the macOS/Linux View
 *   menu, the Windows caption menu and the session header button — goes through
 *   the same command, because the menu bar itself is hidden on Windows and a
 *   shortcut nobody can see is not an entry point.
 * - The chrome strip is a second local page (`build/agent-browser-pane.html`) with
 *   its own preload: the Harness page cannot paint into a band a native view sits
 *   on top of, and the strip must work even when the app page is a recovery page.
 * - Login state persists in the app's userData via a dedicated partition.
 */
import { WebContentsView, screen, type BrowserWindow, type BrowserWindowConstructorOptions, type View, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  PANE_STATE_PUSH_CHANNEL,
  isAgentBrowserPaneAction,
  paneNavigationNotice,
  resolvePaneNavigationUrl,
  type AgentBrowserPaneAction,
  type AgentBrowserPaneState,
  type AgentBrowserTab
} from '../../shared/agent-browser'
import {
  MIN_PANE_WIDTH,
  PANE_CHROME_HEIGHT,
  planPaneOpen,
  planPaneResize,
  planPaneRestore,
  planCompanionOpen,
  planCompanionRestore,
  preferredPaneWidth,
  resolvePaneWidth,
  paneGeometry,
  type PaneGrowth,
  type Rect
} from './pane-layout'
import { CdpRelay, type RelayDebugger, type RelayTarget, type RelayTargetHost } from './cdp-relay'

const BLANK_URL = 'about:blank'

/** Electron hands back a plain rectangle; this keeps the geometry module's type honest. */
function toRect(bounds: { x: number; y: number; width: number; height: number }): Rect {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
}
/** Where the chrome page lives; provided by the host so paths stay one concern. */
export interface PaneChromeResources {
  htmlPath: string
  preloadPath: string
}

class DebuggerAdapter implements RelayDebugger {
  private readonly handlers = new Set<(method: string, params: Record<string, unknown>) => void>()
  private attached = false

  constructor(private readonly contents: WebContents) {}

  attach(): void {
    if (this.attached) return
    try {
      this.contents.debugger.attach('1.3')
      this.attached = true
    } catch (error) {
      throw new Error(`agent browser: debugger attach failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.contents.debugger.on('message', (_event, method, params) => {
      for (const h of this.handlers) {
        try { h(method, (params ?? {}) as Record<string, unknown>) } catch { /* a bad listener must not break dispatch */ }
      }
    })
    this.contents.debugger.on('detach', () => { this.attached = false })
  }

  get isAttached(): boolean {
    return this.attached
  }

  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.attached) this.attach()
    return this.contents.debugger.sendCommand(method, params)
  }

  onMessage(handler: (method: string, params: Record<string, unknown>) => void): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }
}

interface AgentView {
  readonly target: RelayTarget & { title: string; url: string }
  readonly view: WebContentsView
}

export interface AgentBrowserOptions {
  /** Called with the relay endpoint once it is listening. */
  onRelayReady?: (endpoint: string) => void
  /**
   * Called whenever the pane is shown or hidden. The relay auto-opens the pane on
   * the model's first CDP connection, so the page cannot learn about that from its
   * own click; this is what keeps the header button's pressed state honest.
   */
  onVisibilityChange?: (visible: boolean) => void
  /** The chrome page is an independent page: it needs the app language and theme. */
  getPresentation?: () => { lang: AgentBrowserPaneState['lang']; theme: AgentBrowserPaneState['theme'] }
  /** Chrome page assets. Without them the pane has no tab strip or address bar. */
  getChromeResources?: () => PaneChromeResources
  /** Display work area used to decide how far the window may grow. */
  getWorkArea?: (windowBounds: Rect) => Rect
  /** Create the browser companion window. Production uses this instead of child views. */
  createPaneWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow
  log?: (message: string) => void
}

/**
 * Work area fallback: `screen` is unusable before app ready and absent in unit
 * tests. Treating an unknown screen as unbounded keeps the pane dockable — the
 * pane then grows by its own preferred width, which is the behaviour a test or a
 * headless caller expects instead of a silent refusal.
 */
function defaultWorkArea(windowBounds: Rect): Rect {
  const display = typeof screen?.getDisplayMatching === 'function'
    ? screen.getDisplayMatching(windowBounds)
    : undefined
  if (!display) return { x: 0, y: 0, width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER }
  return display.workArea
}

export class AgentBrowser implements RelayTargetHost {
  private readonly views = new Map<string, AgentView>()
  private readonly changedHandlers = new Set<() => void>()
  private relay: CdpRelay | null = null
  private visible = false
  private activeTargetId: string | null = null
  /** The relay starts with one real view so CDP has a target before the first client. */
  private placeholderTargetId: string | null = null
  private readonly log: (message: string) => void
  /** Browser content width in DIPs; native resize events keep it current. */
  private paneWidth = 0
  /** Content bounds to go back to when the pane was opened by widening the window. */
  private preOpenBounds: Rect | null = null
  private growth: PaneGrowth | null = null
  /** Transient message for the address field, cleared by the next pushed action. */
  private notice = ''
  private chromeView: WebContentsView | null = null
  /** The BrowserWindow's own WebContentsView, which must shrink beside the pane. */
  private appView: View | null = null
  /** Separate native window used by the production desktop host. */
  private paneWindow: BrowserWindow | null = null
  private closingPaneForShutdown = false
  private companionPreOpenBounds: Rect | null = null
  private companionMainBounds: Rect | null = null
  /**
   * The strip page loads asynchronously while docking is synchronous, so the load
   * promise is kept here: an open click must not start a second webContents.
   */
  private chromePending: Promise<WebContentsView | null> | null = null
  /**
   * Closing to tray and reopening replaces the window, and a destroyed window
   * takes its child views with it. Resolving the window on demand — instead of
   * capturing the one we were constructed with — is what keeps the toggle alive;
   * the resize listener is wired once per window.
   */
  private readonly resizeWired = new WeakSet<BrowserWindow>()

  constructor(
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly options: AgentBrowserOptions = {},
  ) {
    this.log = options.log ?? (() => {})
  }

  /** Create the first (hidden) view and start the CDP relay. Must run before the Harness subprocess spawns. */
  async start(): Promise<string> {
    const placeholder = await this.createView(BLANK_URL)
    this.placeholderTargetId = placeholder.target.id
    this.relay = await CdpRelay.start(this, {
      onFirstClient: () => this.setVisible(true),
    })
    this.options.onRelayReady?.(this.relay.endpoint)
    this.log(`[agent-browser] CDP relay listening at ${this.relay.endpoint}`)
    return this.relay.endpoint
  }

  get endpoint(): string {
    return this.relay?.endpoint ?? ''
  }

  get isVisible(): boolean {
    return this.visible
  }

  /**
   * Show or hide the pane. Returns the resulting visibility so the menu command
   * and the page's toggle button can report the truth instead of silently doing
   * nothing when there is no window to dock into — or when the window is too small
   * to give up a readable page band.
   */
  setVisible(visible: boolean): boolean {
    const window = this.currentWindow()
    if (window === undefined) return false
    if (visible === this.visible) {
      // Already in the requested state: re-dock so the geometry matches the window
      // the user may have dragged or resized meanwhile.
      this.layout()
      return this.visible
    }
    if (visible) {
      if (this.options.createPaneWindow !== undefined) this.ensurePaneWindow(window)
      const plan = this.paneWindow === null
        ? { kind: 'embedded' as const, value: planPaneOpen({
          contentBounds: toRect(window.getContentBounds()),
          workArea: (this.options.getWorkArea ?? defaultWorkArea)(toRect(window.getBounds())),
          canGrow: !window.isMaximized() && !window.isFullScreen()
        }) }
        : { kind: 'independent' as const, value: planCompanionOpen(
          toRect(window.getContentBounds()),
          (this.options.getWorkArea ?? defaultWorkArea)(toRect(window.getBounds()))
        ) }
      if (!plan.value.canDock) {
        this.log('[agent-browser] window is too narrow to dock the pane; staying hidden')
        return false
      }
      if (plan.kind === 'embedded') {
        this.preOpenBounds = toRect(window.getContentBounds())
        this.growth = plan.value.growth
        if (plan.value.contentBounds) window.setContentBounds(plan.value.contentBounds)
      } else if (plan.value.mainBounds !== null) {
        this.companionPreOpenBounds = toRect(window.getContentBounds())
        this.companionMainBounds = plan.value.mainBounds
        window.setContentBounds(plan.value.mainBounds)
      }
      this.paneWidth = plan.value.paneWidth
      // Docking cannot wait for the strip page, so it loads in the background and
      // re-lays-out when ready. Without it the pane would be a page with no tabs.
      void this.ensureChrome().then(() => {
        this.layout()
        this.pushState()
      }).catch((error: unknown) => {
        this.log(`[agent-browser] pane chrome unavailable: ${error instanceof Error ? error.message : String(error)}`)
      })
    } else {
      this.paneWindow?.hide()
      this.restoreCompanionWindow(window)
      this.restoreWindowWidth(window)
      this.detachAllViews()
    }
    this.visible = visible
    this.layout()
    if (visible) this.paneWindow?.showInactive()
    this.options.onVisibilityChange?.(visible)
    return this.visible
  }

  toggle(): boolean {
    return this.setVisible(!this.visible)
  }

  /** Width currently occupied by the browser window, in DIPs (0 while hidden). */
  get currentPaneWidth(): number {
    return this.visible ? this.paneWidth : 0
  }

  /**
   * Re-dock into whichever window exists now. `createWindow()` calls this after a
   * close-to-tray reopen; without it the pane stays bound to the destroyed window
   * and every toggle becomes a silent no-op.
   */
  async attachToWindow(): Promise<void> {
    if (this.currentWindow() === undefined) return
    this.pruneDestroyedViews()
    // The relay needs at least one target at all times, and the previous window
    // took its child views with it when it was destroyed.
    if (this.views.size === 0) await this.createView(BLANK_URL)
    if (this.chromeView !== null && this.chromeView.webContents.isDestroyed()) this.chromeView = null
    // The strip only costs a renderer while the pane is actually docked.
    if (this.visible) await this.ensureChrome()
    this.layout()
    this.pushState()
  }

  /** Pane chrome IPC ---------------------------------------------- */

  /**
   * True only for the strip this instance created. The strip is a second
   * webContents, so privileged pane calls cannot reuse the main-window check.
   */
  isChromeSender(candidate: WebContents | null): boolean {
    const chrome = this.chromeView
    return candidate !== null && chrome !== null && !chrome.webContents.isDestroyed() && candidate === chrome.webContents
  }

  /** Current strip state. The strip pulls this on load, before any push lands. */
  paneState(): AgentBrowserPaneState {
    return this.buildState('')
  }

  /**
   * Re-send the state after something the strip renders but the pane did not change
   * itself: the app theme or language. `getPresentation()` is read when building, so
   * there is nothing to invalidate here beyond the push.
   */
  refreshPanePresentation(): void {
    this.pushState()
  }

  /**
   * Apply one gesture from the strip and answer with the resulting state.
   *
   * Invalid addresses are rejected here rather than handed to Chromium: the strip
   * only ever navigates the webContents the model is driving.
   */
  async applyPaneAction(input: unknown): Promise<AgentBrowserPaneState | null> {
    if (!isAgentBrowserPaneAction(input)) {
      throw new Error('agent browser: unsupported pane action')
    }
    const active = this.activeView()
    switch (input.type) {
      case 'activate-tab':
        this.activateTarget(input.tabId)
        break
      case 'close-tab':
        await this.closeTarget(input.tabId)
        break
      case 'new-tab':
      case 'navigate': {
        // "+" from the strip means a blank tab; anything else goes through the
        // same address rules so a typed host cannot smuggle in another scheme.
        const requested = input.type === 'new-tab' && input.url === '' ? BLANK_URL : input.url
        const resolved = resolvePaneNavigationUrl(requested)
        if (!resolved.ok) return this.buildState(paneNavigationNotice(resolved.reason, this.presentation().lang))
        if (input.type === 'navigate' && active !== undefined) {
          await this.loadIn(active, resolved.url)
        } else {
          const target = await this.createTarget(resolved.url)
          this.activateTarget(target.id)
        }
        break
      }
      case 'reload':
        if (active && !active.view.webContents.isDestroyed()) active.view.webContents.reload()
        break
      case 'go-back':
        if (active?.view.webContents.canGoBack()) active.view.webContents.goBack()
        break
      case 'go-forward':
        if (active?.view.webContents.canGoForward()) active.view.webContents.goForward()
        break
      case 'set-pane-width': {
        const window = this.currentWindow()
        if (window === undefined) break
        const currentBounds = toRect(window.getContentBounds())
        const width = this.paneWindow !== null
          ? Math.max(MIN_PANE_WIDTH, Math.round(input.width))
          : resolvePaneWidth(currentBounds.width, input.width)
        if (width === undefined) break
        if (this.paneWindow !== null && !this.paneWindow.isDestroyed()) {
          const next = Math.max(MIN_PANE_WIDTH, Math.round(input.width))
          const height = this.paneWindow.getContentBounds().height
          this.paneWindow.setContentSize(next, height)
          this.paneWidth = next
          this.layout()
          break
        }
        if (this.preOpenBounds !== null && this.growth !== null) {
          const resized = planPaneResize(currentBounds, this.preOpenBounds, this.growth, width)
          if (resized !== null) {
            window.setContentBounds(resized)
            this.growth = { ...this.growth, width }
          }
        }
        this.paneWidth = width
        this.layout()
        break
      }
      case 'hide':
        this.setVisible(false)
        break
    }
    return this.buildState('')
  }

  /** RelayTargetHost --------------------------------------------------- */

  listTargets(): RelayTarget[] {
    // A companion window can be destroyed by an older build or during shutdown;
    // never advertise those native handles to a newly connected CDP client.
    this.pruneDestroyedViews()
    return [...this.views.values()].map((v) => v.target)
  }

  async createTarget(url: string): Promise<RelayTarget> {
    const placeholderId = this.placeholderTargetId
    if (placeholderId !== null && this.views.size === 1) {
      const placeholder = this.views.get(placeholderId)
      if (placeholder !== undefined && placeholder.target.url === BLANK_URL) {
        // The relay needs a target before a client connects, while BrowserService
        // needs a target for its first page. Reusing this view avoids showing a
        // second empty tab during the first model connection.
        await this.loadIn(placeholder, url)
        this.placeholderTargetId = null
        return placeholder.target
      }
    }
    return (await this.createView(url)).target
  }

  async closeTarget(id: string): Promise<boolean> {
    const v = this.views.get(id)
    if (!v) return false
    // Never close the last view: the relay always needs at least one target.
    if (this.views.size === 1) {
      await v.view.webContents.loadURL(BLANK_URL)
      v.target.url = BLANK_URL
      v.target.title = ''
      this.emitChanged()
      return true
    }
    // A removed target is no longer in `views`, so nothing else would ever take it
    // out of the window: closing a tab left its native page painted over the pane.
    this.detachView(v.view)
    this.views.delete(id)
    if (this.activeTargetId === id) {
      const next = [...this.views.keys()][0]
      if (next) this.activateTarget(next)
    }
    // webContents.destroy() on a detached view; GC handles the rest.
    if (!v.view.webContents.isDestroyed()) v.view.webContents.close()
    this.emitChanged()
    return true
  }

  activateTarget(id: string): void {
    const v = this.views.get(id)
    const window = this.currentWindow()
    if (!v || window === undefined) return
    this.activeTargetId = id
    // Driving started (or switched tabs): make sure the user can see it.
    if (!this.visible) {
      this.setVisible(true)
      return
    }
    this.layout()
  }

  onTargetsChanged(handler: () => void): () => void {
    this.changedHandlers.add(handler)
    return () => { this.changedHandlers.delete(handler) }
  }

  /** Internals ---------------------------------------------------------- */

  /** The window to dock into, or undefined when none is alive. */
  private currentWindow(): BrowserWindow | undefined {
    const window = this.getWindow()
    if (window === undefined || window.isDestroyed()) return undefined
    if (!this.resizeWired.has(window)) {
      this.resizeWired.add(window)
      window.on('resize', () => this.layout())
      window.on('closed', () => {
        // The browser window is independent while the main window is alive, but
        // must not become an orphan after the application window is destroyed.
        if (this.paneWindow !== null && !this.paneWindow.isDestroyed()) {
          this.closingPaneForShutdown = true
          this.paneWindow.close()
        }
      })
    }
    if (this.paneWindow === null) this.rememberAppView(window)
    return window
  }

  private ensurePaneWindow(mainWindow: BrowserWindow): void {
    if (this.paneWindow !== null && !this.paneWindow.isDestroyed()) return
    const create = this.options.createPaneWindow
    if (create === undefined) return
    const main = toRect(mainWindow.getBounds())
    const workArea = (this.options.getWorkArea ?? defaultWorkArea)(main)
    const width = Math.max(MIN_PANE_WIDTH, Math.min(preferredPaneWidth(main.width), workArea.width))
    const rightX = main.x + main.width
    const leftX = main.x - width
    const x = rightX + width <= workArea.x + workArea.width
      ? rightX
      : leftX >= workArea.x
        ? leftX
        : Math.max(workArea.x, workArea.x + workArea.width - width)
    const pane = create({
      show: false,
      frame: true,
      x,
      y: main.y,
      width,
      height: main.height,
      minWidth: MIN_PANE_WIDTH,
      minHeight: 480,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
      skipTaskbar: false,
      backgroundColor: '#18181b',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    this.paneWindow = pane
    pane.on('move', () => this.syncPaneWidthFromWindow())
    pane.on('resize', () => this.syncPaneWidthFromWindow())
    pane.on('close', (event: { preventDefault?: () => void }) => {
      if (this.closingPaneForShutdown) return
      // Closing the companion is a user visibility choice. Keeping its native
      // contents alive avoids invalidating the CDP target while a model turn is
      // still running, and lets the existing toggle reopen the same tabs.
      event.preventDefault?.()
      this.setVisible(false)
    })
    pane.on('closed', () => {
      this.closingPaneForShutdown = false
      const mainWindow = this.currentWindow()
      if (mainWindow !== undefined) this.restoreCompanionWindow(mainWindow)
      if (this.paneWindow === pane) this.paneWindow = null
      if (this.visible) {
        this.visible = false
        this.detachAllViews()
        this.options.onVisibilityChange?.(false)
      }
    })
  }

  private syncPaneWidthFromWindow(): void {
    const pane = this.paneWindow
    if (pane === null || pane.isDestroyed()) return
    this.paneWidth = Math.max(MIN_PANE_WIDTH, pane.getContentBounds().width)
    this.layout()
    this.pushState()
  }

  /**
   * BrowserWindow owns its renderer through a child WebContentsView. Native pane
   * views are painted above it, so remembering that child lets us reserve the
   * pane band instead of merely covering the renderer's right edge.
   */
  private rememberAppView(window: BrowserWindow): void {
    const candidate = window.contentView.children.find((child) => {
      return child instanceof WebContentsView && child.webContents === window.webContents
    })
    if (candidate !== undefined) this.appView = candidate
  }

  /** Take one view out of the window it is docked into, if any. */
  private detachView(view: WebContentsView): void {
    const window = this.paneWindow ?? this.currentWindow()
    if (window === undefined) return
    if (window.contentView.children.includes(view)) window.contentView.removeChildView(view)
  }

  /** Drop views whose webContents died together with a closed window. */
  private pruneDestroyedViews(): void {
    for (const [id, record] of this.views) {
      if (record.view.webContents.isDestroyed()) {
        this.detachView(record.view)
        this.views.delete(id)
      }
    }
    if (this.activeTargetId === null || !this.views.has(this.activeTargetId)) {
      this.activeTargetId = [...this.views.keys()][0] ?? null
    }
  }

  private emitChanged(): void {
    for (const h of this.changedHandlers) {
      try { h() } catch { /* a bad listener must not break target tracking */ }
    }
    this.pushState()
  }

  private presentation(): { lang: AgentBrowserPaneState['lang']; theme: AgentBrowserPaneState['theme'] } {
    return this.options.getPresentation?.() ?? { lang: 'en', theme: 'light' }
  }

  private activeView(): AgentView | undefined {
    return this.activeTargetId === null ? undefined : this.views.get(this.activeTargetId)
  }

  private buildState(notice: string): AgentBrowserPaneState {
    const tabs: AgentBrowserTab[] = [...this.views.values()].map((v) => {
      const contents = v.view.webContents
      const destroyed = contents.isDestroyed()
      return {
        id: v.target.id,
        title: destroyed ? '' : contents.getTitle(),
        url: destroyed ? v.target.url : contents.getURL(),
        active: v.target.id === this.activeTargetId,
        loading: destroyed ? false : contents.isLoading(),
        canGoBack: destroyed ? false : contents.canGoBack(),
        canGoForward: destroyed ? false : contents.canGoForward()
      }
    })
    const presentation = this.presentation()
    return {
      visible: this.visible,
      tabs,
      paneWidth: this.paneWidth,
      chromeHeight: PANE_CHROME_HEIGHT,
      lang: presentation.lang,
      theme: presentation.theme,
      notice
    }
  }

  /** Push to the strip only; the Harness page learns visibility, not tab detail. */
  private pushState(): void {
    const chrome = this.chromeView
    if (chrome === null || chrome.webContents.isDestroyed()) return
    chrome.webContents.send(PANE_STATE_PUSH_CHANNEL, this.buildState(this.takeNotice()))
  }

  private takeNotice(): string {
    const notice = this.notice
    this.notice = ''
    return notice
  }

  /** Show a message on the strip even when the gesture changed nothing else. */
  private reportNotice(notice: string): void {
    this.notice = notice
    this.pushState()
  }

  private async loadIn(record: AgentView, url: string): Promise<void> {
    const contents = record.view.webContents
    if (contents.isDestroyed()) return
    try {
      await contents.loadURL(url)
      record.target.url = contents.getURL()
      record.target.title = contents.getTitle()
      this.emitChanged()
    } catch (error) {
      // A rejected navigation is a visible failure, not a hung strip.
      this.reportNotice(error instanceof Error ? error.message : String(error))
    }
  }

  private async ensureChrome(): Promise<WebContentsView | null> {
    if (this.chromeView !== null && !this.chromeView.webContents.isDestroyed()) return this.chromeView
    if (this.chromePending !== null) return this.chromePending
    this.chromePending = this.createChrome().finally(() => { this.chromePending = null })
    return this.chromePending
  }

  private async createChrome(): Promise<WebContentsView | null> {
    const resources = this.options.getChromeResources?.()
    if (resources === undefined) {
      this.log('[agent-browser] no pane chrome page configured; the pane has no tabs or address bar')
      return null
    }
    const view = new WebContentsView({
      webPreferences: {
        preload: resources.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    this.chromeView = view
    try {
      await loadLocalPage(view.webContents, resources.htmlPath)
    } catch (error) {
      this.chromeView = null
      view.webContents.close()
      throw new Error(`agent browser: pane chrome failed to load: ${error instanceof Error ? error.message : String(error)}`)
    }
    view.webContents.on('destroyed', () => {
      if (this.chromeView === view) this.chromeView = null
    })
    return view
  }

  private async createView(url: string): Promise<AgentView> {
    const targetId = randomUUID()
    const view = new WebContentsView({
      webPreferences: {
        // Isolated, persistent session: login state survives restarts,
        // separate from the dsh UI's own session.
        partition: 'persist:agent-browser',
      },
    })
    const adapter = new DebuggerAdapter(view.webContents)
    const target: RelayTarget & { title: string; url: string } = {
      id: targetId,
      title: '',
      url,
      debugger: adapter,
    }
    const record: AgentView = { target, view }
    view.webContents.on('page-title-updated', (_event, title) => { target.title = title; this.pushState() })
    view.webContents.on('did-navigate', (_event, navUrl) => { target.url = navUrl; this.pushState() })
    view.webContents.on('did-navigate-in-page', (_event, navUrl) => { target.url = navUrl; this.pushState() })
    view.webContents.on('did-finish-load', () => {
      target.title = view.webContents.getTitle()
      target.url = view.webContents.getURL()
      this.pushState()
    })
    // Back/forward/reload live in the strip, so it needs to hear about loading too.
    view.webContents.on('did-start-loading', () => this.pushState())
    view.webContents.on('did-stop-loading', () => this.pushState())
    view.webContents.on('did-fail-load', () => this.pushState())
    // Block popups from escaping into real windows: open them as new agent tabs.
    view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
      void this.createTarget(popupUrl).then((t) => this.activateTarget(t.id))
      return { action: 'deny' }
    })
    this.views.set(targetId, record)
    if (this.activeTargetId === null) this.activeTargetId = targetId
    await view.webContents.loadURL(url)
    adapter.attach()
    this.emitChanged()
    return record
  }

  /** Drop every attached view; used when hiding so "hidden" really means hidden. */
  private detachAllViews(): void {
    const window = this.paneWindow ?? this.currentWindow()
    if (window === undefined) return
    for (const v of this.views.values()) this.detachView(v.view)
    if (this.chromeView !== null) this.detachView(this.chromeView)
  }

  private restoreWindowWidth(window: BrowserWindow): void {
    if (this.preOpenBounds === null || this.growth === null) return
    const restored = planPaneRestore(toRect(window.getContentBounds()), this.preOpenBounds, this.growth)
    if (restored) window.setContentBounds(restored)
    this.preOpenBounds = null
    this.growth = null
  }

  private restoreCompanionWindow(mainWindow: BrowserWindow): void {
    const original = this.companionPreOpenBounds
    const managed = this.companionMainBounds
    if (original !== null && managed !== null) {
      try {
        if (!mainWindow.isDestroyed()) {
          const restored = planCompanionRestore(toRect(mainWindow.getContentBounds()), original, managed)
          if (restored !== null && !mainWindow.isDestroyed()) mainWindow.setContentBounds(restored)
        }
      } catch (error) {
        // Closing windows can invalidate the native handle between the lifecycle
        // check and getContentBounds; restoration is optional during shutdown.
        if (error instanceof Error && /destroyed/i.test(error.message)) {
          this.log('[agent-browser] skipped main-window restoration after destruction')
        } else {
          throw error
        }
      }
    }
    this.companionPreOpenBounds = null
    this.companionMainBounds = null
  }

  private layout(): void {
    const mainWindow = this.currentWindow()
    if (mainWindow === undefined) return
    const window = this.paneWindow ?? mainWindow
    const contentView = window.contentView
    const active = this.activeView()
    for (const v of this.views.values()) {
      if (!contentView.children.includes(v.view)) continue
      // Hidden has to mean hidden. Only detaching the *inactive* views (the old
      // behaviour) left the active one covering half the chat, so hiding the pane
      // was a no-op and the toggle could never be undone from the keyboard.
      if (!this.visible || v !== active) contentView.removeChildView(v.view)
    }
    const area = contentView.getBounds()
    if (this.paneWindow === null) this.rememberAppView(window)
    if (!this.visible || !active) {
      if (this.paneWindow === null) this.appView?.setBounds({ x: 0, y: 0, width: area.width, height: area.height })
      return
    }
    const width = this.paneWindow !== null
      ? area.width
      : resolvePaneWidth(area.width, this.paneWidth)
    if (width === undefined) {
      // The window shrank under what both halves need. Hiding is the honest answer:
      // continuing to dock would cover the chat again, which is the original defect.
      this.log('[agent-browser] window became too narrow for the pane; hiding it')
      this.setVisible(false)
      return
    }
    this.paneWidth = width
    const geometry = paneGeometry(area, width)
    if (this.paneWindow === null) this.appView?.setBounds({ x: 0, y: 0, width: geometry.page.x, height: area.height })
    const chrome = this.chromeView
    if (chrome !== null && !chrome.webContents.isDestroyed()) {
      if (!contentView.children.includes(chrome)) contentView.addChildView(chrome)
      chrome.setBounds(geometry.chrome)
    }
    if (!contentView.children.includes(active.view)) contentView.addChildView(active.view)
    active.view.setBounds(geometry.page)
  }

  async stop(): Promise<void> {
    await this.relay?.stop().catch(() => { /* shutdown path; already stopping */ })
    this.relay = null
    for (const v of this.views.values()) {
      if (!v.view.webContents.isDestroyed()) v.view.webContents.close()
    }
    this.views.clear()
    if (this.chromeView !== null && !this.chromeView.webContents.isDestroyed()) {
      this.chromeView.webContents.close()
    }
    this.chromeView = null
    if (this.paneWindow !== null && !this.paneWindow.isDestroyed()) {
      this.closingPaneForShutdown = true
      this.paneWindow.close()
    }
    this.paneWindow = null
  }
}

/**
 * Load the chrome page from disk.
 *
 * `loadURL(file://…)` keeps the same file working under `file:` navigation rules;
 * the `loadFile` fallback mirrors how the other standalone desktop pages are opened.
 */
async function loadLocalPage(contents: WebContents, filePath: string): Promise<void> {
  try {
    await contents.loadURL(pathToFileURL(filePath).href)
  } catch {
    await contents.loadFile(filePath)
  }
}
