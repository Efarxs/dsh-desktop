/**
 * 客户端入口：**无界面**。
 *
 * 2026-10-15 下线了右侧边栏的 MJPEG 投屏面板 —— 它只是 view-only 的镜像，
 * 不是 codex 式的内嵌控制，留着是自欺欺人。浏览器是 headful 起在本机的真实窗口，
 * 用户直接看它、随时人工接管（登录、验证码）；模型的视觉走 `browser_take_screenshot`
 * 工具（经 saveImageBlock 发 `{type:'image', attachment}` 真链路）。
 *
 * 这个文件还留着是因为 Harness 可能仍期望客户端入口存在：只导出 `apply`/`inject`，
 * `apply` 里做个兼容性检查，不注册任何 UI（`scripts/verify-client-bundle.mjs`
 * 会断言这两个导出都在）。
 *
 * 构建：esbuild 打成 CJS 单文件 → `scripts/wrap-client.mjs` 套上
 * `window.__ModuleLoader__.load({id: "dsh-browser-use", factory})` 的壳。
 */
import { DIAGNOSTIC_PREFIX, INJECT, PANEL_ID } from "./ids.js";

/** Harness 按这个声明给客户端注入服务。本插件的客户端不需要任何服务。 */
export const inject: readonly string[] = INJECT;

/**
 * 兼容性检查：只确认 ctx 可用，不注册任何界面。
 * @param ctx Harness 交给插件的裸浏览器上下文。
 */
export function apply(ctx: unknown): void {
  if (typeof ctx !== "object" || ctx === null) {
    console.warn(`${DIAGNOSTIC_PREFIX} 客户端 apply 拿到的 ctx 不可用，跳过。`);
    return;
  }
  console.warn(
    `${DIAGNOSTIC_PREFIX} ${PANEL_ID} 客户端已加载（无界面：浏览器是本机弹出的真实窗口，直接看它/操作它；模型视觉靠 browser_take_screenshot）。`,
  );
}
