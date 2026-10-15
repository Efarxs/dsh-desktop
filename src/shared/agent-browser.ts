/**
 * Cross-process contract for the embedded agent browser pane.
 *
 * The pane is native: the page and the tab strip are `WebContentsView` children
 * owned by the main process, while the entry point the user clicks lives inside the
 * Harness page (a host client slot). Every wire value therefore crosses a process
 * boundary, and both sides read this one shape instead of inventing compatible
 * literals. The page treats anything arriving over IPC as untrusted until validated.
 */

/**
 * IPC channel names, in one place: the pane chrome page, its preload and the main
 * process handlers must agree, and neither side may import the other's implementation.
 */
export const PANE_STATE_INVOKE_CHANNEL = 'dsh-desktop:agent-browser-pane-state'
export const PANE_ACTION_INVOKE_CHANNEL = 'dsh-desktop:agent-browser-pane-action'
export const PANE_STATE_PUSH_CHANNEL = 'dsh-desktop:agent-browser-pane-state-changed'

export interface AgentBrowserStatus {
  /**
   * False when this run has no pane to show: the desktop failed to start the
   * embedded browser, so `dsh-browser-use` fell back to launching its own window.
   * The entry point disappears rather than turning into a dead button.
   */
  available: boolean
  /** Whether the right-hand pane is currently docked into the window. */
  visible: boolean
}


/** One embedded tab: the same webContents the model drives over CDP. */
export interface AgentBrowserTab {
  id: string
  /** Page title, or the host while the page has none. Untrusted: never HTML. */
  title: string
  url: string
  active: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** Everything the pane chrome needs to draw itself, pushed from the main process. */
export interface AgentBrowserPaneState {
  visible: boolean
  tabs: AgentBrowserTab[]
  /** Pane width inside the window content area, in DIPs. */
  paneWidth: number
  /** Height of the chrome strip above the page, in DIPs. */
  chromeHeight: number
  /** Harness locale, so the strip shares the app language instead of guessing. */
  lang: 'en' | 'zh'
  theme: 'light' | 'dark'
  /**
   * One-shot message for the address field (rejected URL, pane busy). Empty means
   * nothing to report; the main process clears it on the next pushed action.
   */
  notice: string
}

/**
 * A user gesture inside the pane chrome. Deliberately a closed union: the strip is
 * a separate webContents, so anything it must be able to ask for is named here.
 */
export type AgentBrowserPaneAction =
  | { type: 'activate-tab'; tabId: string }
  | { type: 'close-tab'; tabId: string }
  | { type: 'new-tab'; url: string }
  | { type: 'navigate'; url: string }
  | { type: 'reload' }
  | { type: 'go-back' }
  | { type: 'go-forward' }
  | { type: 'set-pane-width'; width: number }
  | { type: 'hide' }

const PANE_ACTION_TYPES = [
  'activate-tab',
  'close-tab',
  'new-tab',
  'navigate',
  'reload',
  'go-back',
  'go-forward',
  'set-pane-width',
  'hide'
] as const

const PANE_ACTION_TYPES_WITH_TAB_ID = new Set(['activate-tab', 'close-tab'])
const PANE_ACTION_TYPES_WITH_URL = new Set(['new-tab', 'navigate'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Finite and non-negative: a NaN or negative width from IPC must not reach layout. */
function isDistance(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isAgentBrowserPaneState(value: unknown): value is AgentBrowserPaneState {
  if (!isRecord(value)) return false
  if (typeof value.visible !== 'boolean') return false
  if (!Array.isArray(value.tabs)) return false
  if (!isDistance(value.paneWidth) || !isDistance(value.chromeHeight)) return false
  if (value.lang !== 'en' && value.lang !== 'zh') return false
  if (value.theme !== 'light' && value.theme !== 'dark') return false
  if (typeof value.notice !== 'string') return false
  return value.tabs.every((tab) => {
    if (!isRecord(tab)) return false
    return (
      isNonEmptyString(tab.id) &&
      typeof tab.title === 'string' &&
      typeof tab.url === 'string' &&
      typeof tab.active === 'boolean' &&
      typeof tab.loading === 'boolean' &&
      typeof tab.canGoBack === 'boolean' &&
      typeof tab.canGoForward === 'boolean'
    )
  })
}

export function isAgentBrowserPaneAction(value: unknown): value is AgentBrowserPaneAction {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (!PANE_ACTION_TYPES.includes(value.type as (typeof PANE_ACTION_TYPES)[number])) return false
  if (PANE_ACTION_TYPES_WITH_TAB_ID.has(value.type)) return isNonEmptyString(value.tabId)
  if (PANE_ACTION_TYPES_WITH_URL.has(value.type)) return typeof value.url === 'string'
  if (value.type === 'set-pane-width') return isDistance(value.width)
  return true
}

/**
 * Where the address bar may send the pane. A docked browser is pointed at arbitrary
 * text, so only web schemes survive: `file:`, `javascript:`, `data:` and custom
 * schemes would turn the address bar into a local-file or host-scheme opener.
 */
const PANE_NAVIGATION_PROTOCOLS = new Set(['http:', 'https:'])
/** Typed "example.com" or "localhost:3000" is a URL without the scheme. */
const BARE_HOST = /^[a-zA-Z\d]([a-zA-Z\d-]*[a-zA-Z\d])?(\.[a-zA-Z\d]([a-zA-Z\d-]*[a-zA-Z\d])?)*(:\d{1,5})?(\/[^\s]*)?$/
const BLANK_PAGE = 'about:blank'
/**
 * Loopback hosts get plain http: someone typing `localhost:3000` means the dev server,
 * and https-first only produces a certificate error. Everything else upgrades, because
 * a missing scheme is far more often an oversight than a request for cleartext.
 */
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\]|[^./\s]+\.local|[^./\s]+\.internal)$/i

export type PaneNavigation =
  | { ok: true; url: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'scheme' }

/** The part after `://`, or the whole text when there is no scheme. */
function withoutScheme(text: string): string {
  const index = text.indexOf('://')
  return index === -1 ? text : text.slice(index + 3)
}

/**
 * The scheme written in front of an address, or null for host-and-port text.
 *
 * `localhost:3000/api` is syntactically a scheme plus a number, so a bare port is what
 * separates "type a site" from "open another application through a registered scheme".
 */
function detectScheme(text: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z\d+\-.]*):([\s\S]*)$/.exec(text)
  if (!match) return null
  const rest = match[2] ?? ''
  if (/^\d{1,5}([/?#]|$)/.test(rest)) return null
  return (match[1] ?? '').toLowerCase()
}

/** Which scheme unprefixed address-bar text should get. */
function schemeForBareHost(text: string): 'http' | 'https' {
  const authority = withoutScheme(text).split('/')[0] ?? ''
  const host = authority.replace(/:\d{1,5}$/, '')
  return LOOPBACK_HOST.test(host) ? 'http' : 'https'
}

/**
 * Turn address-bar text into a loadable URL, or explain why it cannot be loaded.
 *
 * Unprefixed input is treated as a web address (that is what users type), but a
 * string carrying a non-web scheme is refused rather than silently rewritten: the
 * pane drives a real browser, so `file:` or a registered app scheme is a host
 * capability, not a page.
 */
export function resolvePaneNavigationUrl(input: unknown): PaneNavigation {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' }
  const text = input.trim()
  if (text === '') return { ok: false, reason: 'empty' }
  if (text.toLowerCase() === BLANK_PAGE) return { ok: true, url: BLANK_PAGE }
  const scheme = detectScheme(text)
  if (scheme !== null && scheme !== 'http' && scheme !== 'https') return { ok: false, reason: 'scheme' }
  const candidate = scheme === null ? `${schemeForBareHost(text)}://${text}` : text
  if (!BARE_HOST.test(withoutScheme(candidate))) return { ok: false, reason: 'invalid' }
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (!PANE_NAVIGATION_PROTOCOLS.has(parsed.protocol)) return { ok: false, reason: 'scheme' }
  // `http://user:pass@host` is a credential prompt disguised as a link.
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'invalid' }
  return { ok: true, url: parsed.href }
}

/** Address-bar wording lives with the contract so main and the strip never diverge. */
export function paneNavigationNotice(reason: 'empty' | 'invalid' | 'scheme', lang: AgentBrowserPaneState['lang']): string {
  const messages = {
    en: {
      empty: 'Type an address to open.',
      invalid: 'That address is not valid.',
      scheme: 'Only http and https addresses can be opened here.'
    },
    zh: {
      empty: '请输入要打开的网址。',
      invalid: '网址格式不正确。',
      scheme: '这里只能打开 http/https 网址。'
    }
  } as const
  return messages[lang][reason]
}