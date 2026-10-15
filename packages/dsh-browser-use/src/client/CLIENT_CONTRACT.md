# dsh-browser-use 客户端契约

> ⚠️ **2026-10-15：右侧投屏面板已下线。** 下面是历史契约，留着备查 ——
> 右栏 tab（`BrowserPanel` / `tabDefinition` / `SidebarIcon`）、
> `slots` 注册、`routes.ts`（`status.json` / `stream.mjpeg`）、`compat.ts`、`http.ts`
> 已全部删除。现在的客户端只有 `src/client/index.tsx`（空操作的 `apply`，做兼容性检查，
> 不注册任何 UI）+ `src/client/ids.ts`（`PANEL_ID` / `INJECT=[]` / `DIAGNOSTIC_PREFIX`）。
> 构建仍输出 `lib/client.js`（package.json `exports["./client"]`），Harness 按
> `apply` / `inject` 两个导出名调它。

客户端源码：`src/client/`，构建后输出 `lib/client.js`（package.json `exports["./client"]`），
由 Harness 网页端通过 `window.__ModuleLoader__.load({id: "dsh-browser-use", factory})` 加载
（esbuild 只把 TSX 编成 CJS 单文件，`__ModuleLoader__` 那层壳由
`scripts/wrap-client.mjs` 套上；本源码只导出 `apply` / `inject`）。

## 1. 右栏 Tab（已下线）

| 项 | 值 |
|---|---|
| tab 类型 `id` | ~~`dsh-browser-use`~~ 已删除 |
| tab `kind` | ~~`dsh-browser-use-browser`~~ 已删除 |
| 正文组件 | ~~`BrowserPanel`~~ 已删除 |
| 侧栏图标 | ~~`SidebarIcon`~~ 已删除 |

## 2. 服务端路由（已下线）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | ~~`/api/dsh-browser-use/status.json`~~ | 已删除（`src/index.ts` 不再注册任何 HTTP 路由） |
| GET | ~~`/api/dsh-browser-use/stream.mjpeg`~~ | 已删除（`src/screencast.ts` 已删除） |

## 3. 现在的用户看屏方式

浏览器是 headful 起在本机的**真实窗口**：用户直接看它、随时人工接管
（登录、验证码）。模型的视觉靠 `browser_take_screenshot` 工具，
截图经 `saveImageBlock` 以 `{type:'image', attachment}` 发给模型（真链路，
见 `src/compat/host.ts` 的图片块形状说明）。
