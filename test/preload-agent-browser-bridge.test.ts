/**
 * The agent-browser bridge is the only thing between a page button and a native
 * view, so the two behaviours worth pinning are: which channel each call uses, and
 * that a malformed push cannot drive the button's pressed state (the pane also
 * opens by itself when the model connects, so these payloads arrive unasked).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_BROWSER_STATUS_CHANNEL,
  AGENT_BROWSER_TOGGLE_CHANNEL,
  createAgentBrowserBridge
} from '../src/preload/agent-browser-bridge'
import type { AgentBrowserStatus } from '../src/shared/agent-browser'

type Listener = (event: unknown, ...args: unknown[]) => void

function fakeIpc(responses: Record<string, unknown> = {}) {
  const registered = new Map<string, Listener[]>()
  const invoke = vi.fn(async (channel: string) => responses[channel])
  const on = vi.fn((channel: string, listener: Listener) => {
    registered.set(channel, [...(registered.get(channel) ?? []), listener])
  })
  const removeListener = vi.fn((channel: string, listener: Listener) => {
    registered.set(channel, (registered.get(channel) ?? []).filter(item => item !== listener))
  })
  const push = (channel: string, status: unknown): void => {
    for (const listener of registered.get(channel) ?? []) listener({}, status)
  }
  return { bridge: createAgentBrowserBridge({ invoke, on, removeListener }), invoke, push, registered }
}

const hidden: AgentBrowserStatus = { available: true, visible: false }

describe('agent browser preload bridge', () => {
  it('reads and toggles through the channels the main process answers on', async () => {
    const { bridge, invoke } = fakeIpc({
      [AGENT_BROWSER_STATUS_CHANNEL]: hidden,
      [AGENT_BROWSER_TOGGLE_CHANNEL]: { available: true, visible: true }
    })

    await expect(bridge.getStatus()).resolves.toEqual(hidden)
    await expect(bridge.toggle()).resolves.toEqual({ available: true, visible: true })
    expect(invoke.mock.calls.flat()).toEqual([AGENT_BROWSER_STATUS_CHANNEL, AGENT_BROWSER_TOGGLE_CHANNEL])
  })

  it('keeps only well-formed pushed statuses', () => {
    const { bridge, push } = fakeIpc()
    const listener = vi.fn()
    bridge.onStatus(listener)

    push(AGENT_BROWSER_STATUS_CHANNEL, { available: true, visible: true })
    push(AGENT_BROWSER_STATUS_CHANNEL, { available: 'yes', visible: true })
    push(AGENT_BROWSER_STATUS_CHANNEL, undefined)
    push('other:channel', hidden)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ available: true, visible: true })
  })

  it('unregisters the very listener it registered', () => {
    const { bridge, push, registered } = fakeIpc()
    const listener = vi.fn()
    const unsubscribe = bridge.onStatus(listener)

    unsubscribe()

    const [channel, handlers] = [...registered.entries()][0] ?? []
    expect(channel).toBe(AGENT_BROWSER_STATUS_CHANNEL)
    expect(handlers).toHaveLength(0)
    push(AGENT_BROWSER_STATUS_CHANNEL, hidden)
    expect(listener).not.toHaveBeenCalled()
  })

  it('exposes exactly the three named capabilities and nothing generic', () => {
    const { bridge } = fakeIpc()

    expect(Object.keys(bridge)).toEqual(['getStatus', 'toggle', 'onStatus'])
    expect(Object.isFrozen(bridge)).toBe(true)
  })
})
