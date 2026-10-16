# 生成物说明（不要直接改这里）

本目录是 `dsh-browser-use` 插件的**构建产物拷贝**，不是维护入口。

- 权威源码：`~/workspace/dsh-browser-use`（Efar 维护的版本）
- 更新流程：在插件仓库改完 → `npm run verify` 全绿 → `npm run build` →
  把 `lib/`、`cordis.patch.yml`、`README.md` 拷到这里覆盖并提交
  （`lib/` 已纳入版本控制，CI 构建与 electron-builder 打包直接加载它）
- `package.json` 是 fork 侧的包装（`file:` 依赖用），改插件本身请去源码仓库

为什么是拷贝而不是 workspace 软链：dsh-desktop 的 `file:` 依赖 + electron-builder
打包要求包内容是普通目录；软链在 Windows 打包/安装时会出问题。

## 源码仓库不在同一台机器上的例外

2026-10-15 的 `inject` 修复就是在**这份拷贝**里改 `src/` 后用仓库根的
`tsc`/`esbuild` 重新生成 `lib/` 的（`npm run build`，插件自己的 devDependencies
需要先 `npm install`，产物文件清单与改动前逐字一致）。原因是权威源码仓库
`~/workspace/dsh-browser-use` 在这台机器上不存在，而 `lib/` 是宿主真正加载的东西，
手改产物比重新生成更危险。回到有源码仓库的机器时，请把同样的改动合过去，
并按上面的流程覆盖 `lib/`、`cordis.patch.yml`、`README.md`。
