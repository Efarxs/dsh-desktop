/**
 * CDP relay: exposes Electron `webContents.debugger` as a Chrome DevTools
 * HTTP + WebSocket endpoint, so the dsh-browser-use plugin's CdpConnection
 * (plain WebSocket CDP) connects unmodified.
 *
 * Protocol surface the plugin actually uses (see plugin src/cdp/client.ts):
 *   HTTP: GET /json/version (browser-level webSocketDebuggerUrl)
 *         GET /json/list (page target list)
 *         GET /json/close/<targetId> (close a tab)
 *   WS browser session: Target.setDiscoverTargets / Target.createTarget
 *   WS page session: every other command is forwarded to the debugger,
 *                    debugger events are broadcast back.
 *
 * This file does not import electron directly (keeps it unit-testable);
 * agent-browser.ts adapts webContents.debugger to the RelayTargetHost interface.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'

/** One page target's debugger (in Electron: a thin wrapper over webContents.debugger). */
export interface RelayDebugger {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  onMessage(handler: (method: string, params: Record<string, unknown>) => void): () => void
}

export interface RelayTarget {
  readonly id: string
  title: string
  url: string
  readonly debugger: RelayDebugger
}

export interface RelayTargetHost {
  listTargets(): RelayTarget[]
  createTarget(url: string): Promise<RelayTarget>
  closeTarget(id: string): Promise<boolean>
  /** Bring this target's view to the front (the visible pane). */
  activateTarget(id: string): void
  onTargetsChanged(handler: () => void): () => void
}

export interface CdpRelayOptions {
  host?: string
  port?: number
  /** Called once when the first WS client connects; the host uses it to auto-expand the browser pane. */
  onFirstClient?: () => void
}

interface BrowserClient {
  ws: WebSocket
  discover: boolean
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

export class CdpRelay {
  private firstClientFired = false
  private readonly browserClients = new Set<BrowserClient>()
  /** targetId -> connected page WS clients (for event broadcast). */
  private readonly pageClients = new Map<string, Set<WebSocket>>()
  private readonly detachDebugHandlers = new Map<string, () => void>()

  private constructor(
    private readonly server: ReturnType<typeof createServer>,
    private readonly wss: WebSocketServer,
    private readonly targetHost: RelayTargetHost,
    private readonly options: CdpRelayOptions,
    readonly endpoint: string,
  ) {}

  static async start(targetHost: RelayTargetHost, options: CdpRelayOptions = {}): Promise<CdpRelay> {
    const host = options.host ?? '127.0.0.1'
    const wss = new WebSocketServer({ noServer: true })
    const relay = new CdpRelay(createServer(), wss, targetHost, options, '')
    relay.wire()
    const port = await new Promise<number>((resolve, reject) => {
      relay.server.once('error', reject)
      relay.server.listen(options.port ?? 0, host, () => {
        const addr = relay.server.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('CDP relay: listen failed'))
      })
    })
    ;(relay as { endpoint: string }).endpoint = `http://${host}:${port}`
    return relay
  }

  private fireFirstClient(): void {
    if (this.firstClientFired) return
    this.firstClientFired = true
    // Best-effort UI hint; a failing callback must not break the CDP session.
    try { this.options.onFirstClient?.() } catch { /* UI hint only, safe to ignore */ }
  }

  private browserWsUrl(): string {
    return this.endpoint.replace(/^http/, 'ws') + `/devtools/browser/${randomUUID()}`
  }

  private pageWsUrl(targetId: string): string {
    return this.endpoint.replace(/^http/, 'ws') + `/devtools/page/${targetId}`
  }

  private targetInfo(t: RelayTarget): Record<string, unknown> {
    return {
      description: '',
      devtoolsFrontendUrl: `/devtools/inspector.html?ws=${encodeURIComponent(this.pageWsUrl(t.id))}`,
      id: t.id,
      title: t.title,
      type: 'page',
      url: t.url,
      webSocketDebuggerUrl: this.pageWsUrl(t.id),
    }
  }

  private wire(): void {
    this.server.on('request', (req, res) => this.handleHttp(req, res))
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const m = url.pathname.match(/^\/devtools\/(browser|page)\/([^/]+)$/)
      if (!m || !m[1] || !m[2]) { socket.destroy(); return }
      const kind = m[1]
      const targetId = m[2]
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        if (kind === 'browser') this.handleBrowserSession(ws)
        else this.handlePageSession(ws, targetId)
      })
    })
    // Push target lifecycle events to browser clients that opted into discover mode.
    this.targetHost.onTargetsChanged(() => {
      for (const c of this.browserClients) {
        if (!c.discover || c.ws.readyState !== c.ws.OPEN) continue
        for (const t of this.targetHost.listTargets()) {
          c.ws.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: this.targetInfo(t) } }))
        }
      }
    })
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/json/version') {
      json(res, 200, {
        Browser: 'dsh-desktop-agent-browser/1.0',
        'Protocol-Version': '1.3',
        'User-Agent': 'dsh-desktop-agent-browser',
        'V8-Version': '',
        'WebKit-Version': '',
        webSocketDebuggerUrl: this.browserWsUrl(),
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/json/list') {
      json(res, 200, this.targetHost.listTargets().map((t) => this.targetInfo(t)))
      return
    }
    const closeMatch = url.pathname.match(/^\/json\/close\/([^/]+)$/)
    if (req.method === 'GET' && closeMatch?.[1]) {
      const targetId = closeMatch[1]
      void this.targetHost.closeTarget(decodeURIComponent(targetId)).then((ok) => {
        if (ok) { res.writeHead(200); res.end('Target is closing') }
        else { res.writeHead(404); res.end('No such target') }
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/json/new') {
      const targetUrl = url.searchParams.get('url') ?? 'about:blank'
      void this.targetHost.createTarget(targetUrl).then((t) => json(res, 200, this.targetInfo(t)))
      return
    }
    res.writeHead(404)
    res.end('not found')
  }

  private handleBrowserSession(ws: WebSocket): void {
    this.fireFirstClient()
    const client: BrowserClient = { ws, discover: false }
    this.browserClients.add(client)
    ws.on('message', (raw) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown> }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id === undefined || typeof msg.method !== 'string') return
      void this.handleBrowserCommand(client, msg.method, msg.params ?? {}).then(
        (result) => ws.send(JSON.stringify({ id: msg.id, result })),
        (e) => ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } })),
      )
    })
    ws.on('close', () => { this.browserClients.delete(client) })
  }

  private async handleBrowserCommand(
    client: BrowserClient, method: string, params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'Target.setDiscoverTargets':
        client.discover = params['discover'] === true
        return {}
      case 'Target.getTargets':
        return { targetInfos: this.targetHost.listTargets().map((t) => this.targetInfo(t)) }
      case 'Target.createTarget': {
        const url = typeof params['url'] === 'string' ? params['url'] : 'about:blank'
        const t = await this.targetHost.createTarget(url)
        return { targetId: t.id }
      }
      case 'Target.closeTarget': {
        const targetId = String(params['targetId'] ?? '')
        const success = await this.targetHost.closeTarget(targetId)
        return { success }
      }
      case 'Target.activateTarget': {
        const targetId = String(params['targetId'] ?? '')
        this.targetHost.activateTarget(targetId)
        return {}
      }
      default:
        throw new Error(`CDP relay: browser-level command ${method} is not implemented`)
    }
  }

  private handlePageSession(ws: WebSocket, targetId: string): void {
    this.fireFirstClient()
    const target = this.targetHost.listTargets().find((t) => t.id === targetId)
    if (!target) { ws.close(1008, 'no such target'); return }
    // CDP activity on a target brings its view to the front.
    this.targetHost.activateTarget(targetId)

    let set = this.pageClients.get(targetId)
    if (!set) { set = new Set(); this.pageClients.set(targetId, set) }
    set.add(ws)

    // Lazily attach the debugger event forwarder on the first page client.
    if (!this.detachDebugHandlers.has(targetId)) {
      const detach = target.debugger.onMessage((method, params) => {
        const clients = this.pageClients.get(targetId)
        if (!clients) return
        const text = JSON.stringify({ method, params })
        for (const c of clients) {
          if (c.readyState === c.OPEN) c.send(text)
        }
      })
      this.detachDebugHandlers.set(targetId, detach)
    }

    ws.on('message', (raw) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown> }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id === undefined || typeof msg.method !== 'string') return
      // Keep the driven tab visible while the model works on it.
      this.targetHost.activateTarget(targetId)
      target.debugger.sendCommand(msg.method, msg.params ?? {}).then(
        (result) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: msg.id, result: result ?? {} })) },
        (e) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } })) },
      )
    })
    ws.on('close', () => {
      const s = this.pageClients.get(targetId)
      s?.delete(ws)
      if (s && s.size === 0) {
        this.pageClients.delete(targetId)
        // No listeners left; detach the forwarder. Best-effort cleanup.
        try { this.detachDebugHandlers.get(targetId)?.() } catch { /* detach is idempotent cleanup */ }
        this.detachDebugHandlers.delete(targetId)
      }
    })
  }

  async stop(): Promise<void> {
    for (const c of this.browserClients) { try { c.ws.close() } catch { /* closing anyway */ } }
    this.browserClients.clear()
    for (const [, set] of this.pageClients) { for (const ws of set) { try { ws.close() } catch { /* closing anyway */ } } }
    this.pageClients.clear()
    for (const [, detach] of this.detachDebugHandlers) { try { detach() } catch { /* detach is idempotent cleanup */ } }
    this.detachDebugHandlers.clear()
    this.wss.close()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
