# dsh-desktop fork：内嵌 Agent 浏览器

基于 `dataelement/dsh-desktop` 的 fork，加的是 Efar 要的"codex 式内嵌浏览器"：
桌面窗口右侧一块**真正的 Chromium 视图**（Electron WebContentsView），用户直接看、
直接点、随时接管；模型通过 CDP 在**同一个页面实例**上驾驶。面板打开时**主窗口按面板宽度
加宽**（不是把会话盖住），面板顶部有自己的标签条、地址栏和可拖拽的左边缘。

```
┌─ Electron 主窗口 ────────────────────────────┐
│  dsh 聊天 Web UI          │  Agent 浏览器      │
│  （主 webContents）        │  （WebContentsView │
│                          │   真实渲染，可点）  │
└──────────────────────────┴───────────────────┘
         ▲                            ▲
   dsh 子进程                   webContents.debugger
   （Harness runtime）                  │
                                 CDP relay (127.0.0.1 随机端口)
                                        ▲
                                 dsh-browser-use 插件
                                 （16 个 browser_* 工具，零改动，
                                  经 DSH_BROWSER_USE_CDP 连中继）
```

## 相对上游改了什么

| 文件 | 改动 |
|---|---|
| `src/main/agent-browser/cdp-relay.ts`（新） | CDP 中继：把 `webContents.debugger` 伪装成 Chrome DevTools HTTP+WS 端点（`/json/version`、`/json/list`、`/json/close/:id`、browser/page WS 会话）。不 import electron，可单测 |
| `src/main/agent-browser/agent-browser.ts`（新） | WebContentsView 生命周期：右侧停靠/隐藏/切换、独立持久化 partition（登录态在应用 userData 里）、首次 CDP 连接自动展开、popup 转新 tab |
| `src/main/index.ts` | bootstrap 里先起 agent browser 再起 dsh 子进程；View 菜单加「Agent 浏览器」开关（CmdOrCtrl+Shift+B）和「新建浏览器标签页」（CmdOrCtrl+Shift+T），后者与铬条「+」共用 `openAgentBrowserTab()`，菜单不需要另写一套停靠/地址逻辑 |
| `src/main/runtime/harness-runtime.ts` | `HarnessRuntimeOptions.extraEnv`：把 `DSH_BROWSER_USE_CDP=<中继端点>` 塞进 dsh 子进程环境变量 |
| `packages/dsh-browser-use/`（新） | 插件构建产物拷贝（权威源码在 `~/workspace/dsh-browser-use`，见 GENERATED.md），`file:` 依赖打进 asar |
| `build/dsh-desktop.patch.yml` | insert `dsh-browser-use` |
| `package.json` | 加 `dsh-browser-use: file:packages/dsh-browser-use` |
| `test/cdp-relay.test.ts`（新）、`test/runtime.test.ts` | 中继协议测试 + extraEnv 回归测试 |
| `packages/dsh-browser-use/src/index.ts` | `export const inject = ['tools']`：必需服务声明在模块上。宿主插入的 profile 行不带行级 `inject:`，dsh 也不消费它，裸读 `ctx.tools` 在 cordis 4 上抛 "without inject"；`apply` 同时不再兜住这个异常（静默零工具就是当初查不动的原因） |
| `src/shared/agent-browser.ts`（新） | 面板状态的跨进程契约 + IPC 载荷校验 |
| `src/main/agent-browser/agent-browser.ts` | 窗口按需解析（关到托盘再重开时重新停靠、清掉随旧窗口一起销毁的视图）；`toggle/setVisible` 返回真实结果；可见性变化回调；**修掉"隐藏"没把活动视图摘掉**导致的关不掉 |
| `src/shared/desktop-menu.ts`、`src/main/windows-menu.ts` | 新命令 `toggle-agent-browser`、`agent-browser-new-tab`，进 Windows 标题栏「视图」子菜单（那儿是菜单栏被强制隐藏时唯一看得见的地方）；两条都由 `WindowsMenuActions.agentBrowserAvailable()` 决定 `enabled`，本次运行没有面板可驱动时是灰的，不是点了没反应 |
| `src/preload/agent-browser-bridge.ts`（新） | `dsh-desktop:agent-browser-status/-toggle` 的窄桥：具名方法 + 订阅返回反注册，不暴露 ipcRenderer |
| `packages/dsh-desktop-client-ui/client.js` | `conversation.session.header.actions` 挂「显示/隐藏浏览器」按钮，状态由宿主推送驱动；非桌面或没有面板时不渲染 |
| `patches/@deepseek-ai+dsh+0.2.0-rc.2.patch` | 把 `dsh-browser-use` 补进 dsh 依赖闭包（`test/desktop-plugin-closure.test.ts` 的既有约束，fork 加插件时漏了这一项） |
| `test/browser-use-tool-activation.test.ts`（新） | 真实 loader + 临时 DSH_HOME + 宿主 file: URL 插入行：正向断言 16 个 `browser_*` 注册到位，反向断言缺 `tools` 服务时是带归属的 activate 失败而不是静默空注册 |
| `test/agent-browser-pane.test.ts`、`test/preload-agent-browser-bridge.test.ts`（新） | 面板停靠/重开/关掉的窗口生命周期；桥的通道、载荷校验与反注册 |
| `src/main/agent-browser/pane-layout.ts`（新） | 面板几何纯函数（不碰 Electron）：扩窗停靠并优先取有余量的一侧、宽度上下限、放不下就不停靠、铬条行高、拖拽后的还原条件 |
| `src/main/agent-browser/agent-browser.ts` | 面板变成"铬条 + 页面"两段视图：加宽/还原窗口、pane 状态推送、tab 开关与激活、地址栏导航（只允许 http/https 与 about:blank）、拖拽改宽；关标签时真的把原生视图从窗口摘掉 |
| `build/agent-browser-pane.html`、`src/preload/agent-browser-pane.ts`、`src/preload/agent-browser-pane-bridge.ts`（新） | 铬条是第二个 WebContentsView 上的独立页面：tab 条 + 地址栏 + 分隔条，桥只有 `getState/applyAction/onState` 三个具名方法（sandbox + contextIsolation），中英与深浅主题页内自洽，标题和 URL 一律 `textContent`；左边缘的把手常驻可见（14px 命中区 + 7×34 凹槽 pill），hover/聚焦/拖动只换色，pill 用 `aria-hidden` 保持分隔条只有一个可访问名 |
| `electron.vite.config.ts`、`package.json` | 第二个 preload 入口 `agent-browser-pane.cjs`；`agent-browser-pane.html` 进 `extraResources` |
| `src/shared/agent-browser.ts` | 面板契约：tab 列表、动作联合类型、三个通道名、载荷校验与地址解析（`localhost:3000` 这类环回按 http，其他无方案输入按 https） |
| `src/preload/agent-browser-bridge.ts` | 状态校验移进本模块：两个 preload 入口共享运行时模块会被 rollup 拆成 `./chunks/*.cjs`，sandbox preload 不能 require，实测连 `dshDesktop` 一起加载失败 |
| `test/agent-browser-pane-layout.test.ts`、`test/agent-browser-contract.test.ts`、`test/preload-agent-browser-pane-bridge.test.ts`、`test/preload-bundle-graph.test.ts`（新） | 几何与"加宽而非覆盖"、地址/动作契约、面板桥、preload 构建图守卫 |
| `test/agent-browser-pane-chrome.test.mjs`（新） | 铬条页面的 jsdom 回归：标题/提示一律 textContent、每个控件恰好一个声明动作、拒绝提示来自响应且不被无关推送抹掉、拖宽按帧合并取最新、双语双主题标签齐全 |
| `test/agent-browser-pane.test.ts`、`test/release.test.ts` | 加宽/还原、太窄拒绝停靠、关标签真的摘掉视图、拖拽宽度上限；铬条行高与 `pane-layout` 常量一致、HTML 随包 |

插件侧配合改动（在 `~/workspace/dsh-browser-use`，已合入）：
- `src/config.ts`：`DSH_BROWSER_USE_CDP` 环境变量兜底（显式 `cdpEndpoint` 优先）
- 去掉了右侧 MJPEG 假投屏面板（Efar 要求）：删 `src/screencast.ts`、两条 HTTP 路由、客户端 tab；
  `browser_take_screenshot` 保留（走 `{type:'image', attachment}` 真链路）

## 构建运行（Efar 本机）

```bash
cd dsh-desktop-browseruse
npm install          # 已含 electron 43
npm run typecheck
npx vitest run test/cdp-relay.test.ts test/runtime.test.ts
npm run dev          # 开发运行（看 docs/development.md）
```

## 2026-10-15 复盘：工具唤不出来、面板关不掉

导出会话（用户让模型「用 browser_navigate 打开 ops.rrzu.com」）里，模型的工具清单
**一个 `browser_*` 都没有**，只能退回 `skill agent-browser` + shell + `web_fetch`。
`harness.log` 每一启动都有一条：

```
[dsh-browser-use] 宿主能力缺失，插件不加载：cannot get property "tools" without inject
```

- 根因：插件的必需服务写在 `packages/dsh-browser-use/cordis.patch.yml` 的行级
  `inject:` 上，而桌面走的是 `build/dsh-desktop.patch.yml` → `desktop-host-sources.patch.yml`
  这条宿主插入路径，dsh 根本不消费行级 `inject:`；cordis 4 的 ctx 代理对没注入的服务名直接抛。
  当初 `apply()` 把这个异常兜住 `return`，于是「插件在跑、零工具」没有任何一处报错。
- 右侧真实浏览器另有两条：dsh UI 里的投屏 tab 已按需求删除（客户端现在是**无界面**），
  原生面板唯一入口是 View 菜单项，而 Windows 上菜单栏被强制隐藏 → 界面上找不到；
  加上 `toggle` 只 detach 非活动视图，"隐藏"从来没生效过。
- 修的方向：必需服务声明进模块（`export const inject`）、失败必须可归属、
  入口进宿主插件 slot + Windows 标题栏「视图」、面板跟随当前窗口而不是启动那一刻的窗口。

## 在这台机器上已验证 / 未验证


已验证：
- `npm run typecheck` 通过
- `test/cdp-relay.test.ts`（2 tests）：按插件真实调用序列走完全链路
- 插件**真实** `CdpConnection`/`BrowserHub` 代码连中继：attach → createTarget →
  /json/list → page WS → `Runtime.evaluate` 全通
- `test/runtime.test.ts`（61 tests）：extraEnv 回归在内
- 插件 `npm run verify` 全绿（85 tests：类型检查、单测、重新构建 `lib/`、客户端产物与打包自查）
- `test/browser-use-tool-activation.test.ts`：**真实 loader + 临时 DSH_HOME + 宿主 file: URL 插入行**，
  正向钉住 16 个 `browser_*` 注册到位，反向钉住缺 `tools` 服务时是带归属的 activate 失败
- `test/agent-browser-pane.test.ts`（6 tests）：停靠、重开重新接线、隐藏真的摘掉视图、过窄加宽、可见性回调
- `test/preload-agent-browser-bridge.test.ts`（4 tests）：通道、脏载荷不进按钮、反注册用同一个函数身份
- `test/desktop-client-ui.test.ts`（4 tests）：会话头按钮按真实状态渲染/切换/卸载，非桌面与无面板时不渲染
- `test/windows-titlebar.test.ts`、`test/desktop-plugin-closure.test.ts`：标题栏「视图」项与依赖闭包

未验证（必须在你机器上真跑起来看）：
- 真实 Electron 里的 IPC 与布局：会话头按钮点得动、标题栏「视图 → Agent 浏览器」可见可用；
  上面的面板用例是 Electron 接口替身，不能证明真窗口和真 IPC 已经通过
- 关掉窗口到托盘再重开，面板是否真的跟着新窗口重新停靠（逻辑已有回归，视图本身要看）
- Electron 窗口右侧是否真的出现浏览器视图、布局是否正常
- 模型调 `browser_navigate` 时面板是否自动展开
- 用户直接在视图里点/输，模型侧快照是否同步变化
- `webContents.debugger` 在各平台 attach 是否稳定（已知：开着 DevTools 会 attach 失败，
  我们没在 agent 视图上开 DevTools）
- 登录态持久化（partition `persist:agent-browser`）
- 打包（electron-builder）未跑

## 2026-10-15 第二轮复盘：面板挡住了会话，还没有 tab 和地址栏

反馈三条，各自对应一个结构性原因，不是同一处代码没写好：

- **原生子视图是覆盖在页面之上的。** `WebContentsView` 不会把 dsh 页面挤窄，页面也不知道
  有东西压在它身上。所以"不遮挡"只有一个解法：打开面板时把**窗口**加宽面板那么多，关闭时
  还原；余量不足（最大化、贴着屏幕边、显示器就这么宽）才退化为在现有宽度里分一侧，并且
  保证会话区不被压到最小宽度以下——放不下就干脆不 docking（`setVisible` 返回 false，
  按钮状态保持诚实）。判定全在 `src/main/agent-browser/pane-layout.ts`，纯函数、可单测。
- **标签条和地址栏不能画在 dsh 页面里。** 那块区域正是原生页面视图要盖住的地方，任何 DOM
  （包括 `position: fixed`）都会被压掉。于是铬条是第二个 `WebContentsView`，占面板顶部
  72 DIP，被驾驶的页面从 72 起画。行高常量与 `build/agent-browser-pane.html` 里的高度由
  `test/release.test.ts` 钉在一起，防止两边悄悄分叉。宽度可以用左边缘拖，拖动只在
  `requestAnimationFrame` 上合并，权威钳制在 main。
- **从 map 里删掉视图不等于从窗口里摘掉。** 关闭标签后没人再碰那个已脱离 `views` 的原生视图，
  它会一直糊在面板上（回归表现为"隐藏之后还剩一个视图"）。现在 `detachView` 统一负责窗口侧
  摘除，`closeTarget` / `pruneDestroyedViews` / `detachAllViews` 共用它。

一个只有构建产物才暴露的坑（值得记住）：加了第二个 preload 入口之后，
`src/shared/agent-browser.ts` 被两个入口**值导入**，rollup 把它拆成
`out/preload/chunks/*.cjs`，而 sandbox preload 不能 require 相对 chunk —— 实测报
`module not found: ./chunks/agent-browser-*.cjs`，而且 `out/preload/index.cjs` 也被一起
拖挂，整个 `dshDesktop` 桥消失（页面按钮、标题栏桥全断）。修法是状态校验留在
`agent-browser-bridge.ts` 自己那份，两个入口不共享运行时模块；
`test/preload-bundle-graph.test.ts` 守这条构建图规则（往 `agent-browser-bridge.ts`
加一行值导入就能看到它报错，已验证过它确实会红）。

已验证（本轮实际跑过）：
- `npm run typecheck`、`npm run build`：两个 preload 产物都是单文件，`require('./…')` 为 0
- 隐藏窗口 + `sandbox: true` 的真实 Electron 探针加载 `out/preload/agent-browser-pane.cjs`：
  `window.dshAgentBrowserPane` 注入成功，方法恰为 `applyAction,getState,onState`，无 preload-error
- `test/agent-browser-pane-layout.test.ts`（14）：加宽方向选择、余量不足、最大化、放不下拒绝、
  还原条件（用户改过窗口就不还原）、铬条/页面两块矩形
- `test/agent-browser-pane.test.ts`（19）：停靠与摘除、加宽/还原、拖宽钳制、关标签真的摘掉视图、
  tab 开/切/关、地址栏导航与拒绝 `file:`/`javascript:`/`data:`/凭据链接、可信发送方只有铬条
- `test/agent-browser-contract.test.ts`、`test/preload-agent-browser-pane-bridge.test.ts`、
  `test/preload-bundle-graph.test.ts`、`test/release.test.ts`（铬条行高一致 + HTML 随包）
- `test/agent-browser-pane-chrome.test.mjs`（16）：jsdom 里真实执行页面脚本，覆盖注入防护、
  手势映射、拒绝提示的存活与清除、拖宽的 rAF 合并、双语双主题、无桥时的自述
- 全量 `npm test`：181 个文件通过（新增 5 个文件），失败仍是既有的 4 个环境用例
  （`python3` 缺失 9 例、无 `.git` 导致 `git ls-files` 失败 1 例）

仍未验证（必须在你机器上真跑起来看）：
- 铬条在真窗口里的视觉与交互：tab 溢出滚动、拖左边缘改宽的手感、地址栏回车、深浅主题与中英文
- 多显示器 / 贴边 / 最大化下"加宽窗口"的实际表现（目前只有纯函数与替身窗口证据）
- 真会话里模型开 tab → 铬条出现该 tab、用户直接在页面点选的联动
- 打包安装后 `agent-browser-pane.html` 与 `agent-browser-pane.cjs` 是否真随包生效（仅静态断言）
## 2026-10-15 第三轮复盘：把手要 hover 才出现，新建标签页只能点「+」

方向对了（加宽窗口、tab 条、地址栏），但两处使用体验是设计上没定清楚：

- **只在 hover 时出现的 splitter，等于没有 splitter。** 左边缘原来只有 1px 的 `--line`，
  用户不知道那里能拖，就永远不会去拖。现在 `.grab` 是 14px 的命中区，里面常驻一枚 7×34 的
  凹槽 pill（`--surface-raised` 底 + 两条 `--grip` 竖槽），hover / 键盘聚焦 / 拖动中只把颜色
  换成 `--accent`，不改可见性——命中区比图形宽，是为了好抓，不是为了看起来宽。
  pill 是 `aria-hidden` 的纯装饰：`role="separator"` 自己带 `aria-label`，再念一次就变成
  两个名字。tab 条左边留出 18px（>命中区 14px），免得「+」和拖拽抢同一块像素。
- **菜单命令必须和「+」共用一条路径，而不是自己再开一个 tab。** `agent-browser-new-tab`
  （Ctrl/Cmd+Shift+T）只发 `{ type: 'new-tab', url: '' }`，空 URL 就是「+」的语义
  （`about:blank`）；地址规则、面板停靠、状态推送全走 `applyPaneAction`。面板关着时它负责
  把面板重新停靠，而不是偷偷开一个用户看不见的 tab——否则菜单和界面会各自长出一套行为。
- **能力不存在就不该能点。** 标题栏「视图」的两条面板命令由 `agentBrowserAvailable()` 决定
  `enabled`（本次运行有没有 agent browser 面板），macOS/Linux 的原生 View 菜单同样处理；
  灰掉是诚实的反馈，点了没反应不是。

已验证（本轮实际跑过）：
- `npm run typecheck`、`npm run build`：`out/preload/` 仍是两个单文件，`require('./…')` 为 0
- `test/windows-titlebar.test.ts`（8）：双语标签、两条命令都进「视图」组、两条快捷键，
  以及反向用例——没有面板时两条命令 `enabled: false`，而 `Reload` 仍然可用
- `test/agent-browser-pane.test.ts`（20）：新用例钉住菜单路径——面板已隐藏时
  `{ type: 'new-tab', url: '' }` 会重新停靠并开出一个 `about:blank` 活动 tab
- `test/agent-browser-pane-chrome.test.mjs`（17）：新用例钉住把手常驻可见（静态规则里就画得出来，
  不靠 `:hover`）、pill 对可访问名没有贡献、命中区仍宽于图形，以及拖拽依旧只发 `set-pane-width`
- 全量 `npm test`：182 个文件通过、1702 个用例通过；失败仍是既有的 4 个环境用例
  （缺 `python3` 9 例、无 `.git` 导致 `git ls-files` 失败 1 例），与本轮改动无关

仍未验证（本轮）：
- 真窗口里这条把手的实际观感：pill 在深浅主题下的对比度、Windows 上 `ew-resize` 光标与会话区
  边缘是否重叠、拖动时原生视图重绘是否跟手。jsdom 只证明规则常驻存在，不证明它好看
- 键盘聚焦到把手后用方向键改宽，在真窗口里焦点是否真的能落到那条边缘上