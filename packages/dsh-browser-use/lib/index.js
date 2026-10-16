/**
 * dsh-browser-use 插件入口。
 * cordis 会调用 apply(ctx, config)；config 形状见 cordis.patch.yml。
 */
import { createHost } from './compat/host.js';
import { resolveConfig } from './config.js';
import { BrowserService } from './service.js';
import { registerBrowserTools } from './tools.js';
/**
 * 本插件必需的宿主服务，必须声明在**模块**上，不能只写在 cordis.patch.yml 的行里。
 *
 * cordis 4 的 ctx 是服务解析代理：读一个没 inject 的服务名直接抛
 * `cannot get property "tools" without inject`（ReflectService.handler.get）。
 * 实测踩坑：桌面宿主把本插件按 file: URL 插进 `desktop-host-sources.patch.yml`
 * （行级 `inject:` 在这条路径上根本不被消费），apply 里裸读 `ctx.tools` 就死在
 * 这儿，而当时 apply 把异常兜住直接 return —— 结果是「插件加载了、模型一个
 * browser_* 工具都看不到」，一路没有任何可读的失败。
 *
 * 声明在模块上还有第二层作用：宿主确实没有 tools 服务时，cordis 在 activate 阶段
 * 抛出带 bundle 归属的缺失服务错误，桌面据此进入插件恢复流程，而不是静默半死。
 */
export const inject = ['tools'];
function defaultHome() {
    const home = process.env['DSH_HOME'] ?? process.env['HOME'] ?? process.cwd();
    return `${home.replace(/\/+$/u, '')}/browser-use`;
}
export function apply(context, rawConfig) {
    const log = (m) => console.warn(`[dsh-browser-use] ${m}`);
    // tools 是本插件唯一的必需服务，拿不到就抛出去交给 Harness 归因（bundle 名 +
    // activate 阶段）。在这里兜住它等于把加载失败伪装成加载成功。
    const host = createHost(context, log);
    let cfg;
    try {
        cfg = resolveConfig(rawConfig, defaultHome());
    }
    catch (e) {
        log(`配置不合法，用默认值：${e instanceof Error ? e.message : String(e)}`);
        cfg = resolveConfig({}, defaultHome());
    }
    const svc = new BrowserService(cfg, log);
    const toolCtx = { svc, cfg, log };
    // 工具注册（懒启动：第一个工具调用时才起浏览器）
    const disposers = registerBrowserTools(host, toolCtx);
    host.effect(() => () => { for (const d of disposers)
        d(); }, 'dsh-browser-use: tools');
    // 插件卸载时断开浏览器
    host.effect(() => () => { void svc.dispose(); }, 'dsh-browser-use: dispose');
    log(`插件已加载。工作目录：${cfg.workDir}；浏览器策略：${cfg.browser}；新站点策略：${cfg.newOriginPolicy}`);
}
//# sourceMappingURL=index.js.map