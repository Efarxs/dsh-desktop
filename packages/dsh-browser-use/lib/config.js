/**
 * 插件配置。字段含义见 cordis.patch.yml 注释。
 * 全部手写校验，不依赖 schemastery，保证零运行时依赖。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const BROWSER_PREFS = ['auto', 'chrome', 'edge'];
const ORIGIN_POLICIES = ['ask', 'allow', 'deny'];
function str(v, dflt) {
    return typeof v === 'string' ? v : dflt;
}
function num(v, dflt, min, max) {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
    return Math.min(max, Math.max(min, n));
}
function bool(v, dflt) {
    return typeof v === 'boolean' ? v : dflt;
}
function strList(v) {
    if (!Array.isArray(v))
        return [];
    return v.filter((x) => typeof x === 'string' && x.length > 0);
}
export function resolveConfig(raw, homeDir) {
    const r = (typeof raw === 'object' && raw !== null ? raw : {});
    const browser = str(r['browser'], 'auto');
    const newOriginPolicy = str(r['newOriginPolicy'], 'ask');
    const sc = (typeof r['screencast'] === 'object' && r['screencast'] !== null
        ? r['screencast']
        : {});
    const workDir = str(r['workDir'], '').trim() || homeDir;
    const { endpoint: cdpEndpoint, source: cdpEndpointSource } = resolveCdpEndpoint(r);
    return {
        cdpEndpoint,
        cdpEndpointSource,
        browser: BROWSER_PREFS.includes(browser) ? browser : 'auto',
        browserProfileDir: str(r['browserProfileDir'], '').trim(),
        startUrl: str(r['startUrl'], 'about:blank').trim() || 'about:blank',
        allowedOrigins: strList(r['allowedOrigins']),
        newOriginPolicy: ORIGIN_POLICIES.includes(newOriginPolicy)
            ? newOriginPolicy
            : 'ask',
        allowEvaluate: bool(r['allowEvaluate'], false),
        screencast: {
            enabled: bool(sc['enabled'], true),
            quality: num(sc['quality'], 70, 1, 100),
            maxWidth: num(sc['maxWidth'], 1280, 320, 3840),
            everyNthFrame: num(sc['everyNthFrame'], 2, 1, 10),
        },
        workDir,
    };
}
/**
 * 桌面壳（dsh-desktop fork）起的 CDP 中继端点。
 * 优先级：显式插件配置 > 环境变量 DSH_BROWSER_USE_CDP > <DSH_HOME>/agent-browser-cdp.json。
 * Electron main 在拉起 dsh 子进程前同时写环境变量和文件；DSH_HOME 本来就在子进程 env 里。
 */
export function resolveCdpEndpoint(raw) {
    const r = (typeof raw === 'object' && raw !== null ? raw : {});
    const fromConfig = str(r['cdpEndpoint'], '').trim().replace(/\/+$/u, '');
    if (fromConfig)
        return { endpoint: fromConfig, source: '插件配置' };
    const fromEnv = (process.env['DSH_BROWSER_USE_CDP'] ?? '').trim().replace(/\/+$/u, '');
    if (fromEnv)
        return { endpoint: fromEnv, source: '环境变量 DSH_BROWSER_USE_CDP' };
    const fromFile = readRelayEndpointFile();
    if (fromFile)
        return { endpoint: fromFile, source: '文件 agent-browser-cdp.json' };
    return { endpoint: '', source: '' };
}
/** 读 <DSH_HOME>/agent-browser-cdp.json；没有/坏了就返回空串（不是故障）。 */
function readRelayEndpointFile() {
    try {
        const dshHome = (process.env['DSH_HOME'] ?? '').trim();
        if (!dshHome)
            return '';
        const raw = readFileSync(join(dshHome, 'agent-browser-cdp.json'), 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || !parsed)
            return '';
        const endpoint = parsed['cdpEndpoint'];
        return typeof endpoint === 'string' ? endpoint.trim().replace(/\/+$/u, '') : '';
    }
    catch {
        return '';
    }
}
/** profile 目录：配置留空就用 <workDir>/browser-profile */
export function resolveProfileDir(cfg) {
    const p = cfg.browserProfileDir.trim();
    if (p.length > 0)
        return p;
    return `${cfg.workDir.replace(/\/+$/u, '')}/browser-profile`;
}
export function originOf(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
            return '';
        return u.origin;
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=config.js.map