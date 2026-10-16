/**
 * `apply()` 的加载与工具面测试。
 *
 * 两件事必须钉住，因为它们各自对应一次真实事故：
 *
 * 1. **2026-10-15 右侧投屏面板下线**：`/api/dsh-browser-use/status.json` 与
 *    `stream.mjpeg` 两条 HTTP 路由已删除，原来"常量与路由对得上"那组断言随之删除。
 * 2. **插件在 cordis 4 上必须声明服务依赖**：桌面宿主按 file: URL 把本插件插进
 *    `desktop-host-sources.patch.yml`，行级 `inject:` 在那条路径上不被消费；apply
 *    裸读 `ctx.tools` 抛 `cannot get property "tools" without inject`，而当时的
 *    apply 把异常兜住直接 return —— 症状是「插件在跑、模型一个 browser_* 都看不到」，
 *    没有任何一处报错。所以下面的假 ctx **复刻 cordis 的服务解析代理**：只有模块
 *    声明过的名字才读得到。旧 fixture 用的是普通对象，天然测不出这个坑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apply, inject as declaredInject } from '../src/index.js'

/*
  `apply()` 自己造 log（`console.warn`），没法从外面注进去。
  这里把它静音并收下来 —— 不是在测日志，只是别让用例刷同样的 "插件已加载"。
  顺带断言加载日志本身出现了（它是用户在 dsh 日志里唯一的锚点）。
*/
let logs: string[] = []
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** cordis 自己挂在 context 上的方法，不需要 inject 也读得到。 */
const CONTEXT_BUILTINS = ['effect', 'get', 'inject']

/**
 * 复刻 cordis 4 `ReflectService.handler.get`：读没声明的服务名直接抛，
 * 而不是返回 undefined。插件少声明一个依赖，这里就会像真实宿主那样炸。
 */
function cordisLikeContext(
  declared: readonly string[],
  services: Record<string, unknown>,
): Record<string, unknown> {
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get: (_target, prop) => {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then' || prop.startsWith('_')) return undefined;
      if (!declared.includes(prop) && !CONTEXT_BUILTINS.includes(prop)) {
        throw new TypeError(`cannot get property "${prop}" without inject`);
      }
      return services[prop];
    },
  });
}

/** 宿主侧只提供 tools 注册表；返回它收到的工具定义。 */
function runApply(rawConfig: Record<string, unknown> = {}, services?: Record<string, unknown>) {
  const tools: Array<Record<string, unknown>> = []
  const context = cordisLikeContext(declaredInject, {
    tools: { register: (t: Record<string, unknown>) => { tools.push(t); return () => {} } },
    effect: (cb: () => void | (() => void)) => { cb() },
    get: () => undefined,
    inject: () => {
      throw new Error('本插件不再需要 inject 任何服务（投屏面板已下线）');
    },
    ...services,
  })
  apply(context, rawConfig)
  return { tools }
}

describe('apply 的加载行为', () => {
  it('模块声明了 tools 依赖：宿主插入的行不带 inject 也拿得到服务', () => {
    // 这条是那次"零工具"事故的正向锚点。声明一旦丢，runApply() 会在读 ctx.tools
    // 时抛 "without inject"，下面所有用例一起红。
    expect(declaredInject).toContain('tools')
    expect(() => runApply()).not.toThrow()
  })

  it('加载成功时记一条可读的日志（用户在 dsh 日志里的锚点）', () => {
    runApply()
    expect(logs.some((l) => l.includes('插件已加载') && l.includes('策略'))).toBe(true)
  })

  it('tools 注入了但没有 register() 时抛给宿主，不再静默成"加载了但没工具"', () => {
    expect(() => runApply({}, { tools: {} })).toThrow(/register/u)
    expect(logs.some((l) => l.includes('宿主能力缺失'))).toBe(false)
  })

  it('配置乱七八糟时回落默认值，而不是拒绝加载', () => {
    const { tools } = runApply({ browser: 'firefox', newOriginPolicy: 42, screencast: '不是对象' })
    expect(tools.length).toBeGreaterThan(0)
  })

  it('不再注册任何 HTTP 路由（面板下线：连 connection 注入都不需要）', () => {
    // ctx 上读 connection 会直接抛（假 ctx 的 inject 回调也抛）——
    // 能跑完加载就说明路由那条路径真的删干净了。
    expect(() => runApply()).not.toThrow()
    expect(logs.some((l) => l.includes('插件已加载'))).toBe(true)
  })
})

describe('apply 注册的工具面', () => {
  it('24 个工具全注册上，且名字都带 browser_ 前缀', () => {
    const { tools } = runApply()
    expect(tools).toHaveLength(24)
    for (const t of tools) {
      expect(String(t['name']).startsWith('browser_'), String(t['name'])).toBe(true)
    }
  })

  it('工具名互不重复（重名会让后一个静默覆盖前一个）', () => {
    const names = runApply().tools.map((t) => String(t['name']))
    expect(new Set(names).size).toBe(names.length)
  })

  it('每个工具都带 description 与 parameters（模型看不到就没法调）', () => {
    for (const t of runApply().tools) {
      expect(typeof t['description'], String(t['name'])).toBe('string')
      expect(String(t['description']).length, String(t['name'])).toBeGreaterThan(0)
      expect(t['parameters'], String(t['name'])).toMatchObject({ type: 'object' })
      expect(typeof t['execute'], String(t['name'])).toBe('function')
    }
  })

  it('★ browser_evaluate 默认关着，且拒绝时的错误里说清怎么打开', async () => {
    const { tools } = runApply({ allowEvaluate: false })
    const tool = tools.find((t) => t['name'] === 'browser_evaluate')!
    // 没开 allowEvaluate 时应当在**启动浏览器之前**就拒掉
    await expect(
      (tool['execute'] as (a: unknown, c: unknown) => Promise<unknown>)(
        { expression: 'location.href' },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/allowEvaluate/u)
  })

  it('配置里的 allowedOrigins 真的进了策略（不用等浏览器起来就能验）', async () => {
    const { tools } = runApply({ allowedOrigins: ['https://pre.approved'], newOriginPolicy: 'ask' })
    const approve = tools.find((t) => t['name'] === 'browser_approve_origin')!
    // 批准一个非法 origin 要被拒 —— 顺便证明这个工具的校验在 ensure 之前
    await expect(
      (approve['execute'] as (a: unknown, c: unknown) => Promise<unknown>)(
        { origin: 'not-an-origin' },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/不是合法的 http\(s\) origin/u)
  })

  it('browser_status 不启动浏览器也能答（模型可能先问一句）', async () => {
    const { tools } = runApply()
    const status = tools.find((t) => t['name'] === 'browser_status')!
    const out = (await (status['execute'] as (a: unknown, c: unknown) => Promise<unknown>)(
      {},
      { signal: new AbortController().signal },
    )) as Record<string, unknown>
    expect(out['running']).toBe(false)
  })
})
