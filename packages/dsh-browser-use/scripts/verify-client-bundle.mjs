/**
 * 客户端 bundle 自查。
 *
 * ## 这个项目里唯一挡「浏览器产物引到 node 模块」的机械保证
 *
 * 客户端代码跑在**浏览器**里，能拿到的只有 Harness 注入的那个 `require`，
 * 而它只认 `react` / `react/*`。一旦有人在 `src/client/` 里 `import` 了
 * `node:fs`、`@deepseek-ai/dsh-home-paths` 之类，构建**照样成功** ——
 * esbuild 会把它们打进 bundle，页面里一加载就报「require 了白名单之外的模块」，
 * 整个界面 tab 静默消失。
 *
 * dsh-qw-rrzu-ops 的 routes.ts 文件头记着一次真实事故：客户端插件引到
 * `@deepseek-ai/dsh-home-paths`，整个客户端在浏览器里不加载。那次就是这条断言
 * 当场拦下来的。
 *
 * ## 断言的三条
 *
 * 1. 壳在（`__ModuleLoader__.load`）；
 * 2. `require(...)` 的实参只有 react 家族；
 * 3. 两个导出都在（`apply` / `inject`）—— Harness 按这两个名字调它。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Harness 客户端 bundle 允许 require 的模块。 */
const ALLOWED = [/^react$/, /^react\//];

const target = fileURLToPath(new URL("../lib/client.js", import.meta.url));

let source;
try {
  source = readFileSync(target, "utf8");
} catch {
  console.error("❌ 读不到 lib/client.js —— 先跑 npm run build。");
  process.exit(1);
}

const failures = [];

if (!source.includes("window.__ModuleLoader__.load(")) {
  failures.push("缺少 __ModuleLoader__.load 壳（scripts/wrap-client.mjs 没跑？）");
}

for (const match of source.matchAll(/require\((["'])([^"']+)\1\)/gu)) {
  const spec = match[2];
  if (!ALLOWED.some((re) => re.test(spec))) {
    failures.push(`require 了白名单之外的模块：${spec}`);
  }
}

for (const need of ["apply", "inject"]) {
  // 壳里导出名可能是压缩过的引用，但 `exports.apply` / `apply: () => apply` 一定在。
  if (!new RegExp(`\\b${need}\\b`).test(source)) failures.push(`产物里找不到导出 ${need}`);
}

if (failures.length > 0) {
  console.error("❌ lib/client.js 不合规：");
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}

console.log("✅ lib/client.js 合规（壳在、只 require react、apply/inject 都在）。");
