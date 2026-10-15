/**
 * 把 esbuild 打出来的客户端产物，包成 Harness 网页端认识的加载形式。
 *
 * ## 为什么必须有这一步
 *
 * Harness 的网页端加载插件界面，用的**不是** ESM `import`，而是页面里那个
 * `window.__ModuleLoader__.load({ id, factory })`。`factory` 拿到一个
 * `require` 函数当作参数，用 CommonJS 的写法取依赖。
 *
 * 直接 `--format=iife` 或 `--format=esm` 都不对：前者拿不到那个 `require`，
 * 后者根本不会被 `__ModuleLoader__` 认。所以 esbuild 只负责**把 TSX 编成
 * CJS 并打成一个文件**，外面那层 `load({...})` 的壳由这里套上。
 *
 * 形态与 `dsh-qw-rrzu-ops` / `dsh-qw-order-desktop` 的 tsdown banner/footer
 * 完全一致（那几个项目用 tsdown，本插件用 esbuild，产物形状必须对得上）：
 *
 * ```js
 * /* DSH compatibility bundle: XXX-CLIENT-1 *\/
 * window.__ModuleLoader__.load({
 *   id: "包名",
 *   factory: (require) => {
 *     <esbuild 的产物，整体缩进两个 tab>
 *     return module.exports;
 *   }
 * });
 * ```
 *
 * ## 为什么要补 `var module`
 *
 * esbuild 的 `--format=cjs` 产物只有 `module.exports = ...` 一行赋值，
 * **不声明 `module`** —— 它假设外面已经有 CommonJS 的 `module`/`exports` 了。
 * 而 Harness 的 `factory(require)` **只给 `require`**，不给 `module`。
 * 所以 `var module = { exports: {} }; var exports = module.exports;` 这两句
 * 必须由这里补进去（tsdown 那边是它的 `intro` 选项，同一个作用）。
 *
 * 不补的后果：页面里加载时报 `module is not defined`，整个界面 tab 消失。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BUNDLE_MARKER = "DSH-BROWSER-USE-CLIENT-1";

/** Harness 客户端 bundle 的 require 白名单。 */
const ALLOWED_REQUIRES = [/^react$/, /^react\//];

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
const target = fileURLToPath(new URL("../lib/client.js", import.meta.url));

/** 包名 —— 必须与 `package.json` 的 name 一致，Harness 按它认这份产物。 */
const packageId = pkg.name;

const raw = readFileSync(target, "utf8");

if (raw.includes("__ModuleLoader__")) {
  // 幂等：重复跑不会套第二层壳。
  console.log("client.js 已经是包装过的，跳过。");
  process.exit(0);
}

const indented = raw
  .split("\n")
  .map((line) => (line.length > 0 ? `\t\t${line}` : line))
  .join("\n")
  // esbuild 的产物以换行结尾，拼壳时把那个空行去掉，免得壳里多一行空白。
  .replace(/\n+$/u, "");

/*
  `var module` / `var exports` 由这里补 —— esbuild 的 cjs 产物不声明它们，
  而 Harness 的 factory 只给 require。理由见文件头。
*/
const wrapped = `/* DSH compatibility bundle: ${BUNDLE_MARKER} */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(packageId)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${indented}
\t\treturn module.exports;
\t}
});
`;

assertWrapped(wrapped);
writeFileSync(target, wrapped);
console.log(`已包装 lib/client.js（id: ${packageId}）`);

/**
 * 自查：套完壳的产物必须满足的几件事。
 *
 * 这些断言不是形式主义 —— 每一条都对应一种"能构建出来但一加载就废"的产物：
 * 少 `return module.exports`（导出全空）、多一层 `var module`（重复声明直接
 * 语法错误）、或者混进了白名单外的 require（Harness 拒绝加载该 bundle）。
 */
function assertWrapped(source) {
  const fail = (why) => {
    console.error(`client.js 包装失败：${why}`);
    process.exit(1);
  };
  if (!source.includes("window.__ModuleLoader__.load(")) fail("缺少 __ModuleLoader__.load 壳");
  if (!source.includes("return module.exports;")) fail("缺少 return module.exports");
  if (!new RegExp(`id: ${JSON.stringify(packageId).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`).test(source)) {
    fail(`壳里的 id 不是 ${packageId}`);
  }
  // esbuild 自己会生成一份 `var module = { exports: {} }`；壳里不能再有第二份。
  const moduleDecls = source.match(/var module = \{ exports: \{\} \};/gu) ?? [];
  if (moduleDecls.length !== 1) {
    fail(`var module 声明了 ${moduleDecls.length} 次（必须恰好 1 次）`);
  }
  for (const match of source.matchAll(/require\((["'])([^"']+)\1\)/gu)) {
    const spec = match[2];
    if (!ALLOWED_REQUIRES.some((re) => re.test(spec))) {
      fail(`require 了白名单之外的模块：${spec}（只允许 react 与 react/*）`);
    }
  }
}
