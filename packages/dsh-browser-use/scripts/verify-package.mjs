/**
 * 打包前自查：`npm pack` **实际会收哪些文件**，以及里面有没有该在的东西。
 *
 * ## 为什么值得单独一条脚本
 *
 * `package.json` 的 `files` 是一组 glob，而 **glob 匹配不到东西时不报错**。
 * 也就是说：把 `lib/client.js` 写成 `lib/clients.js`，`npm pack` 照样成功，
 * 发布出去的包少了整个浏览器产物 —— 装到用户机器上才炸，且症状是
 * 「界面没挂上」，跟"文件打错了名"隔了十万八千里。
 *
 * 同一类问题还有：`cordis.patch.yml` 忘了列进去（插件装上了但配置层不生效）、
 * `lib/types/**\/*.d.ts` 因为构建顺序问题没生成（用 TS 的人拿不到类型）。
 *
 * 所以这里做两件事：
 *   1. 列一遍将要进包的文件，给人看；
 *   2. 断言几份**少了就一定出事**的文件在里面。
 *
 * ## 为什么不 execFile("npm", ...)
 *
 * Windows 上 npm 是 `npm.cmd`，`execFileSync("npm")` 直接 ENOENT；
 * 换成 `npm.cmd` 又会 EINVAL（Node 不允许无 shell 直接执行 .cmd）。
 * 所以这里走 `shell: true`，并且**不传数组** —— 数组 + shell 会触发
 * Node 的 DEP0190（参数不会被转义）。自己拼一条不含用户输入的固定命令行即可。
 *
 * 用 `--dry-run --json` 而不是解析人的输出：前者是稳定接口，后者随 npm 版本变。
 * （沿用 dsh-qw-rrzu-ops 的 verify:package。）
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** 少了就一定出事的文件。每一条都对应一种"能装上但不好使"。 */
const REQUIRED = [
  "package.json", // npm 自己必须有
  "lib/index.js", // host 入口（exports "."），少了插件根本不加载
  "lib/client.js", // 浏览器入口（exports "./client"），少了界面不挂
  "lib/types/index.d.ts", // exports "." 的 types 指向它
  "lib/types/client/index.d.ts", // exports "./client" 的 types 指向它
  "cordis.patch.yml", // dsh.bundle.patch 指向它，少了配置层不生效
  "README.md", // 用户在插件市场里看到的那份说明
];

/*
  整个命令行是写死的常量，没有任何外部输入拼进来，
  所以 shell: true 在这里不引入注入面（DEP0190 针对的是拼接不可信参数）。

  `--ignore-scripts` 刻意加上：`npm pack` 默认会跑 prepack（也就是整条 build）。
  本脚本是 `verify` 链里 build **之后**的一环，再构建一次纯属浪费，
  而且会掩盖"build 根本没跑过"这个真正要报的错。
*/
const raw = execSync(
  "npm pack --dry-run --json --ignore-scripts --cache .npm-cache",
  {
    cwd: root,
    encoding: "utf8",
    // npm 的进度/警告会污染 stdout 的 JSON，这里丢掉。
    stdio: ["ignore", "pipe", "ignore"],
  },
);

// `npm pack --json` 的 stdout 是"一个含单个报告对象的数组"。
const report = JSON.parse(raw)[0];
const files = report.files.map((f) => f.path.replace(/\\/gu, "/"));
const present = new Set(files);

console.log(`将进包 ${files.length} 个文件，共 ${(report.size / 1024).toFixed(1)} KiB：\n`);
for (const f of files.sort()) console.log(`  ${f}`);

const missing = REQUIRED.filter((r) => !present.has(r));
if (missing.length > 0) {
  console.error(`\n❌ 该在包里但不在（检查 package.json 的 files 与构建是否跑过）：`);
  for (const m of missing) console.error(`   ${m}`);
  process.exit(1);
}

/*
  反向检查：`src/` 是**故意**进包的（dsh-qw-rrzu-ops 同款做法）——
  插件市场里点开能读源码，装到别人机器上也一样。这里只确认它没有被
  `files` 整个漏掉（漏了就会出现"装上了但读不到源码"的半截状态）。
*/
const srcDeclared = (pkg.files ?? []).some((g) => String(g).startsWith("src"));
if (srcDeclared && !files.some((f) => f.startsWith("src/"))) {
  console.error("\n❌ files 里声明了 src/，但一个源文件都没打进包。");
  process.exit(1);
}

console.log(`\n✅ 该在的都在（${REQUIRED.length} 项断言全过）。`);
