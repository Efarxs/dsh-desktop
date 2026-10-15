/**
 * 客户端常量（精简版）。
 *
 * 2026-10-15 右侧投屏面板下线后，这里只剩客户端真正还用的东西：
 * 插件身份与诊断前缀。TAB_ID / PANEL_TITLE / 侧栏排序位等 UI 常量已随面板一起删除。
 *
 * 单独成模块且**零 import**：这个文件同时被 Host 与浏览器产物引用，而浏览器产物的
 * require 白名单只有 react —— 它多引一个东西，客户端 bundle 校验就挂。
 * （沿用 dsh-qw-rrzu-ops 的 ids.ts 约定。）
 */

/** 插件短 id：诊断日志用它。不要与 "qw-rrzu-ops" 撞车。 */
export const PANEL_ID = "dsh-browser-use";

/** 客户端声明需要的 Harness 服务：无界面，不需要任何服务。 */
export const INJECT: readonly string[] = [];

/** 诊断行的前缀，与 Host 侧保持同一个约定，便于一起 grep。 */
export const DIAGNOSTIC_PREFIX = "[dsh-browser-use]";
