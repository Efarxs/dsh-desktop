/**
 * The pane chrome page is a second webContents with privileged gestures: it can
 * navigate the browser the model is driving. So the two behaviours worth pinning are
 * which channel each call uses, and that malformed payloads never reach the page —
 * neither a response nor an unasked-for push from the relay opening a tab.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PANE_ACTION_INVOKE_CHANNEL,
  PANE_STATE_INVOKE_CHANNEL,
  PANE_STATE_PUSH_CHANNEL,
  type AgentBrowserPaneState
} from '../src/shared/agent-browser'
import { createAgentBrowserPaneBridge } from '../src/preload/agent-browser-pane-bridge'

type Listener = (event: unknown, ...args: unknown[]) => void

const state = (over: Partial<AgentBrowserPaneState> = {}): AgentBrowserPaneState => ({
  visible: true,
  tabs: [
    {
      id: 'tab-1',
      title: 'Example',
      url: 'https://example.com/',
      active: true,
      loading: false,
      canGoBack: false,
      canGoForward: false
    }
  ],
  paneWidth: 800,
  chromeHeight: 72,
  lang: 'en',
  theme: 'light',
  notice: '',
  ...over
})

function fakeIpc(responses: Record<string, unknown> = {}) {
  const registered = new Map<string, Listener[]>()
  const invoke = vi.fn(async (channel: string) => responses[channel])
  const on = vi.fn((channel: string, listener: Listener) => {
    registered.set(channel, [...(registered.get(channel) ?? []), listener])
  })
  const removeListener = vi.fn((channel: string, listener: Listener) => {
    registered.set(channel, (registered.get(channel) ?? []).filter((item) => item !== listener))
  })
  const push = (payload: unknown): void => {
    for (const listener of registered.get(PANE_STATE_PUSH_CHANNEL) ?? []) listener({}, payload)
  }
  return { bridge: createAgentBrowserPaneBridge({ invoke, on, removeListener }), invoke, push }
}

describe('agent browser pane bridge', () => {
  it('reads the pane state from its own channel', async () => {
    const { bridge, invoke } = fakeIpc({ [PANE_STATE_INVOKE_CHANNEL]: state() })

    await expect(bridge.getState()).resolves.toMatchObject({ paneWidth: 800 })
    expect(invoke).toHaveBeenCalledWith(PANE_STATE_INVOKE_CHANNEL)
  })

  it('reports a gesture on the action channel and returns the resulting state', async () => {
    const next = state({ paneWidth: 620 })
    const { bridge, invoke } = fakeIpc({ [PANE_ACTION_INVOKE_CHANNEL]: next })

    await expect(bridge.applyAction({ type: 'set-pane-width', width: 620 })).resolves.toMatchObject({
      paneWidth: 620
    })
    expect(invoke).toHaveBeenCalledWith(PANE_ACTION_INVOKE_CHANNEL, { type: 'set-pane-width', width: 620 })
  })

  it('rejects a payload that is not a pane state instead of drawing it', async () => {
    const { bridge } = fakeIpc({ [PANE_STATE_INVOKE_CHANNEL]: { visible: true, tabs: 'all of them' } })

    await expect(bridge.getState()).rejects.toThrow(/pane state/)
  })

  it('drops malformed pushes and stops listening on unsubscribe', () => {
    const received: AgentBrowserPaneState[] = []
    const { bridge, push } = fakeIpc()
    const unsubscribe = bridge.onState((value) => received.push(value))

    push(state({ paneWidth: 700 }))
    push({ visible: 'yes' })
    push(null)
    unsubscribe()
    push(state({ paneWidth: 500 }))

    expect(received.map((value) => value.paneWidth)).toEqual([700])
  })
})