/**
 * The embedded pane is a native child view, so its failure modes live entirely in the
 * window lifecycle and the geometry it is given: closing to tray destroys the window,
 * reopening makes a new one, and a view that covers the chat instead of making room
 * for itself is the "the browser hid my conversation" report.
 *
 * These tests drive the real AgentBrowser against faked Electron surfaces — no CDP
 * relay, no Chromium — covering docking, the tab strip's gestures and the address
 * bar's trust boundary, all of which a user can actually observe.
 */
import { describe, expect, it, vi } from 'vitest'
import { PANE_CHROME_HEIGHT } from '../src/main/agent-browser/pane-layout'
import type { AgentBrowserPaneState, AgentBrowserTab } from '../src/shared/agent-browser'

interface FakeBounds {
  x: number
  y: number
  width: number
  height: number
}

/** The strip page is the one loaded from the pane chrome file; everything else is a tab. */
const CHROME_MARKER = 'agent-browser-pane.html'

/** The one object identity used everywhere: what `WebContentsView` resolves to. */
class FakeView {
  bounds: FakeBounds = { x: 0, y: 0, width: 0, height: 0 }
  loadedUrl = 'about:blank'
  destroyed = false
  title = 'fake page'
  loading = false
  history: string[] = ['about:blank']
  historyIndex = 0
  reloads = 0
  readonly sent: Array<[string, unknown]> = []
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  readonly webPreferences: Record<string, unknown>
  readonly mainFrame = { name: 'main-frame' }

  constructor(options?: { webPreferences?: Record<string, unknown> }) {
    this.webPreferences = options?.webPreferences ?? {}
  }

  get isChrome(): boolean {
    return this.loadedUrl.includes(CHROME_MARKER)
  }

  readonly webContents = {
    on: (event: string, handler: (...args: unknown[]) => void): void => {
      const list = this.listeners.get(event) ?? []
      list.push(handler)
      this.listeners.set(event, list)
    },
    loadURL: async (url: string): Promise<void> => {
      this.loadedUrl = url
      this.history.push(url)
      this.historyIndex = this.history.length - 1
    },
    getTitle: (): string => this.title,
    getURL: (): string => this.loadedUrl,
    isLoading: (): boolean => this.loading,
    canGoBack: (): boolean => this.historyIndex > 0,
    canGoForward: (): boolean => this.historyIndex < this.history.length - 1,
    goBack: (): void => {
      this.historyIndex -= 1
      this.loadedUrl = this.history[this.historyIndex] ?? this.loadedUrl
    },
    goForward: (): void => {
      this.historyIndex += 1
      this.loadedUrl = this.history[this.historyIndex] ?? this.loadedUrl
    },
    reload: (): void => {
      this.reloads += 1
    },
    send: (channel: string, payload: unknown): void => {
      this.sent.push([channel, payload])
    },
    isDestroyed: (): boolean => this.destroyed,
    close: (): void => {
      this.destroyed = true
    },
    setWindowOpenHandler: (): void => undefined,
    mainFrame: this.mainFrame,
    // The plugin attaches a CDP debugger to every view; the pane tests do not
    // exercise CDP, so accepting the attach is enough.
    debugger: {
      attach: (): void => undefined,
      on: (): void => undefined
    }
  }

  setBounds(bounds: FakeBounds): void {
    this.bounds = bounds
  }
}

const spawned: FakeView[] = []

vi.mock('electron', () => ({
  WebContentsView: class extends FakeView {
    constructor(options?: { webPreferences?: Record<string, unknown> }) {
      super(options)
      spawned.push(this)
    }
  },
  // The real screen is unavailable in tests; the work area is injected instead.
  screen: { getDisplayMatching: () => undefined }
}))

// Imported after the mock is installed so `WebContentsView` is the fake above.
const { AgentBrowser } = await import('../src/main/agent-browser/agent-browser')

type Browser = InstanceType<typeof AgentBrowser>

const CHROME_RESOURCES = {
  htmlPath: `D:/fake/${CHROME_MARKER}`,
  preloadPath: 'D:/fake/agent-browser-pane.cjs'
}

class FakeWindow {
  readonly children: FakeView[] = []
  readonly listeners = new Map<string, Array<() => void>>()
  x = 0
  y = 0
  width = 1600
  height = 900
  destroyed = false
  maximized = false
  fullscreen = false

  readonly contentView = {
    children: this.children as unknown[],
    getBounds: (): FakeBounds => ({ x: 0, y: 0, width: this.width, height: this.height }),
    addChildView: (view: FakeView): void => {
      this.children.push(view)
    },
    removeChildView: (view: FakeView): void => {
      const index = this.children.indexOf(view)
      if (index >= 0) this.children.splice(index, 1)
    }
  }

  on(event: string, handler: () => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(handler)
    this.listeners.set(event, list)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isMaximized(): boolean {
    return this.maximized
  }

  isFullScreen(): boolean {
    return this.fullscreen
  }

  getBounds(): FakeBounds {
    return { x: this.x, y: this.y, width: this.width, height: this.height }
  }

  getContentBounds(): FakeBounds {
    return this.getBounds()
  }

  setContentBounds(bounds: Partial<FakeBounds>): void {
    this.x = bounds.x ?? this.x
    this.y = bounds.y ?? this.y
    this.width = bounds.width ?? this.width
    this.height = bounds.height ?? this.height
  }

  setBounds(bounds: Partial<FakeBounds>): void {
    this.setContentBounds(bounds)
  }

  setContentSize(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  hide(): void {}
  showInactive(): void {}

  emitResize(): void {
    for (const handler of this.listeners.get('resize') ?? []) handler()
  }

  /** What closing the window really does: the window and its child views die. */
  close(): void {
    this.destroyed = true
    for (const view of this.children) view.destroyed = true
  }

  /** Stacking order is an implementation detail; find views by what they are. */
  chromeView(): FakeView {
    const found = this.children.find((child) => child.isChrome)
    if (found === undefined) throw new Error('the pane chrome is not attached')
    return found
  }

  pageViews(): FakeView[] {
    return this.children.filter((child) => !child.isChrome)
  }

  activePage(): FakeView {
    const pages = this.pageViews()
    if (pages.length !== 1) throw new Error(`expected one attached page, got ${pages.length}`)
    return pages[0] as FakeView
  }
}

const CHROME_SENDER = 'D:/fake/agent-browser-pane.cjs'

const windowGetter = (getWindow: () => FakeWindow | undefined): never =>
  getWindow as unknown as never

/** A 1920-wide display: a 1600 window at x=0 has no room to grow. */
const hd = (): Rect => ({ x: 0, y: 0, width: 1920, height: 1080 })
const wide = (): Rect => ({ x: 0, y: 0, width: 2560, height: 1440 })

type Rect = { x: number; y: number; width: number; height: number }

const build = (
  getWindow: () => FakeWindow | undefined,
  options: Record<string, unknown> = {},
  workArea: Rect = hd()
): Browser =>
  new AgentBrowser(windowGetter(getWindow), {
    getWorkArea: () => workArea,
    getChromeResources: () => CHROME_RESOURCES,
    ...options
  })

/** The strip page loads in the background; let those microtasks settle. */
const settled = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

/** The startup order the desktop really uses: attach, then open the pane. */
const docked = async (browser: Browser): Promise<void> => {
  await browser.attachToWindow()
  expect(browser.setVisible(true)).toBe(true)
  await settled()
}

describe('Agent browser pane docking', () => {
  it('creates a top-level browser window once and leaves its placement to the user', async () => {
    spawned.length = 0
    const main = new FakeWindow()
    main.x = 100
    let pane: FakeWindow | undefined
    let options: Record<string, unknown> | undefined
    const browser = build(() => main, {
      createPaneWindow: (input: Record<string, unknown>) => {
        options = input
        pane = new FakeWindow()
        pane.setBounds(input as Partial<FakeBounds>)
        return pane as never
      }
    })

    await docked(browser)
    expect(options?.parent).toBeUndefined()
    expect(options?.frame).toBe(true)
    expect(options?.skipTaskbar).toBe(false)
    expect(pane?.x).toBe(main.x + main.width)
    expect(main.width).toBe(1020)

    const initial = pane?.getBounds()
    pane!.setContentSize(1000, pane!.height)
    pane!.emitResize()
    expect(browser.currentPaneWidth).toBe(1000)

    browser.setVisible(false)
    expect(main.width).toBe(1600)

    browser.setVisible(true)
    main.x = 400
    main.width = 1200
    main.emitResize()
    expect(pane?.getBounds()).toMatchObject({ x: initial?.x, width: 1000 })
    browser.setVisible(false)
    expect(main.width).toBe(1200)
  })

  it('reports failure instead of silently doing nothing when there is no window', async () => {
    const browser = new AgentBrowser(windowGetter(() => undefined)) as Browser

    await browser.attachToWindow()
    expect(browser.toggle()).toBe(false)
    expect(browser.isVisible).toBe(false)
  })

  it('docks the strip above the page so nothing covers the address bar', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window)
    await docked(browser)

    expect(window.chromeView().bounds).toMatchObject({ x: 800, y: 0, width: 800, height: PANE_CHROME_HEIGHT })
    expect(window.activePage().bounds).toMatchObject({
      x: 800,
      y: PANE_CHROME_HEIGHT,
      width: 800,
      height: 900 - PANE_CHROME_HEIGHT
    })

    expect(browser.toggle()).toBe(false)
    expect(window.children).toHaveLength(0)
  })

  it('creates the strip page sandboxed with its own preload', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window)
    await docked(browser)

    const chrome = window.chromeView()
    expect(chrome.webPreferences).toMatchObject({
      preload: CHROME_SENDER,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
    expect(chrome.loadedUrl).toContain(CHROME_MARKER)
  })

  it('widens the window when the display has room, and undoes it when hiding', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window, {}, wide())
    await docked(browser)

    // The chat keeps its 1600 DIPs; the extra 800 is what the pane now covers.
    expect(window.width).toBe(2400)
    expect(browser.currentPaneWidth).toBe(800)
    expect(window.activePage().bounds).toMatchObject({ x: 1600, width: 800 })

    browser.setVisible(false)
    expect(window.width).toBe(1600)
    expect(window.children).toHaveLength(0)
  })

  it('does not shove the window back when the user resized it meanwhile', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window, {}, wide())
    await docked(browser)

    window.setContentBounds({ width: 2000 })
    window.emitResize()
    browser.setVisible(false)

    expect(window.width).toBe(2000)
  })

  it('refuses to dock into a window too narrow to hold both halves', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    window.width = 900
    const browser = build(() => window, {}, { x: 0, y: 0, width: 900, height: 1080 })
    await browser.attachToWindow()

    expect(browser.setVisible(true)).toBe(false)
    expect(browser.isVisible).toBe(false)
    expect(window.children).toHaveLength(0)
  })

  it('keeps the pane width in DIPs when the window is resized', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window)
    await docked(browser)

    // A docked pane keeps its width in DIPs: the app absorbs the extra window width.
    window.width = 1800
    window.emitResize()
    expect(window.activePage().bounds).toMatchObject({ x: 1000, width: 800 })

    // Shrinking past the cap stops at the app's minimum instead of covering the chat.
    window.width = 1400
    window.emitResize()
    expect(window.activePage().bounds).toMatchObject({ x: 640, width: 1400 - 640 })
  })

  it('hides the pane when the window shrinks under what both halves need', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window)
    await docked(browser)

    window.width = 900
    window.emitResize()

    expect(browser.isVisible).toBe(false)
    expect(window.children).toHaveLength(0)
  })

  it('re-docks into the window created after a close-to-tray reopen', async () => {
    spawned.length = 0
    const first = new FakeWindow()
    let current: FakeWindow | undefined = first
    const browser = build(() => current)
    await docked(browser)
    expect(first.children.length).toBeGreaterThanOrEqual(2)

    first.close()
    current = new FakeWindow()
    await browser.attachToWindow()

    // The user had the pane open, so the reopened window shows it again with a
    // fresh target replacing the view that died together with the old window.
    expect(browser.isVisible).toBe(true)
    expect(current.pageViews()).toHaveLength(1)

    expect(browser.toggle()).toBe(false)
    expect(current.children).toHaveLength(0)
    expect(browser.toggle()).toBe(true)
    expect(current.children.length).toBeGreaterThanOrEqual(2)
  })

  it('announces visibility changes once, including ones the page did not ask for', async () => {
    const window = new FakeWindow()
    const onVisibilityChange = vi.fn()
    const browser = build(() => window, { onVisibilityChange })
    await browser.attachToWindow()

    browser.setVisible(true)
    browser.setVisible(true)
    browser.setVisible(false)

    expect(onVisibilityChange.mock.calls.flat()).toEqual([true, false])
  })
})

describe('Agent browser tab strip', () => {
  it('opens, switches and closes tabs, and keeps exactly one page attached', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window)
    await docked(browser)

    const opened = await browser.applyPaneAction({ type: 'new-tab', url: 'example.com/docs' })
    expect(opened?.tabs).toHaveLength(2)
    expect(opened?.tabs[1]).toMatchObject({ active: true, url: 'https://example.com/docs' })
    expect(window.activePage().loadedUrl).toContain('example.com/docs')

    const first = (opened?.tabs ?? [])[0]?.id as string
    const switched = await browser.applyPaneAction({ type: 'activate-tab', tabId: first })
    expect((switched?.tabs ?? []).map((tab: AgentBrowserTab) => tab.active)).toEqual([true, false])
    // Only the active page is attached; the strip stays, so the tab bar never vanishes.
    expect(window.pageViews()).toHaveLength(1)
    expect(window.activePage().loadedUrl).toBe('about:blank')
    expect(window.children).toContain(window.chromeView())

    const closed = await browser.applyPaneAction({ type: 'close-tab', tabId: first })
    expect(closed?.tabs).toHaveLength(1)

    const hidden = await browser.applyPaneAction({ type: 'hide' })
    expect(hidden?.visible).toBe(false)
    expect(window.children).toHaveLength(0)
  })

  it('opens a blank tab from the menu with the pane closed', async () => {
    // The menu sends url '' exactly like the "+" button, so both share the blank-tab
    // meaning; and a new tab has to open the pane instead of reporting a hidden one.
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window)
    await docked(browser)
    await browser.applyPaneAction({ type: 'hide' })

    const state = await browser.applyPaneAction({ type: 'new-tab', url: '' })

    expect(state?.visible).toBe(true)
    expect(state?.tabs).toHaveLength(2)
    expect(state?.tabs.at(-1)).toMatchObject({ active: true, url: 'about:blank' })
    expect(window.activePage().loadedUrl).toBe('about:blank')
    expect(window.children).toContain(window.chromeView())
  })

  it('pushes the tab list to the strip when the model opens a page itself', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window)
    await docked(browser)
    const chrome = window.chromeView()
    chrome.sent.length = 0

    const target = await browser.createTarget('https://example.com/bought')
    await settled()

    const last = chrome.sent[chrome.sent.length - 1] as [string, AgentBrowserPaneState]
    expect(last[0]).toBe('dsh-desktop:agent-browser-pane-state-changed')
    expect(last[1].tabs.map((tab: AgentBrowserTab) => tab.url)).toContain('https://example.com/bought')
    // A model-driven tab must not be an invisible tab.
    expect(last[1].visible).toBe(true)
    expect(browser.listTargets().map((listed) => listed.id)).toContain(target.id)
  })

  it('reuses the startup placeholder for the first model-created target', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window)
    await browser.start()
    try {
      const first = await browser.createTarget('https://example.com/first')
      expect(browser.listTargets()).toHaveLength(1)
      expect(first.url).toBe('https://example.com/first')

      await browser.createTarget('https://example.com/second')
      expect(browser.listTargets()).toHaveLength(2)
    } finally {
      await browser.stop()
    }
  })

  it('navigates the active tab from typed text and keeps the window width', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window)
    await docked(browser)
    const page = window.activePage()
    const widthBefore = window.width

    const state = await browser.applyPaneAction({ type: 'navigate', url: '  https://example.org/a?b=1 ' })

    expect(page.loadedUrl).toBe('https://example.org/a?b=1')
    expect(state?.tabs[0]).toMatchObject({ url: 'https://example.org/a?b=1' })
    expect(window.width).toBe(widthBefore)
  })

  it('refuses addresses that are not web pages instead of loading them', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window)
    await docked(browser)
    const page = window.activePage()

    const file = await browser.applyPaneAction({ type: 'navigate', url: 'file:///C:/Windows/system32/cmd.exe' })
    expect(page.loadedUrl).toBe('about:blank')
    expect(file?.notice).not.toBe('')

    const script = await browser.applyPaneAction({ type: 'navigate', url: 'javascript:alert(1)' })
    expect(page.loadedUrl).toBe('about:blank')
    expect(script?.notice).not.toBe('')

    const blank = await browser.applyPaneAction({ type: 'navigate', url: '   ' })
    expect(blank?.notice).not.toBe('')
  })

  it('drives back, forward and reload on the active tab', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window)
    await docked(browser)
    const page = window.activePage()
    page.history = ['about:blank', 'https://example.com/one', 'https://example.com/two']
    page.historyIndex = 2
    page.loadedUrl = 'https://example.com/two'

    const back = await browser.applyPaneAction({ type: 'go-back' })
    expect(page.loadedUrl).toBe('https://example.com/one')
    expect(back?.tabs[0]).toMatchObject({ canGoForward: true })

    await browser.applyPaneAction({ type: 'go-forward' })
    expect(page.loadedUrl).toBe('https://example.com/two')

    await browser.applyPaneAction({ type: 'reload' })
    expect(page.reloads).toBe(1)
  })

  it('moves the split when the strip reports a dragged width', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window, {}, wide())
    await docked(browser)

    const state = await browser.applyPaneAction({ type: 'set-pane-width', width: 600 })
    expect(state?.paneWidth).toBe(600)
    expect(window.activePage().bounds).toMatchObject({ x: 1600, width: 600 })
    expect(window.width).toBe(2200)

    const resized = await browser.applyPaneAction({ type: 'set-pane-width', width: 700 })
    expect(resized?.paneWidth).toBe(700)
    expect(window.width).toBe(2300)
  })

  it('rejects gestures that are not declared actions', async () => {
    const window = new FakeWindow()
    const browser = build(() => window)

    await expect(browser.applyPaneAction({ type: 'read-file', path: 'C:/secrets' })).rejects.toThrow(/unsupported pane action/)
    await expect(browser.applyPaneAction('open-devtools')).rejects.toThrow(/unsupported pane action/)
  })
})

describe('Agent browser pane trust', () => {
  it('trusts only the strip it created, never a driven page', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window)
    await docked(browser)

    const chrome = window.chromeView()
    const page = window.activePage()
    expect(browser.isChromeSender(chrome.webContents as never)).toBe(true)
    expect(browser.isChromeSender(page.webContents as never)).toBe(false)
    expect(browser.isChromeSender(null)).toBe(false)

    chrome.destroyed = true
    expect(browser.isChromeSender(chrome.webContents as never)).toBe(false)
  })

  it('answers the strip with the state it needs before any gesture', async () => {
    spawned.length = 0
    const window = new FakeWindow()
    const browser = build(() => window, {
      getPresentation: () => ({ lang: 'zh', theme: 'dark' })
    })
    await docked(browser)

    expect(browser.paneState()).toMatchObject({
      visible: true,
      lang: 'zh',
      theme: 'dark',
      chromeHeight: PANE_CHROME_HEIGHT,
      paneWidth: 800
    })
    expect(browser.paneState().tabs[0]).toMatchObject({ active: true })
  })
})
