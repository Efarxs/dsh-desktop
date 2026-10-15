/**
 * The narrow seam between the page and the native agent-browser pane.
 *
 * The pane is a `WebContentsView` owned by the main process; the control the user
 * actually reaches is a slot occupant in the page. It gets its own module for two
 * reasons: the status channel also carries changes the page did not ask for (the
 * CDP relay opens the pane by itself when the model starts driving), and the
 * unsubscribe function is the only cleanup path the occupant's effect has.
 */
import { type AgentBrowserStatus } from '../shared/agent-browser'

/**
 * Runtime guard for status payloads; TypeScript types cannot validate a wire value.
 *
 * It lives here rather than in `src/shared/agent-browser.ts` on purpose: a sandboxed
 * preload can only require its own bundle, and a runtime import of the shared module
 * from both preload entries makes the bundler split it into `./chunks/…`, which then
 * fails to load at runtime and takes the desktop bridge down with it. The page that
 * consumes the status is also the right owner of the check.
 */
function isAgentBrowserStatus(value: unknown): value is AgentBrowserStatus {
  if (typeof value !== 'object' || value === null) return false
  const status = value as Record<string, unknown>
  return typeof status.available === 'boolean' && typeof status.visible === 'boolean'
}

export const AGENT_BROWSER_STATUS_CHANNEL = 'dsh-desktop:agent-browser-status'
export const AGENT_BROWSER_TOGGLE_CHANNEL = 'dsh-desktop:agent-browser-toggle'

type StatusListener = (event: unknown, ...args: unknown[]) => void

export interface AgentBrowserBridgeIpc {
  invoke(channel: string): Promise<unknown>
  on(channel: string, listener: StatusListener): void
  removeListener(channel: string, listener: StatusListener): void
}

export interface AgentBrowserBridge {
  /** Current state. `available: false` means this run has no pane to open. */
  getStatus(): Promise<AgentBrowserStatus>
  /** Ask the main process to show or hide the pane and return the resulting state. */
  toggle(): Promise<AgentBrowserStatus>
  /** Subscribe to visibility the page did not ask for. Returns the unsubscribe. */
  onStatus(listener: (status: AgentBrowserStatus) => void): () => void
}

/**
 * Build the bridge over the two channels.
 *
 * Invoke results come from our own handlers and carry the declared shape; pushed
 * payloads are validated because they arrive without a request to correlate them
 * against, and a half-shaped status would drive the button's pressed state.
 *
 * @param ipc - the Electron renderer surface, taken as a seam so the validation
 *   and the unsubscribe path are unit-testable without Electron.
 */
export function createAgentBrowserBridge(ipc: AgentBrowserBridgeIpc): AgentBrowserBridge {
  return Object.freeze({
    getStatus: async () => (await ipc.invoke(AGENT_BROWSER_STATUS_CHANNEL)) as AgentBrowserStatus,
    toggle: async () => (await ipc.invoke(AGENT_BROWSER_TOGGLE_CHANNEL)) as AgentBrowserStatus,
    onStatus: (listener: (status: AgentBrowserStatus) => void): (() => void) => {
      const receive = (_event: unknown, status: unknown): void => {
        if (isAgentBrowserStatus(status)) listener(status)
      }
      ipc.on(AGENT_BROWSER_STATUS_CHANNEL, receive)
      return () => ipc.removeListener(AGENT_BROWSER_STATUS_CHANNEL, receive)
    }
  })
}
