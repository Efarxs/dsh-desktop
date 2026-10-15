/**
 * 配置归一与 origin 解析的测试。
 *
 * ## 为什么这一层要测
 *
 * `resolveConfig` 的每一行都是**"用户填错了会怎样"**的处理，而它错了不会报错、
 * 只会静默生效：
 * - `quality: 0`（有人会以为 0 = 无损）若不夹到 1，`Page.startScreencast` 收到
 *   非法质量后**整个投屏不推帧**，面板上一片空白，看不出跟配置有关；
 * - `maxWidth: 99999` 会让 JPEG 编码慢到投屏卡成 PPT；
 * - `allowedOrigins` 里混进非字符串（YAML 里写错缩进就会）若不滤掉，
 *   `check()` 里的 `includes` 永远不命中，用户配的站点形同没配；
 * - `newOriginPolicy` 拼错（`asking` / `Ask`）必须回落到最安全的 `ask`，
 *   **绝不能回落到 `allow`**。
 *
 * 纯函数，不需要 Harness、不需要浏览器 —— 出错代价却全在用户侧。
 */
import { describe, expect, it } from 'vitest'

import { originOf, resolveConfig, resolveProfileDir } from '../src/config.js'

const HOME = 'C:/dsh-home'

describe('resolveConfig', () => {
  it('空配置 = 全部默认值，workDir 落到 homeDir', () => {
    const c = resolveConfig({}, HOME)
    expect(c.workDir).toBe(HOME)
    expect(c.browser).toBe('auto')
    expect(c.newOriginPolicy).toBe('ask')
    expect(c.allowEvaluate).toBe(false)
    expect(c.startUrl).toBe('about:blank')
    expect(c.cdpEndpoint).toBe('')
    expect(c.screencast).toEqual({ enabled: true, quality: 70, maxWidth: 1280, everyNthFrame: 2 })
  })

  it('传进来的东西整个不是对象时也不炸', () => {
    for (const raw of [null, undefined, 42, 'x', []]) {
      expect(resolveConfig(raw, HOME).workDir).toBe(HOME)
    }
  })

  it('超出范围的质量/宽度/帧率被夹到合法区间', () => {
    const c = resolveConfig({ screencast: { quality: 0, maxWidth: 99999, everyNthFrame: 99 } }, HOME)
    expect(c.screencast.quality).toBe(1)
    expect(c.screencast.maxWidth).toBe(3840)
    expect(c.screencast.everyNthFrame).toBe(10)

    const lo = resolveConfig({ screencast: { quality: 999, maxWidth: 1, everyNthFrame: 0 } }, HOME)
    expect(lo.screencast.quality).toBe(100)
    expect(lo.screencast.maxWidth).toBe(320)
    expect(lo.screencast.everyNthFrame).toBe(1)
  })

  it('NaN / Infinity 这类"是 number 但不是合法值"的要落回默认', () => {
    const c = resolveConfig({ screencast: { quality: Number.NaN, maxWidth: Number.POSITIVE_INFINITY } }, HOME)
    expect(c.screencast.quality).toBe(70)
    expect(c.screencast.maxWidth).toBe(1280)
  })

  it('枚举值拼错时回落到安全默认（策略绝不能落到 allow）', () => {
    expect(resolveConfig({ browser: 'Chrome' }, HOME).browser).toBe('auto')
    expect(resolveConfig({ browser: 'firefox' }, HOME).browser).toBe('auto')
    for (const bad of ['asking', 'Ask', 'ALLOW ', '', 1]) {
      expect(resolveConfig({ newOriginPolicy: bad }, HOME).newOriginPolicy, String(bad)).toBe('ask')
    }
  })

  it('allowedOrigins 滤掉非字符串与空串（YAML 缩进写错时就是这样）', () => {
    const c = resolveConfig({ allowedOrigins: ['https://a.com', 1, '', null, 'https://b.com'] }, HOME)
    expect(c.allowedOrigins).toEqual(['https://a.com', 'https://b.com'])
    // 整个不是数组也不炸
    expect(resolveConfig({ allowedOrigins: 'https://a.com' }, HOME).allowedOrigins).toEqual([])
  })

  it('cdpEndpoint 去掉尾斜杠（否则拼 /json/version 会出双斜杠）', () => {
    expect(resolveConfig({ cdpEndpoint: 'http://127.0.0.1:9222///' }, HOME).cdpEndpoint).toBe('http://127.0.0.1:9222')
    expect(resolveConfig({ cdpEndpoint: '  http://127.0.0.1:9222  ' }, HOME).cdpEndpoint).toBe('http://127.0.0.1:9222')
  })

  it('DSH_BROWSER_USE_CDP 环境变量兜底（桌面壳塞的 CDP 中继端点）', () => {
    const prev = process.env['DSH_BROWSER_USE_CDP']
    try {
      process.env['DSH_BROWSER_USE_CDP'] = 'http://127.0.0.1:45678/'
      // 没配 cdpEndpoint 时用环境变量
      const cfg = resolveConfig({}, HOME)
      expect(cfg.cdpEndpoint).toBe('http://127.0.0.1:45678')
      expect(cfg.cdpEndpointSource).toBe('环境变量 DSH_BROWSER_USE_CDP')
      // 显式配置优先于环境变量
      const cfg2 = resolveConfig({ cdpEndpoint: 'http://127.0.0.1:9222' }, HOME)
      expect(cfg2.cdpEndpoint).toBe('http://127.0.0.1:9222')
      expect(cfg2.cdpEndpointSource).toBe('插件配置')
    } finally {
      if (prev === undefined) delete process.env['DSH_BROWSER_USE_CDP']
      else process.env['DSH_BROWSER_USE_CDP'] = prev
    }
    expect(resolveConfig({}, HOME).cdpEndpoint).toBe('')
  })

  it('<DSH_HOME>/agent-browser-cdp.json 文件兜底（环境变量丢了时）', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'dshhome-'))
    const prevHome = process.env['DSH_HOME']
    const prevCdp = process.env['DSH_BROWSER_USE_CDP']
    try {
      writeFileSync(join(dir, 'agent-browser-cdp.json'), JSON.stringify({ cdpEndpoint: 'http://127.0.0.1:51234/' }))
      process.env['DSH_HOME'] = dir
      delete process.env['DSH_BROWSER_USE_CDP']
      const cfg = resolveConfig({}, HOME)
      expect(cfg.cdpEndpoint).toBe('http://127.0.0.1:51234')
      expect(cfg.cdpEndpointSource).toBe('文件 agent-browser-cdp.json')
      // 环境变量优先于文件
      process.env['DSH_BROWSER_USE_CDP'] = 'http://127.0.0.1:45678'
      const cfg2 = resolveConfig({}, HOME)
      expect(cfg2.cdpEndpoint).toBe('http://127.0.0.1:45678')
      expect(cfg2.cdpEndpointSource).toBe('环境变量 DSH_BROWSER_USE_CDP')
    } finally {
      if (prevHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = prevHome
      if (prevCdp === undefined) delete process.env['DSH_BROWSER_USE_CDP']
      else process.env['DSH_BROWSER_USE_CDP'] = prevCdp
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('startUrl 留空/全空格时回到 about:blank', () => {
    expect(resolveConfig({ startUrl: '   ' }, HOME).startUrl).toBe('about:blank')
    expect(resolveConfig({ startUrl: 'https://a.com' }, HOME).startUrl).toBe('https://a.com')
  })

  it('allowEvaluate 只认真正的 boolean（字符串 "true" 不算）', () => {
    expect(resolveConfig({ allowEvaluate: true }, HOME).allowEvaluate).toBe(true)
    expect(resolveConfig({ allowEvaluate: 'true' }, HOME).allowEvaluate).toBe(false)
    expect(resolveConfig({ allowEvaluate: 1 }, HOME).allowEvaluate).toBe(false)
  })

  it('workDir 全空格等于没填', () => {
    expect(resolveConfig({ workDir: '   ' }, HOME).workDir).toBe(HOME)
    expect(resolveConfig({ workDir: 'D:/w' }, HOME).workDir).toBe('D:/w')
  })
})

describe('resolveProfileDir', () => {
  it('没配就用 <workDir>/browser-profile', () => {
    const c = resolveConfig({}, HOME)
    expect(resolveProfileDir(c)).toBe(`${HOME}/browser-profile`)
  })

  it('workDir 带尾斜杠不会拼出双斜杠', () => {
    const c = resolveConfig({ workDir: 'D:/w/' }, HOME)
    expect(resolveProfileDir(c)).toBe('D:/w/browser-profile')
  })

  it('显式配了就用配的那个', () => {
    const c = resolveConfig({ browserProfileDir: 'D:/my-profile' }, HOME)
    expect(resolveProfileDir(c)).toBe('D:/my-profile')
  })

  it('显式配成全空格等于没配（否则会得到一个叫 "   " 的目录）', () => {
    const c = resolveConfig({ browserProfileDir: '   ' }, HOME)
    expect(resolveProfileDir(c)).toBe(`${HOME}/browser-profile`)
  })
})

describe('originOf', () => {
  it('http/https 归一成 origin，路径与查询串都丢掉', () => {
    expect(originOf('https://ops.rrzu.com/super/v4-order/index?a=1#x')).toBe('https://ops.rrzu.com')
    expect(originOf('http://127.0.0.1:24022/json/list')).toBe('http://127.0.0.1:24022')
  })

  it('host 大小写与默认端口被归一（HTTPS://A.COM:443 与 https://a.com 等价）', () => {
    expect(originOf('HTTPS://A.COM:443/x')).toBe('https://a.com')
    expect(originOf('https://a.com/x')).toBe('https://a.com')
  })

  it('非 http(s) 协议与非法 URL 一律返回空串（调用方按"无 origin"放行）', () => {
    for (const u of ['file:///c:/x', 'about:blank', 'chrome://settings', 'data:text/html,x', 'not a url', '']) {
      expect(originOf(u), u).toBe('')
    }
  })
})
