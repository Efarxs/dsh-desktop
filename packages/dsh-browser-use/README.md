# dsh-browser-use

deepseek-harness 插件：给模型一套 Codex 式的浏览器操控能力。

- 插件单独启动用户本机装的 Chrome / Edge（独立 profile，登录态持久化，不碰日常浏览器）
- 模型通过 24 个 `browser_*` 工具操控页面：导航 / 快照 / 点击 / 输入 / 按键 / 悬停 / 下拉 / 截图 / 等待 / 后退 / 标签页 / 对话框 / JS 求值（默认关）/ 快照搜索 / 批准站点 / 状态，以及页面信息、元素读取、选择器等待、URL 等待、滚动、拖动、勾选、文件上传
- 决策主通道是 CDP `Accessibility.getFullAXTree` 快照（`[ref=eN]` 元素编号，CDP 原生没有 ref，是插件自己编的）
- 浏览器是 headful 起在本机的**真实窗口**：用户直接看它、随时人工接管（登录、验证码）；模型的视觉靠 `browser_take_screenshot`（经 saveImageBlock 发 `{type:'image', attachment}` 真链路）

## 安装

把 `dsh-browser-use-0.1.0.tgz` 按你们现有插件的方式装进 harness 即可。
本机需要装好 Chrome 或 Edge（harness 跑在服务器上时，就是服务器本机）。

## 配置（插件配置项）

| 项 | 默认 | 说明 |
|---|---|---|
| `browser` | `auto` | `auto` / `chrome` / `edge`。auto 时优先 Edge（Windows 上必装） |
| `workDir` | 空 = `<DSH_HOME>/browser-use` | 插件数据目录（profile、日志都落这儿） |
| `browserProfileDir` | 空 = `<workDir>/browser-profile` | 独立浏览器 profile 目录，登录态保存在这里 |
| `startUrl` | `about:blank` | 启动后打开的页面 |
| `cdpEndpoint` | 空 | 非空时优先连这个 CDP 端点，连不上再自己起（调试/多插件共用时用） |
| `allowedOrigins` | `[]` | 预批准的站点 origin，例如 `https://ops.rrzu.com` |
| `newOriginPolicy` | `ask` | 遇到未批准站点时：`ask`（抛 NEEDS_APPROVAL，请模型问用户）/ `allow`（自动放行）/ `deny`（拒绝） |
| `allowEvaluate` | `false` | 是否允许 `browser_evaluate`（任意 JS，等价 codex 的 full_cdp_access，默认关） |

> `screencast` 配置项还保留在配置结构里（历史遗留），但投屏功能已在 2026-10-15 下线，
> 改它没有任何效果。

## 工具一览（24 个）

| 工具 | 作用 |
|---|---|
| `browser_navigate` | 打开 URL（未批准站点先走审批），返回新快照 |
| `browser_snapshot` | 当前页 AX 快照（`[ref=eN]`），做任何操作前先看它 |
| `browser_click` | 点 ref 元素（左/右键、双击），返回新快照 |
| `browser_type` | 往 ref 输入框输文本（支持中文，可清空/回车提交），返回新快照 |
| `browser_press_key` | 按键（Enter/Tab/方向键/单字符…），可先聚焦某个 ref |
| `browser_hover` | 悬停，返回新快照 |
| `browser_select_option` | 下拉框选值，返回新快照 |
| `browser_take_screenshot` | JPEG 截图（视口/全页），供视觉确认 |
| `browser_wait_for` | 等文本出现或等时长（≤30s） |
| `browser_navigate_back` | 后退，返回新快照 |
| `browser_tabs` | list / new / select / close 标签页 |
| `browser_handle_dialog` | 处理 alert/confirm/prompt（页面有未处理对话框会阻塞操作） |
| `browser_evaluate` | 执行 JS 取返回值（默认关闭，需开 `allowEvaluate`） |
| `browser_find` | 在快照里按关键字搜片段（快照太长时先用它） |
| `browser_approve_origin` | 用户说"允许"后，模型调它批准某站点（本会话有效） |
| `browser_status` | 浏览器状态：运行中/URL/标题/待处理对话框 |
| `browser_page_info` | 当前页面 URL、标题、视口、页面尺寸和滚动位置 |
| `browser_read_element` | 按 CSS 选择器读取元素内容、值、属性和可见性 |
| `browser_wait_for_selector` | 等待 CSS 元素出现、挂载或隐藏 |
| `browser_wait_for_url` | 等待 URL 片段或正则匹配 |
| `browser_scroll` | 按像素滚动或滚动到指定元素 |
| `browser_drag` | 按坐标拖动鼠标完成滑块/拖放操作 |
| `browser_check` | 勾选或取消 checkbox/radio |
| `browser_upload` | 设置 file input 的本机文件 |

典型一轮：`browser_navigate` → `browser_snapshot` → `browser_click`/`browser_type` → 新快照 → …
每次动作后都返回新快照，保持 sense-plan-act 闭环（跟 codex 一样，不是看视频流做决策）。

## 站点审批流程

1. `browser_navigate https://新站点/...` → 抛错 `NEEDS_APPROVAL:origin=https://新站点`
2. 模型把"要不要访问 https://新站点"问用户
3. 用户说允许 → 模型调 `browser_approve_origin(origin=https://新站点)`
4. 模型重试 `browser_navigate`

`allowedOrigins` 里预填的站点跳过审批；`newOriginPolicy=allow` 全放行，`=deny` 全拒绝。

## 用户看屏（2026-10-15 已下线右侧面板）

原来右侧边栏有个「远程浏览器」tab（MJPEG 投屏），已删除 —— 它只是 view-only 的镜像，
不是 codex 式的内嵌控制，留着是自欺欺人。

现在：浏览器是 headful 启动的**真实窗口**，用户在本机直接看它、随时人工接管
（比如首次登录、输验证码）。模型的视觉靠 `browser_take_screenshot` 工具，
截图经 `saveImageBlock` 以 `{type:'image', attachment}` 发给模型（真链路）。

装进 DSH Desktop 时另有宿主自带的内嵌面板（CDP 中继 + 右侧 WebContentsView）：打开时
**主窗口按面板宽度加宽**，面板顶部是宿主自己的标签条和地址栏（可多标签、左边缘有一直看得见的
拖拽把手调宽度、可在地址栏输入 http/https 网址）。入口是会话头的「显示/隐藏浏览器」按钮、
标题栏「视图 → Agent 浏览器」（`Ctrl+Shift+B`）和「视图 → 新建浏览器标签页」
（`Ctrl+Shift+T`，面板没打开时会先把它打开）。那是宿主的能力，本插件的客户端仍然**无界面**，
`browser_*` 工具在两种形态下是同一套。

## 安全边界

- 浏览器只监听 `127.0.0.1`，CDP 端口随机，不对外暴露
- `browser_evaluate` 默认关闭；开了也只在被操控的页面里跑
- 站点访问按 origin 审批；独立 profile 与日常 Chrome 完全隔离
- 敏感输入（密码/验证码/支付）请用户直接在弹出的浏览器窗口里操作，不要经聊天发

## 能力矩阵（相对 playwright-mcp v0.0.83 的 72 工具）

已实现核心 24 工具（对标它的默认 24 里最常用的子集）。
未实现：console/network 监听、文件上传、坐标点选（vision）、cookie/storage 读写、
PDF、录制/tracing、测试断言类工具。需要的话按这个清单继续补。

## 待在真实 harness 上验证

- `browser_take_screenshot` 的图片内容块模型侧能否看到（不支持图片的模型走纯文本降级）
- 插件配置页字段是否正常读取
- 关掉 dsh 再开（浏览器是 detached 的，进程还在）：应当**复用**上一个实例，
  而不是又起一个撞 SingletonLock

## 开发

```bash
npm install
npm run verify   # 类型检查 → 单测 → 构建 → 产物自查 → 打包自查（一条命令全绿才算完）
```

`npm run verify` 串了五段，任何一段红了都不该打包：

| 命令 | 干什么 |
|---|---|
| `npm run check` | `tsc --noEmit` + `tsc -p tsconfig.test.json`（含 test/ 与 vitest.config.ts） |
| `npm run test` | vitest，`test/` 下的纯函数与契约测试（不需要 Harness、不需要真浏览器） |
| `npm run build` | 清 `lib/` → tsc 出 `.d.ts` → tsc 出 host 侧 `.js` → esbuild 打客户端 → 套 `__ModuleLoader__` 壳 |
| `npm run check:client-bundle` | 断言客户端产物只 require react、`apply`/`inject` 都在 |
| `npm run verify:package` | `npm pack --dry-run`，断言该进包的文件都在（glob 匹配不到东西是不报错的） |

单独跑：

```bash
npm run build && npm pack        # 出 tgz
npm run check:client-bundle
npm run verify:package
```

⚠️ `npm run build` 会**先清空 `lib/`**，所以每次 `npm pack` 前都要先 build
（`prepack` 已经串上了，直接 `npm pack` 就会自动构建）。

### 测试覆盖到哪一层

只覆盖**不需要环境**的那些：origin 审批、配置归一、浏览器探测与启动参数、
DevToolsActivePort 的陈旧值判定、宿主契约适配（`withConnection` 的时机、图片块形状、
路由返回值归一）、以及客户端常量的基本断言。

真浏览器、真 CDP、界面渲染不在这里测 —— 那要靠真机装进 QuWork 看，
见下面「待在真实 harness 上验证」。
