/**
 * 构建前清掉 `lib/`。
 *
 * ## 为什么必须有这一步
 *
 * 三段构建**都不清目录** —— 那是刻意的：`tsc --emitDeclarationOnly` 写
 * `lib/types/`、esbuild 写 `lib/client.js`、`tsc -p tsconfig.server.json`
 * 写 `lib/**.js`，任何一个开 `clean` 都会把别人的产物删掉。
 *
 * 代价是**删掉一个源文件之后，它的旧产物会一直留在 `lib/` 里**：
 * tsc 只写不删，`npm pack` 又把 `files` 里那几条全收 —— 于是发布出去的包里
 * 会有一份「对应一个已经不存在的模块」的 js/d.ts，而它不会有任何东西报错。
 * 更糟的情况是它还能被 import 到（旧名字仍在某处被引用），于是运行时用的是
 * 一份没人维护的僵尸产物。
 *
 * 所以顺序是 **先清空、再构建**。
 * （沿用 dsh-qw-rrzu-ops 的 scripts/clean-lib.mjs。）
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const lib = fileURLToPath(new URL("../lib/", import.meta.url));

rmSync(lib, { recursive: true, force: true });
console.log("已清空 lib/");
