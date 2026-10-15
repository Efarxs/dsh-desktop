/**
 * The narrow seam between the pane chrome page and the main process.
 *
 * Taken as a seam so the validation and the unsubscribe path are unit-testable
 * without Electron; `agent-browser-pane.ts` wires it to the real renderer surface.
 */
import {
  PANE_ACTION_INVOKE_CHANNEL,
  PANE_STATE_INVOKE_CHANNEL,
  PANE_STATE_PUSH_CHANNEL,
  isAgentBrowserPaneState,
  type AgentBrowserPaneAction,
  type AgentBrowserPaneState
} from '../shared/agent-browser'

type StatePushListener = (event: unknown, ...args: unknown[]) => void

export interface AgentBrowserPaneBridgeIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: StatePushListener): void
  removeListener(channel: string, listener: StatePushListener): void
}

export interface AgentBrowserPaneBridge {
  /** Current strip state. Rejects when the payload is malformed. */
  getState(): Promise<AgentBrowserPaneState>
  /** Report a gesture and get the state that resulted from it. */
  applyAction(action: AgentBrowserPaneAction): Promise<AgentBrowserPaneState>
  /** Subscribe to state the strip did not ask for (the model opened a tab, etc.). */
  onState(listener: (state: AgentBrowserPaneState) => void): () => void
}

const readState = async (value: unknown): Promise<AgentBrowserPaneState> => {
  if (!isAgentBrowserPaneState(value)) throw new Error('Unexpected agent browser pane state')
  return value
}

export function createAgentBrowserPaneBridge(ipc: AgentBrowserPaneBridgeIpc): AgentBrowserPaneBridge {
  return Object.freeze({
    getState: async () => readState(await ipc.invoke(PANE_STATE_INVOKE_CHANNEL)),
    applyAction: async (action: AgentBrowserPaneAction) =>
      readState(await ipc.invoke(PANE_ACTION_INVOKE_CHANNEL, action)),
    onState: (listener: (state: AgentBrowserPaneState) => void): (() => void) => {
      const receive = (_event: unknown, state: unknown): void => {
        if (isAgentBrowserPaneState(state)) listener(state)
      }
      ipc.on(PANE_STATE_PUSH_CHANNEL, receive)
      return () => ipc.removeListener(PANE_STATE_PUSH_CHANNEL, receive)
    }
  })
}