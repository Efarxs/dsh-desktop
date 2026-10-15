/**
 * CDP relay protocol test with a mock TargetHost.
 * Replays the exact call sequence the dsh-browser-use plugin makes
 * (see plugin src/cdp/client.ts): /json/version -> browser WS ->
 * Target.setDiscoverTargets -> Target.createTarget -> /json/list ->
 * page WS -> command/response + event broadcast -> /json/close.
 */
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { CdpRelay, type RelayDebugger, type RelayTarget, type RelayTargetHost } from '../src/main/agent-browser/cdp-relay'

class MockDebugger implements RelayDebugger {
  readonly commands: Array<{ method: string; params: Record<string, unknown> }> = []
  private handlers = new Set<(method: string, params: Record<string, unknown>) => void>()

  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.commands.push({ method, params })
    if (method === 'Page.navigate') return {}
    if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'mock' } }
    return {}
  }

  onMessage(handler: (method: string, params: Record<string, unknown>) => void): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const h of this.handlers) h(method, params)
  }
}

class MockHost implements RelayTargetHost {
  readonly targets = new Map<string, { target: RelayTarget; debugger: MockDebugger }>()
  readonly activated: string[] = []
  private changed = new Set<() => void>()
  private seq = 0

  constructor() {
    this.addTarget('about:blank')
  }

  private addTarget(url: string): RelayTarget {
    const id = `target-${++this.seq}`
    const dbg = new MockDebugger()
    const target: RelayTarget = { id, title: `title-${id}`, url, debugger: dbg }
    this.targets.set(id, { target, debugger: dbg })
    return target
  }

  listTargets(): RelayTarget[] {
    return [...this.targets.values()].map((t) => t.target)
  }

  async createTarget(url: string): Promise<RelayTarget> {
    const t = this.addTarget(url)
    for (const h of this.changed) h()
    return t
  }

  async closeTarget(id: string): Promise<boolean> {
    return this.targets.delete(id)
  }

  activateTarget(id: string): void {
    this.activated.push(id)
  }

  onTargetsChanged(handler: () => void): () => void {
    this.changed.add(handler)
    return () => { this.changed.delete(handler) }
  }

  debuggerOf(id: string): MockDebugger {
    const t = this.targets.get(id)
    if (!t) throw new Error(`no such target ${id}`)
    return t.debugger
  }
}

function wsCall(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = Math.floor(Math.random() * 1e9)
  return new Promise((resolve, reject) => {
    const onMessage = (raw: Buffer) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== id) return
      ws.off('message', onMessage)
      if (msg.error) reject(new Error(msg.error.message ?? 'cdp error'))
      else resolve(msg.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

describe('CdpRelay', () => {
  it('serves the plugin call sequence end to end', async () => {
    const host = new MockHost()
    let firstClientFired = 0
    const relay = await CdpRelay.start(host, { onFirstClient: () => { firstClientFired++ } })
    try {
      // 1. BrowserHub.attach: GET /json/version
      const ver = (await (await fetch(`${relay.endpoint}/json/version`)).json()) as Record<string, unknown>
      expect(typeof ver['webSocketDebuggerUrl']).toBe('string')
      const browserWsUrl = ver['webSocketDebuggerUrl'] as string
      expect(browserWsUrl).toContain('/devtools/browser/')

      // 2. browser WS + Target.setDiscoverTargets
      const browserWs = new WebSocket(browserWsUrl)
      await new Promise<void>((resolve) => browserWs.on('open', resolve))
      expect(firstClientFired).toBe(1)
      await wsCall(browserWs, 'Target.setDiscoverTargets', { discover: true })

      // 3. Target.createTarget (plugin createPage)
      const created = (await wsCall(browserWs, 'Target.createTarget', { url: 'https://example.com/' })) as { targetId: string }
      expect(created.targetId).toMatch(/^target-/)

      // 4. GET /json/list shows both targets with page WS urls
      const list = (await (await fetch(`${relay.endpoint}/json/list`)).json()) as Array<Record<string, unknown>>
      expect(list).toHaveLength(2)
      const page = list.find((t) => t['id'] === created.targetId)
      expect(page?.['type']).toBe('page')
      expect(page?.['url']).toBe('https://example.com/')
      expect(typeof page?.['webSocketDebuggerUrl']).toBe('string')

      // 5. page WS: command forwarded to the debugger, response returned
      const pageWs = new WebSocket(page?.['webSocketDebuggerUrl'] as string)
      await new Promise<void>((resolve) => pageWs.on('open', resolve))
      const evalResult = (await wsCall(pageWs, 'Runtime.evaluate', { expression: '1+1' })) as { result: { value: string } }
      expect(evalResult.result.value).toBe('mock')
      const dbg = host.debuggerOf(created.targetId)
      expect(dbg.commands.some((c) => c.method === 'Runtime.evaluate')).toBe(true)
      // activating the driven tab brings its view to front
      expect(host.activated).toContain(created.targetId)

      // 6. debugger event broadcast back to the page WS
      const eventPromise = new Promise<Record<string, unknown>>((resolve) => {
        const onMessage = (raw: Buffer) => {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>
          if (msg['method'] === 'Page.loadEventFired') { pageWs.off('message', onMessage); resolve(msg) }
        }
        pageWs.on('message', onMessage)
      })
      dbg.emit('Page.loadEventFired', {})
      const event = await eventPromise
      expect(event['method']).toBe('Page.loadEventFired')

      // 7. unknown browser command -> CDP error (not a hang)
      await expect(wsCall(browserWs, 'Target.nope', {})).rejects.toThrow()

      // 8. GET /json/close/:id
      const closeRes = await fetch(`${relay.endpoint}/json/close/${created.targetId}`)
      expect(closeRes.status).toBe(200)
      const list2 = (await (await fetch(`${relay.endpoint}/json/list`)).json()) as Array<unknown>
      expect(list2).toHaveLength(1)

      browserWs.close()
      pageWs.close()
    } finally {
      await relay.stop()
    }
  })

  it('rejects page WS for unknown targets', async () => {
    const host = new MockHost()
    const relay = await CdpRelay.start(host)
    try {
      const ws = new WebSocket(`${relay.endpoint.replace(/^http/, 'ws')}/devtools/page/nope`)
      const closed = await new Promise<number>((resolve) => ws.on('close', (code: number) => resolve(code)))
      expect(closed).toBe(1008)
    } finally {
      await relay.stop()
    }
  })
})
