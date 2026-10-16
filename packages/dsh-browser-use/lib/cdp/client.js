/**
 * 极简 CDP 客户端（Node 22+ 全局 WebSocket，无第三方依赖）。
 * - 按 id 配对命令响应，带超时
 * - 按 method 分发事件
 * - 支持 flatten 会话（Target.attachToTarget flatten:true 后的 sessionId）
 */
import { setTimeout as delay } from 'node:timers/promises';
export class CdpUnreachableError extends Error {
    endpoint;
    code = 'BROWSER_USE_CDP_UNREACHABLE';
    constructor(endpoint, reason) {
        super(`browser-use: 连不上 CDP 端点 ${endpoint}：${reason}`);
        this.endpoint = endpoint;
        this.name = 'CdpUnreachableError';
    }
}
export class CdpProtocolError extends Error {
    code = 'BROWSER_USE_CDP_PROTOCOL';
    constructor(message) {
        super(message);
        this.name = 'CdpProtocolError';
    }
}
export class CdpCommandTimeoutError extends CdpProtocolError {
    method;
    timeoutMs;
    code = 'BROWSER_USE_CDP_TIMEOUT';
    constructor(method, timeoutMs) {
        super(`browser-use: CDP 命令 ${method} 超时（${timeoutMs}ms）`);
        this.method = method;
        this.timeoutMs = timeoutMs;
        this.name = 'CdpCommandTimeoutError';
    }
}
function wsUrlOf(endpoint) {
    // http://127.0.0.1:PORT -> ws://127.0.0.1:PORT
    return endpoint.replace(/^http/, 'ws');
}
export async function listTargets(endpoint, timeoutMs = 5000) {
    let res;
    try {
        res = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    }
    catch (e) {
        throw new CdpUnreachableError(endpoint, e instanceof Error ? e.message : String(e));
    }
    if (!res.ok)
        throw new CdpUnreachableError(endpoint, `HTTP ${res.status}（这个端口上跑的可能不是 Chrome）`);
    const data = await res.json().catch(() => { throw new CdpProtocolError('browser-use: /json/list 回来的不是 JSON'); });
    if (!Array.isArray(data))
        throw new CdpProtocolError('browser-use: /json/list 回来的不是数组');
    const out = [];
    for (const t of data) {
        if (typeof t !== 'object' || !t)
            continue;
        const r = t;
        if (typeof r['webSocketDebuggerUrl'] === 'string' && r['webSocketDebuggerUrl'] !== '') {
            out.push({
                id: typeof r['id'] === 'string' ? r['id'] : '',
                type: typeof r['type'] === 'string' ? r['type'] : '',
                title: typeof r['title'] === 'string' ? r['title'] : '',
                url: typeof r['url'] === 'string' ? r['url'] : '',
                webSocketDebuggerUrl: r['webSocketDebuggerUrl'],
            });
        }
    }
    return out;
}
export async function createTarget(endpoint, url, timeoutMs = 8000) {
    const put = `${endpoint}/json/new?${encodeURIComponent(url)}`;
    let res;
    try {
        res = await fetch(put, { method: 'PUT', signal: AbortSignal.timeout(timeoutMs) });
    }
    catch (e) {
        throw new CdpUnreachableError(endpoint, e instanceof Error ? e.message : String(e));
    }
    if (!res.ok)
        throw new CdpProtocolError(`browser-use: 新建标签页失败（HTTP ${res.status}）`);
    const t = (await res.json());
    return {
        id: String(t['id'] ?? ''),
        type: String(t['type'] ?? 'page'),
        title: String(t['title'] ?? ''),
        url: String(t['url'] ?? url),
        webSocketDebuggerUrl: String(t['webSocketDebuggerUrl'] ?? ''),
    };
}
export async function closeTarget(endpoint, targetId) {
    try {
        await fetch(`${endpoint}/json/close/${encodeURIComponent(targetId)}`, {
            method: 'PUT',
            signal: AbortSignal.timeout(5000),
        });
    }
    catch { /* 尽力而为 */ }
}
export class CdpConnection {
    socket;
    label;
    log;
    nextId = 1;
    pending = new Map();
    handlers = new Map();
    closed = false;
    constructor(socket, label, log) {
        this.socket = socket;
        this.label = label;
        this.log = log;
        socket.addEventListener('message', (ev) => this.dispatch(String(ev.data)));
        socket.addEventListener('close', () => {
            this.closed = true;
            for (const [, p] of this.pending) {
                clearTimeout(p.timer);
                p.reject(new CdpUnreachableError(this.label, 'WebSocket 已关闭'));
            }
            this.pending.clear();
        });
        socket.addEventListener('error', () => { });
    }
    static async connect(url, label, log, timeoutMs = 10000) {
        const socket = new WebSocket(url);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new CdpUnreachableError(label, 'WebSocket 建连超时')), timeoutMs);
            socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
            socket.addEventListener('error', () => { clearTimeout(timer); reject(new CdpUnreachableError(label, 'WebSocket 建连失败')); }, { once: true });
        });
        return new CdpConnection(socket, label, log);
    }
    get isClosed() {
        return this.closed;
    }
    async send(method, params, sessionId, timeoutMs = 30000) {
        if (this.closed)
            throw new CdpUnreachableError(this.label, '连接已关闭');
        const id = this.nextId++;
        const message = { id, method };
        if (params !== undefined)
            message['params'] = params;
        if (sessionId)
            message['sessionId'] = sessionId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CdpCommandTimeoutError(method, timeoutMs));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => resolve(v),
                reject,
                timer,
                method,
            });
            try {
                this.socket.send(JSON.stringify(message));
            }
            catch (e) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(new CdpUnreachableError(this.label, e instanceof Error ? e.message : '发送失败'));
            }
        });
    }
    on(method, handler) {
        let set = this.handlers.get(method);
        if (!set) {
            set = new Set();
            this.handlers.set(method, set);
        }
        set.add(handler);
        return () => { set.delete(handler); };
    }
    dispatch(data) {
        let msg;
        try {
            const parsed = JSON.parse(data);
            if (typeof parsed !== 'object' || !parsed)
                return;
            msg = parsed;
        }
        catch {
            return;
        }
        if (typeof msg['id'] === 'number') {
            const p = this.pending.get(msg['id']);
            if (!p)
                return;
            this.pending.delete(msg['id']);
            clearTimeout(p.timer);
            const err = msg['error'];
            if (err && typeof err === 'object') {
                const m = err['message'];
                p.reject(new CdpProtocolError(`browser-use: CDP ${p.method} 失败：${typeof m === 'string' ? m : '未知错误'}`));
            }
            else {
                p.resolve(msg['result'] ?? {});
            }
            return;
        }
        const method = msg['method'];
        if (typeof method !== 'string')
            return;
        const params = msg['params'] ?? {};
        const sessionId = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';
        const set = this.handlers.get(method);
        if (!set)
            return;
        for (const h of set) {
            try {
                h(params, sessionId);
            }
            catch (e) {
                this.log(`browser-use: 事件处理器异常 ${method}：${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    close() {
        this.closed = true;
        try {
            this.socket.close();
        }
        catch { /* ignore */ }
    }
}
/**
 * 浏览器级连接：负责 Target 域（列标签页/新建/监听）。
 * 页面级命令走直连 page target 的 CdpConnection（无需 sessionId）。
 */
export class BrowserHub {
    endpoint;
    conn;
    log;
    constructor(endpoint, conn, log) {
        this.endpoint = endpoint;
        this.conn = conn;
        this.log = log;
    }
    static async attach(endpoint, log) {
        // /json/version 给出浏览器级 webSocketDebuggerUrl
        let ver;
        try {
            ver = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5000) });
        }
        catch (e) {
            throw new CdpUnreachableError(endpoint, e instanceof Error ? e.message : String(e));
        }
        const info = (await ver.json());
        const wsUrl = info['webSocketDebuggerUrl'];
        if (typeof wsUrl !== 'string' || !wsUrl)
            throw new CdpProtocolError('browser-use: /json/version 没有给出 webSocketDebuggerUrl');
        const conn = await CdpConnection.connect(wsUrl, endpoint, log);
        const hub = new BrowserHub(endpoint, conn, log);
        await conn.send('Target.setDiscoverTargets', { discover: true });
        return hub;
    }
    async createPage(url = 'about:blank') {
        const r = await this.conn.send('Target.createTarget', { url });
        const targetId = r['targetId'];
        if (typeof targetId !== 'string')
            throw new CdpProtocolError('browser-use: Target.createTarget 没返回 targetId');
        // 等 target 出现在 /json/list 里拿到 ws 地址
        const start = Date.now();
        for (;;) {
            const targets = await listTargets(this.endpoint).catch(() => []);
            const t = targets.find((x) => x.id === targetId && x.type === 'page');
            if (t)
                return t;
            if (Date.now() - start > 8000)
                throw new CdpProtocolError('browser-use: 新标签页建出来了但连不上');
            await delay(200);
        }
    }
    onTargetCreated(handler) {
        return this.conn.on('Target.targetCreated', (p) => {
            const info = p['targetInfo'];
            if (info && info['type'] === 'page')
                handler(String(info['targetId'] ?? ''), String(info['url'] ?? ''));
        });
    }
    close() {
        this.conn.close();
    }
}
/** 直连一个 page target 的会话 */
export async function connectPage(target, log) {
    return CdpConnection.connect(target.webSocketDebuggerUrl, target.id, log);
}
//# sourceMappingURL=client.js.map