/**
 * 客户端常量测试（精简版）。
 *
 * 2026-10-15 右侧投屏面板下线：TAB_ID / PANEL_TITLE / TAB_KIND / 侧栏排序位 /
 * 引导页入口等 UI 常量已随面板一起删除，这个文件原来钉的那些全部作废。
 * 现在只钉三件还重要的事：
 *
 * 1. `PANEL_ID` 还是 `dsh-browser-use`（诊断日志里的身份，别改名）；
 * 2. `DIAGNOSTIC_PREFIX` 与 Host 侧是同一个约定（两边不一致就没法一起 grep）；
 * 3. `INJECT` 是空的 —— 客户端不注册任何 UI，不需要 Harness 注入任何服务；
 *    `package.json` 的 `dsh.client.inject` 同样是空的（别声明用不上的包）。
 * 4. ids.ts 必须**零 import**（它同时被 Host 与浏览器产物引用，
 *    浏览器产物的 require 白名单只有 react，多引一个东西客户端 bundle 就挂；
 *    这条由 `scripts/verify-client-bundle.mjs` 机械保证，这里只留一句提醒）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DIAGNOSTIC_PREFIX, INJECT, PANEL_ID } from '../src/client/ids.js'

describe('PANEL_ID：插件在诊断日志里的身份', () => {
  it('还是 dsh-browser-use（改名会断掉所有 grep 锚点）', () => {
    expect(PANEL_ID).toBe('dsh-browser-use')
  })

  it('与其他插件不撞车（不提 qw-rrzu-ops 那套名字）', () => {
    expect(PANEL_ID).not.toContain('rrzu')
  })
})

describe('INJECT：客户端不再需要任何服务', () => {
  it('是空数组（无界面：不注册 tab、不注册侧栏图标，什么都不需要注入）', () => {
    expect([...INJECT]).toEqual([])
  })

  it('package.json 的 dsh.client.inject 同样是空的（别声明用不上的包）', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { dsh: { client: { inject: string[] } } }
    expect(pkg.dsh.client.inject).toEqual([])
  })
})

describe('DIAGNOSTIC_PREFIX', () => {
  it('与 Host 侧同一个约定，便于一起 grep', () => {
    expect(DIAGNOSTIC_PREFIX).toBe('[dsh-browser-use]')
  })

  it('Host 侧日志真的用了这个前缀（两边不一致就没法一起 grep 了）', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    expect(src).toContain(DIAGNOSTIC_PREFIX)
  })
})

describe('ids.ts 必须零 import', () => {
  it('★ 这个文件被浏览器产物引用，多一个 import 客户端 bundle 就挂', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/client/ids.ts', import.meta.url)), 'utf8')
    // 去掉注释再找 import / require
    const code = src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
    expect(code).not.toMatch(/^\s*import\s/mu)
    expect(code).not.toMatch(/require\(/u)
  })
})
