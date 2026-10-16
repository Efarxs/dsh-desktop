/**
 * 用户本机浏览器的探测与启动。
 * 设计（沿用 dsh-qw-rrzu-ops 实测可用的模式）：
 * - 只认本机已安装的 Chrome / Edge（auto = Edge 优先，Windows 上必装）
 * - 永远用独立 --user-data-dir（默认 <workDir>/browser-profile），不碰日常 profile
 * - --remote-debugging-port=0 拿临时端口，实际端口从 profile 下 DevToolsActivePort 读
 * - 只绑 127.0.0.1；headful 启动（用户要看得见、可接管）
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
export const BROWSER_KIND_LABELS = {
    chrome: 'Google Chrome',
    edge: 'Microsoft Edge',
};
function onPath(env, name) {
    const pathEnv = env['PATH'] ?? '';
    const sep = process.platform === 'win32' ? ';' : ':';
    const exts = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
    for (const dir of pathEnv.split(sep)) {
        if (!dir)
            continue;
        for (const ext of exts) {
            const p = `${dir}/${name}${ext}`.replace(/\\/gu, '/');
            try {
                if (existsSync(p))
                    return p;
            }
            catch { /* ignore */ }
        }
    }
    return undefined;
}
export function candidatePaths(kind, platform, env) {
    const out = [];
    const push = (p) => { if (p)
        out.push(p); };
    if (platform === 'darwin') {
        push(kind === 'chrome'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    }
    else if (platform === 'win32') {
        const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
        const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
        const local = env['LOCALAPPDATA'] ?? '';
        if (kind === 'chrome') {
            push(`${pf}\\Google\\Chrome\\Application\\chrome.exe`);
            push(`${pf86}\\Google\\Chrome\\Application\\chrome.exe`);
            if (local)
                push(`${local}\\Google\\Chrome\\Application\\chrome.exe`);
        }
        else {
            push(`${pf}\\Microsoft\\Edge\\Application\\msedge.exe`);
            push(`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`);
        }
    }
    else {
        // linux
        if (kind === 'chrome') {
            push(onPath(env, 'google-chrome'));
            push(onPath(env, 'google-chrome-stable'));
            push('/opt/google/chrome/chrome');
        }
        else {
            push(onPath(env, 'microsoft-edge'));
            push(onPath(env, 'microsoft-edge-stable'));
            push('/opt/microsoft/msedge/msedge');
        }
        push(onPath(env, 'chromium'));
        push(onPath(env, 'chromium-browser'));
    }
    return out;
}
export function detectBrowsers(platform = process.platform, env = process.env) {
    const found = [];
    const seen = new Set();
    // Edge 优先：Windows 上必装，Chrome 不一定
    for (const kind of ['edge', 'chrome']) {
        for (const p of candidatePaths(kind, platform, env)) {
            try {
                if (!existsSync(p) || seen.has(p))
                    continue;
            }
            catch {
                continue;
            }
            seen.add(p);
            found.push({ kind, label: BROWSER_KIND_LABELS[kind], path: p });
        }
    }
    return found;
}
export function pickBrowser(candidates, preference) {
    if (preference !== 'auto')
        return candidates.find((c) => c.kind === preference);
    return candidates[0];
}
/**
 * 启动参数。port 传 0 = 让 Chrome 自己挑空闲端口。
 */
export function buildLaunchArgs(port, profileDir, url) {
    return [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        // 调试端口只绑回环，绝不 0.0.0.0
        '--remote-allow-origins=http://127.0.0.1/*',
        url,
    ];
}
export function spawnBrowser(path, args) {
    const child = spawn(path, [...args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.unref();
}
export function portOf(endpoint) {
    try {
        return new URL(endpoint).port ? Number(new URL(endpoint).port) : 0;
    }
    catch {
        return 0;
    }
}
export async function probeEndpoint(endpoint, timeoutMs = 4000) {
    try {
        const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok;
    }
    catch {
        return false;
    }
}
export async function waitForEndpoint(endpoint, options) {
    const timeoutMs = options?.timeoutMs ?? 20000;
    const intervalMs = options?.intervalMs ?? 300;
    const start = Date.now();
    for (;;) {
        if (await probeEndpoint(endpoint, 1500))
            return;
        if (Date.now() - start > timeoutMs) {
            throw new Error(`browser-use: 等了 ${timeoutMs}ms，${endpoint} 上还是没有 CDP 响应。` +
                '可能原因：profile 目录被另一个 Chrome 进程占用（SingletonLock），或浏览器崩溃。');
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
/**
 * 从 profile 目录的 DevToolsActivePort 读实际端口（--remote-debugging-port=0 时用）。
 *
 * ⚠️ **这个文件在浏览器退出后不会被删掉。** 它只记录"上一次启动用了哪个端口"，
 * 浏览器关掉、崩溃、或 profile 被别的进程接管之后，它仍然躺在那儿，
 * 于是再读它就会得到一个**没人监听**的端口号 —— 症状是"启动了浏览器，
 * 却在某个陈旧端口上等 CDP 响应等到超时"。所以它只是个线索，
 * **必须配合探活使用**（见 `liveEndpointFromProfile`）。
 */
export function readActivePort(profileDir) {
    try {
        const raw = readFileSync(`${profileDir}/DevToolsActivePort`, 'utf8').split('\n')[0]?.trim();
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : undefined;
    }
    catch {
        return undefined;
    }
}
/** 删掉陈旧的 DevToolsActivePort —— 启动新实例前清场，免得读到上一次的端口。 */
export function clearActivePort(profileDir) {
    try {
        unlinkSync(`${profileDir}/DevToolsActivePort`);
    }
    catch { /* 本来就不存在，或没权限删 —— 都不是故障 */ }
}
/**
 * 顺着 profile 找**还活着**的浏览器实例。
 *
 * 两步都要：先读端口（可能陈旧），再探活（探不通就说明那是旧值）。
 * 只用第一步会指向死端口；只用第二步就不知道端口是多少。
 *
 * @param profileDir - 独立 profile 目录。
 * @returns 可用的 CDP endpoint，或 undefined（没有活着的实例）。
 */
export async function liveEndpointFromProfile(profileDir) {
    const port = readActivePort(profileDir);
    if (!port)
        return undefined;
    const endpoint = `http://127.0.0.1:${port}`;
    return (await probeEndpoint(endpoint, 1500)) ? endpoint : undefined;
}
/** 启动浏览器，返回可用的 CDP endpoint（http://127.0.0.1:PORT） */
export async function launchBrowser(request) {
    // 启动前先清掉上一次留下的端口文件：它是"上次用了哪个端口"的记录，不是"现在有谁在听"。
    // 不清的话，下面那个读取循环可能立刻读到旧值，然后拿着一个没人监听的端口去等 CDP。
    clearActivePort(request.profileDir);
    const args = buildLaunchArgs(0, request.profileDir, request.url);
    spawnBrowser(request.candidate.path, args);
    // 等 DevToolsActivePort 文件出现，最多 10s
    const start = Date.now();
    let port;
    while (Date.now() - start < 10000) {
        port = readActivePort(request.profileDir);
        // 探一下再认：新实例写文件与真正开始监听之间有窗口期，
        // 而"读到了端口"不等于"端口上有人"。
        if (port && (await probeEndpoint(`http://127.0.0.1:${port}`, 1000)))
            break;
        port = undefined;
        await new Promise((r) => setTimeout(r, 200));
    }
    if (!port) {
        throw new Error('browser-use: 浏览器进程起来了，但 CDP 端点没就绪。' +
            'profile 可能被另一个 Chrome 进程占用（SingletonLock），或启动参数被拦截。');
    }
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForEndpoint(endpoint, { timeoutMs: request.timeoutMs ?? 20000 });
    return { endpoint, label: request.candidate.label };
}
//# sourceMappingURL=launch.js.map