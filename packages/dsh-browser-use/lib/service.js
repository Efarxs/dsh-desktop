/**
 * BrowserService：浏览器生命周期 + 当前页面会话 + 对话框队列。
 * - 懒启动：第一个工具调用时才起浏览器（连已有 cdpEndpoint 或自己起）
 * - 独立 profile（用户已选），登录态持久化
 * - 对话框自动进队列，不自动点，等 browser_handle_dialog
 */
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';
import { BrowserHub, closeTarget, connectPage, listTargets, } from './cdp/client.js';
import { RefRegistry, takeSnapshot } from './cdp/snapshot.js';
import { detectBrowsers, launchBrowser, liveEndpointFromProfile, pickBrowser, probeEndpoint } from './browser/launch.js';
import { resolveProfileDir } from './config.js';
import { OriginPolicy } from './policy.js';
export class BrowserService {
    cfg;
    log;
    hub = null;
    pageConn = null;
    target = null;
    endpoint = null;
    browserLabel = '';
    launchedOwn = false;
    starting = null;
    refs = new RefRegistry();
    dialogs = [];
    policy;
    constructor(cfg, log) {
        this.cfg = cfg;
        this.log = log;
        this.policy = new OriginPolicy(cfg.allowedOrigins, cfg.newOriginPolicy);
    }
    get isRunning() {
        return this.pageConn !== null && !this.pageConn.isClosed;
    }
    get currentTargetId() {
        return this.target?.id ?? '';
    }
    get currentUrl() {
        return this.target?.url ?? '';
    }
    /** 确保浏览器+页面会话就绪（幂等，可并发调用） */
    async ensure(signal) {
        if (this.isRunning)
            return;
        if (!this.starting) {
            this.starting = this.start(signal).catch((e) => {
                // 启动失败：关掉半截连接，下次 ensure 重试
                try {
                    this.pageConn?.close();
                }
                catch { /* ignore */ }
                try {
                    this.hub?.close();
                }
                catch { /* ignore */ }
                this.pageConn = null;
                this.hub = null;
                throw e;
            }).finally(() => { this.starting = null; });
        }
        await this.starting;
    }
    /** 给一个页面连接挂 Page 域 + 对话框监听（start/switchTo 共用） */
    async wirePage(conn) {
        await conn.send('Page.enable', {});
        conn.on('Page.javascriptDialogOpening', (p) => {
            this.dialogs.push({
                type: typeof p['type'] === 'string' ? p['type'] : 'alert',
                message: typeof p['message'] === 'string' ? p['message'] : '',
                url: this.target?.url ?? '',
            });
            this.log(`browser-use: 页面弹出了对话框（${this.dialogs.length} 个待处理）`);
        });
    }
    async start(signal) {
        // 1. 端点：配了 cdpEndpoint（插件配置 / DSH_BROWSER_USE_CDP / agent-browser-cdp.json）就先连，连不上再自己起
        let endpoint = this.cfg.cdpEndpoint;
        const endpointSource = this.cfg.cdpEndpointSource;
        if (!endpoint) {
            this.log('browser-use: 没拿到桌面中继端点（插件配置、环境变量 DSH_BROWSER_USE_CDP、文件 agent-browser-cdp.json 都没有），改由插件自己起浏览器');
        }
        else if (!(await probeEndpoint(endpoint, 3000))) {
            this.log(`browser-use: 中继端点 ${endpoint}（来源：${endpointSource}）连不上，改由插件自己起浏览器`);
            endpoint = '';
        }
        // 2. 没配端点时，先看**上一次启动的浏览器是不是还活着**。
        //    插件起的浏览器是 detached 的：dsh 重启（装卸插件、改配置都会触发）之后它还在跑，
        //    而插件这边已经忘了它。直接再起一个会撞 SingletonLock —— 同一个 profile 起不来第二个，
        //    新进程把用户请求转给老进程然后自己退出，DevToolsActivePort 里留的是**新进程**的端口，
        //    而监听在**老进程**的端口上。结果就是下面这种看不懂的症状：
        //    "启动了浏览器，却在 127.0.0.1:xxxxx 上等 CDP 响应等到超时"。
        //    复用老实例既省一次冷启动，也把这条歧路堵死。
        const profileDir = resolveProfileDir(this.cfg);
        if (!endpoint) {
            mkdirSync(profileDir, { recursive: true });
            const live = await liveEndpointFromProfile(profileDir);
            if (live) {
                endpoint = live;
                this.log(`browser-use: 发现上次启动的浏览器还活着，直接复用 ${live}`);
            }
        }
        if (!endpoint) {
            const candidates = detectBrowsers();
            const picked = pickBrowser(candidates, this.cfg.browser);
            if (!picked) {
                throw new Error('browser-use: 本机没找到 Chrome / Edge。请先安装 Chrome 或 Edge；' +
                    '或在插件配置里填 cdpEndpoint 指向一个已带 --remote-debugging-port 启动的浏览器。');
            }
            this.log(`browser-use: 正在启动 ${picked.label}（独立 profile：${profileDir}）…`);
            const launched = await launchBrowser({ candidate: picked, profileDir, url: this.cfg.startUrl });
            endpoint = launched.endpoint;
            this.browserLabel = launched.label;
            this.launchedOwn = true;
            this.log(`browser-use: 浏览器已启动，CDP 端点 ${endpoint}`);
        }
        else {
            this.log(`browser-use: 连接已有浏览器 ${endpoint}${endpointSource ? `（来源：${endpointSource}）` : ''}`);
        }
        this.endpoint = endpoint;
        // 2. 找一个 page target：
        //    - 自己起的浏览器：用它自带的第一个页（就是我们的）
        //    - 外接已有浏览器：新建一个专属页，不抢用户/别的插件正在看的标签页
        this.hub = await BrowserHub.attach(endpoint, this.log);
        let page;
        if (this.launchedOwn) {
            const targets = await listTargets(endpoint);
            page = targets.find((t) => t.type === 'page');
        }
        else if (this.cfg.cdpEndpointSource === '环境变量 DSH_BROWSER_USE_CDP' || this.cfg.cdpEndpointSource === '文件 agent-browser-cdp.json') {
            // The desktop relay creates one placeholder target before the first model
            // connection. Reusing its sole blank page keeps the first connection from
            // producing an extra empty tab while still leaving normal external Chrome
            // tabs untouched once the user has more than one page.
            const targets = await listTargets(endpoint);
            if (targets.length === 1 && targets[0]?.type === 'page' && targets[0].url === 'about:blank') {
                page = targets[0];
            }
        }
        if (!page)
            page = await this.hub.createPage(this.cfg.startUrl);
        this.target = page;
        this.pageConn = await connectPage(page, this.log);
        // 3. Page 域 + 对话框监听
        await this.wirePage(this.pageConn);
        void signal;
    }
    /** 当前页面连接（ensure 之后调） */
    conn() {
        if (!this.pageConn || this.pageConn.isClosed)
            throw new Error('browser-use: 浏览器连接已断开，请重试（会自动重连）');
        return this.pageConn;
    }
    refsRegistry() {
        return this.refs;
    }
    status() {
        return {
            running: this.isRunning,
            endpoint: this.endpoint,
            browser: this.browserLabel,
            url: this.target?.url ?? '',
            title: this.target?.title ?? '',
            launchedOwn: this.launchedOwn,
            pendingDialogs: this.dialogs.length,
        };
    }
    async snapshot() {
        await this.ensure();
        return takeSnapshot(this.conn(), this.refs);
    }
    /**
     * 导航（含审批），返回新快照。
     *
     * ⚠️ **审批在 `ensure()` 之前**：没说"允许"就不该弹出浏览器窗口。
     * 反过来写（先启动再审批）的后果是——用户拒绝之后，一个没人要的空白浏览器
     * 已经开在桌面上了，而他刚说完"不要"。
     */
    async navigate(url, signal) {
        const { verdict, origin } = this.policy.check(url);
        if (verdict === 'deny')
            throw new Error(`browser-use: ${origin} 被策略拒绝访问（newOriginPolicy=deny）`);
        if (verdict === 'needs_approval')
            throw new Error(this.policy.approvalMessage(origin));
        await this.ensure(signal);
        const conn = this.conn();
        const loaded = new Promise((resolve) => {
            const off = conn.on('Page.loadEventFired', () => { off(); resolve(); });
            setTimeout(() => { off(); resolve(); }, 15000);
        });
        await conn.send('Page.navigate', { url });
        await loaded;
        await delay(400); // 给 JS 渲染一点时间
        return takeSnapshot(conn, this.refs);
    }
    takeDialog() {
        return this.dialogs.shift();
    }
    peekDialogs() {
        return this.dialogs;
    }
    async switchTo(targetId) {
        await this.ensure();
        if (!this.endpoint || !this.hub)
            throw new Error('browser-use: 浏览器未就绪');
        const targets = await listTargets(this.endpoint);
        const t = targets.find((x) => x.id === targetId && x.type === 'page');
        if (!t)
            throw new Error(`browser-use: 找不到标签页 ${targetId}`);
        // 切页面：关旧连接、连新的（含对话框监听）
        this.pageConn?.close();
        this.target = t;
        this.pageConn = await connectPage(t, this.log);
        const conn = this.pageConn;
        await this.wirePage(conn);
        return t;
    }
    async listPages() {
        await this.ensure();
        if (!this.endpoint)
            return [];
        return (await listTargets(this.endpoint)).filter((t) => t.type === 'page');
    }
    /** 新开标签页。审批同样在 `ensure()` 之前 —— 理由见 `navigate()`。 */
    async newPage(url) {
        const { verdict, origin } = this.policy.check(url);
        if (verdict === 'deny')
            throw new Error(`browser-use: ${origin} 被策略拒绝访问`);
        if (verdict === 'needs_approval')
            throw new Error(this.policy.approvalMessage(origin));
        await this.ensure();
        if (!this.hub)
            throw new Error('browser-use: 浏览器未就绪');
        return this.hub.createPage(url);
    }
    async closePage(targetId) {
        await this.ensure();
        if (!this.endpoint)
            return;
        if (this.target?.id === targetId)
            throw new Error('browser-use: 不能关当前正在操作的标签页，先用 browser_tabs 切换到别的');
        await closeTarget(this.endpoint, targetId);
    }
    async dispose() {
        this.pageConn?.close();
        this.hub?.close();
        this.hub = null;
        this.pageConn = null;
        this.target = null;
        // 自己起的浏览器进程随插件走：不主动杀（用户可能还在看），只断开 CDP
        this.log('browser-use: 已断开浏览器连接');
    }
}
//# sourceMappingURL=service.js.map