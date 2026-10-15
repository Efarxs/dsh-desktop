/**
 * 宿主契约适配层（compat/host.ts）的测试。
 *
 * ## 这个文件存在的唯一理由
 *
 * 这个插件已经踩过两个"能加载、能构建、但功能静默消失"的坑，两个都在这一层：
 *
 * 1. **`ctx.inject` 的回调是异步的。** `apply()` 同步跑完时回调还没执行，
 *    所以"先 inject 存下 registry、再在 apply 里同步注册路由"拿到的一定是
 *    undefined —— 两条 HTTP 路由静默挂不上，右侧面板永远显示"浏览器未启动"，
 *    哪怕浏览器正在跑。修法是 `withConnection()`：把注册整段搬进回调。
 *    下面那个标 ★ 的 describe 就是把这件事钉死。
 * 2. **图片内容块的形状。** 自己拼 OpenAI 式的 `image_url` 会让整轮请求在构造阶段
 *    崩掉（`UNSUPPORTED_CONTENT`），报错还完全不提工具名。所以 `saveImageBlock`
 *    必须产出 `{ type: 'image', attachment }`，且宿主的 attachment 存储缺失时
 *    返回 undefined 让调用方退化 —— 而不是抛错把工具搞失败。
 *
 * 用的是一只手搓的假 cordis context，**不需要 Harness**。
 */
import { describe, expect, it, vi } from 'vitest'

import { createHost, defineTool } from '../src/compat/host.js'

interface FakeTool { name: string; execute: (a: unknown, c: unknown) => Promise<unknown> }

/** 造一个假 ctx。`services` 里的东西会被 `ctx.get(name)` 读到。 */
function fakeCtx(options: {
  services?: Record<string, unknown>
  /** true = 模拟"还没 inject connection"：读 ctx.connection 直接抛 */
  throwOnConnectionRead?: boolean
} = {}) {
  const tools: FakeTool[] = []
  const effects: string[] = []
  const services = options.services ?? {}

  const ctx: Record<string, unknown> = {
    tools: { register: (t: FakeTool) => { tools.push(t); return () => {} } },
    effect: (cb: () => void | (() => void), label: string) => {
      effects.push(label)
      cb()
    },
    get: (name: string) => services[name],
  }
  if (options.throwOnConnectionRead === true) {
    // cordis 的真实行为：没 inject 就读，直接抛
    Object.defineProperty(ctx, 'connection', {
      get() { throw new Error('cannot get property "connection" without inject') },
    })
  } else {
    ctx['connection'] = services['connection']
  }
  return { ctx, tools, effects }
}

type RegisteredRoute = {
  path: string
  methods: string[]
  requestBody: string
  fetch: (req: { url: string; method: string }) => Promise<Response>
}

/** 造一个假的 connection.fetch 注册表，记下注册进来的东西。 */
function fakeRegistry() {
  const registered: RegisteredRoute[] = []
  const disposed: string[] = []
  return {
    registered,
    disposed,
    registry: {
      fetch: {
        register: (r: RegisteredRoute) => {
          registered.push(r)
          return () => { disposed.push(r.path) }
        },
      },
    },
  }
}

/**
 * 挂一个 context，让 `inject` 的回调可以手动触发。
 *
 * `fire()` 就是 cordis 稍后触发的那个动作 —— 测试靠它区分"同步阶段"与"回调之后"。
 */
function hostWithInjection(ctx: Record<string, unknown>, connRegistry: unknown, log: (m: string) => void = () => {}) {
  let fire: (() => void) | undefined
  ctx['inject'] = (deps: string[], cb: (c: unknown) => void) => {
    fire = () => cb({
      tools: ctx['tools'],
      effect: ctx['effect'],
      get: ctx['get'],
      connection: connRegistry,
    })
    void deps
  }
  return { host: createHost(ctx, log), fire: () => fire?.() }
}

describe('createHost 的前置条件', () => {
  it('宿主没有 tools 注册服务时直接抛（不静默降级成"插件加载了但没工具"）', () => {
    expect(() => createHost({}, () => {})).toThrow(/tools/u)
    expect(() => createHost({ tools: {} }, () => {})).toThrow(/tools/u)
  })
})

describe('★ withConnection：路由不能写在 apply 里同步注册', () => {
  it('inject 的回调是异步的 —— 同步跑完 apply 时注册表还没到', () => {
    const logs: string[] = []
    const { ctx } = fakeCtx({ throwOnConnectionRead: true })
    const { registry, registered } = fakeRegistry()
    const { host, fire } = hostWithInjection(ctx, registry, (m) => logs.push(m))

    // ① 同步阶段：想注册路由只能拿到 undefined（这正是当初那个 bug）
    const tooEarly = host.registerHttpRoute({ path: '/api/x', methods: ['GET'], handle: async () => new Response('x') })
    expect(tooEarly).toBeUndefined()
    expect(registered).toHaveLength(0)
    expect(logs.some((l) => l.includes('路由应当写在 withConnection() 里'))).toBe(true)

    // ② 正确的形状：搬进 withConnection
    let installRan = false
    host.withConnection((connHost) => {
      connHost.registerHttpRoute({ path: '/api/x', methods: ['GET'], handle: async () => new Response('x') })
      installRan = true
    })
    // 回调还没跑 —— 这就是"同步注册拿不到注册表"的机理
    expect(installRan).toBe(false)
    expect(registered).toHaveLength(0)

    // ③ inject 回调被触发之后，路由才真的挂上
    fire()
    expect(installRan).toBe(true)
    expect(registered.map((r) => r.path)).toEqual(['/api/x'])
  })

  it('宿主连 ctx.inject 都没有时只记一条日志，不抛（老 Harness 上插件照样加载）', () => {
    const logs: string[] = []
    const { ctx } = fakeCtx()
    const host = createHost(ctx, (m) => logs.push(m))
    expect(() => host.withConnection(() => { throw new Error('不该跑到这里') })).not.toThrow()
    expect(logs.some((l) => l.includes('ctx.inject'))).toBe(true)
  })

  it('老 Harness 上 connection 就绪不了时，install 里的异常被兜住并记日志', () => {
    const logs: string[] = []
    const { ctx } = fakeCtx()
    ctx['inject'] = (_d: string[], cb: (c: unknown) => void) => cb({ tools: ctx['tools'], effect: ctx['effect'] })
    void createHost
    const host = createHost(ctx, (m) => logs.push(m))
    host.withConnection(() => { throw new Error('契约建不起来') })
    expect(logs.some((l) => l.includes('契约建不起来'))).toBe(true)
  })

  it('注册进去的路由带 requestBody: buffered（传输层要读请求体）', () => {
    const { ctx } = fakeCtx()
    const { registry, registered } = fakeRegistry()
    const { host, fire } = hostWithInjection(ctx, registry)
    host.withConnection((h) => {
      h.registerHttpRoute({ path: '/api/dsh-browser-use/status.json', methods: ['GET'], handle: async () => new Response('{}') })
    })
    fire()
    expect(registered).toHaveLength(1)
    expect(registered[0]!.requestBody).toBe('buffered')
    expect(registered[0]!.methods).toEqual(['GET'])
  })

  it('connection 卸载时 register 返回的 dispose 能把路由摘掉', () => {
    const { ctx } = fakeCtx()
    const { registry, registered, disposed } = fakeRegistry()
    const { host, fire } = hostWithInjection(ctx, registry)
    let dispose: (() => void) | undefined
    host.withConnection((h) => {
      dispose = h.registerHttpRoute({ path: '/api/x', methods: ['GET'], handle: async () => new Response('x') })
    })
    fire()
    expect(registered).toHaveLength(1)
    expect(typeof dispose).toBe('function')
    dispose?.()
    expect(disposed).toEqual(['/api/x'])
  })
})

describe('路由返回值的归一（传输层要解构 response.headers / response.body）', () => {
  async function mount(handler: () => Promise<unknown>): Promise<RegisteredRoute> {
    const { ctx } = fakeCtx()
    const { registry, registered } = fakeRegistry()
    const { host, fire } = hostWithInjection(ctx, registry)
    host.withConnection((h) => {
      h.registerHttpRoute({ path: '/api/t', methods: ['GET'], handle: handler as never })
    })
    fire()
    return registered[0]!
  }

  it('Response 原样透传（投屏那条 multipart 流就是这么出去的）', async () => {
    const original = new Response('hello', { status: 201, headers: { 'x-a': '1' } })
    const r = await (await mount(async () => original)).fetch({ url: '/api/t', method: 'GET' })
    expect(r).toBe(original)
  })

  it('普通对象被包成 JSON（少写一个 Response 也不会 500）', async () => {
    const r = await (await mount(async () => ({ ok: true }))).fetch({ url: '/api/t', method: 'GET' })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('application/json')
    expect(await r.json()).toEqual({ ok: true })
  })

  it('undefined / null 变成 204（而不是让传输层在 response.headers 上抛）', async () => {
    for (const v of [undefined, null]) {
      const r = await (await mount(async () => v)).fetch({ url: '/api/t', method: 'GET' })
      expect(r.status).toBe(204)
    }
  })

  it('字符串直接当 body', async () => {
    const r = await (await mount(async () => '纯文本')).fetch({ url: '/api/t', method: 'GET' })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('纯文本')
  })

  it('路由里抛错 → 500 + 可读 JSON，而不是把异常甩给传输层', async () => {
    const logs: string[] = []
    const { ctx } = fakeCtx()
    const { registry, registered } = fakeRegistry()
    const { host, fire } = hostWithInjection(ctx, registry, (m) => logs.push(m))
    host.withConnection((h) => {
      h.registerHttpRoute({ path: '/api/boom', methods: ['GET'], handle: async () => { throw new Error('炸了') } })
    })
    fire()
    const r = await registered[0]!.fetch({ url: '/api/boom', method: 'GET' })
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ error: '炸了' })
    expect(logs.some((l) => l.includes('路由 /api/boom 处理失败'))).toBe(true)
  })
})

describe('★ 图片块与模型能力：截图那条路最容易整轮崩掉', () => {
  /** 建一个宿主，跑一次工具，把宿主注入的 exec ctx 交出来。 */
  async function execOf(services: Record<string, unknown>, log: (m: string) => void = () => {}, outer: unknown = {}) {
    const { ctx, tools } = fakeCtx({ services })
    createHost(ctx, log).registerTool(defineTool({
      name: 'shot', description: 'd', parameters: {},
      async execute(_a, e) { return e as unknown as Record<string, unknown> },
    }))
    return (await tools[0]!.execute({}, outer)) as Record<string, unknown>
  }

  it('宿主没有 attachments 服务 → undefined + 一条日志（工具不失败）', async () => {
    const logs: string[] = []
    const exec = await execOf({}, (m) => logs.push(m), { signal: new AbortController().signal })
    const block = await (exec['saveImageBlock'] as (d: Uint8Array, m: string) => Promise<unknown>)(
      new Uint8Array([1]), 'image/jpeg',
    )
    expect(block).toBeUndefined()
    expect(logs.some((l) => l.includes('没有挂 attachments 服务'))).toBe(true)
  })

  it('saveImageBlock 产出 { type: "image", attachment }，绝不是 image_url', async () => {
    const ref = { id: 'att_1', mediaType: 'image/jpeg' }
    const saved: unknown[] = []
    const exec = await execOf(
      { attachments: { saveImage: async (input: unknown) => { saved.push(input); return ref } } },
      () => {},
      { signal: new AbortController().signal },
    )
    const block = await (exec['saveImageBlock'] as (d: Uint8Array, m: string, n?: string) => Promise<unknown>)(
      new Uint8Array([1, 2, 3]), 'image/jpeg', 'browser-screenshot.jpg',
    )
    expect(block).toEqual({ type: 'image', attachment: ref })
    expect(saved[0]).toMatchObject({ mediaType: 'image/jpeg', name: 'browser-screenshot.jpg' })
    expect(JSON.stringify(block)).not.toContain('image_url')
  })

  it('attachment 存储抛错时也返回 undefined（发不了图不该让工具失败）', async () => {
    const logs: string[] = []
    const exec = await execOf(
      { attachments: { saveImage: async () => { throw new Error('磁盘满了') } } },
      (m) => logs.push(m),
    )
    const block = await (exec['saveImageBlock'] as (d: Uint8Array, m: string) => Promise<unknown>)(new Uint8Array([1]), 'image/jpeg')
    expect(block).toBeUndefined()
    expect(logs.some((l) => l.includes('存图片失败'))).toBe(true)
  })

  it('attachment 存储返回的不是对象时也返回 undefined（不把垃圾塞进内容块）', async () => {
    const exec = await execOf({ attachments: { saveImage: async () => 'not-an-object' } })
    const block = await (exec['saveImageBlock'] as (d: Uint8Array, m: string) => Promise<unknown>)(new Uint8Array([1]), 'image/jpeg')
    expect(block).toBeUndefined()
  })

  it('modelSupportsImages 顺着 session.requestHeader().config 问 provider/model', async () => {
    const asked: Array<[string, string]> = []
    const exec = await execOf(
      { llm: { resolveModelInfo: async (p: string, m: string) => { asked.push([p, m]); return { inputModalities: ['text', 'image'] } } } },
      () => {},
      {
        signal: new AbortController().signal,
        agent: { session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-vision' } }) } },
      },
    )
    expect(await (exec['modelSupportsImages'] as () => Promise<boolean | undefined>)()).toBe(true)
    expect(asked).toEqual([['deepseek', 'deepseek-vision']])
  })

  it('requestHeader 的 config 缺失时回落到 agent.options', async () => {
    const asked: Array<[string, string]> = []
    const exec = await execOf(
      { llm: { resolveModelInfo: async (p: string, m: string) => { asked.push([p, m]); return { inputModalities: ['image'] } } } },
      () => {},
      { agent: { session: { requestHeader: () => ({}) }, options: { provider: 'p2', model: 'm2' } } },
    )
    expect(await (exec['modelSupportsImages'] as () => Promise<boolean | undefined>)()).toBe(true)
    expect(asked).toEqual([['p2', 'm2']])
  })

  it('拿不到路由信息时返回 undefined（"不知道"不等于"不支持"）', async () => {
    const exec = await execOf({})
    expect(await (exec['modelSupportsImages'] as () => Promise<boolean | undefined>)()).toBeUndefined()
  })

  it('模型只声明 text 时返回 false（调用方据此只发文字）', async () => {
    const exec = await execOf(
      { llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } },
      () => {},
      { agent: { options: { provider: 'p', model: 'm' } } },
    )
    expect(await (exec['modelSupportsImages'] as () => Promise<boolean | undefined>)()).toBe(false)
  })

  it('llm.resolveModelInfo 抛错时也返回 undefined（探能力失败不该拖垮截图）', async () => {
    const exec = await execOf(
      { llm: { resolveModelInfo: async () => { throw new Error('没有这个模型') } } },
      () => {},
      { agent: { options: { provider: 'p', model: 'nope' } } },
    )
    expect(await (exec['modelSupportsImages'] as () => Promise<boolean | undefined>)()).toBeUndefined()
  })
})

describe('defineTool：参数校验与默认 render', () => {
  it('必填参数缺失时抛出中文错误（模型能看懂该补什么）', async () => {
    const tool = defineTool({
      name: 'x', description: 'd',
      parameters: { url: { type: 'string', required: true } },
      async execute() { return { ok: true } },
    })
    await expect(tool.execute({}, {} as never)).rejects.toThrow(/url 必填/u)
    // 空串也算没填
    await expect(tool.execute({ url: '' }, {} as never)).rejects.toThrow(/url 必填/u)
    await expect(tool.execute({ url: 'https://a.com' }, {} as never)).resolves.toEqual({ ok: true })
  })

  it('args 整个不是对象时按空对象走（模型偶尔会传个字符串上来）', async () => {
    const tool = defineTool({
      name: 'x', description: 'd', parameters: {},
      async execute(a) { return { got: a } },
    })
    await expect(tool.execute('乱传的', {} as never)).resolves.toEqual({ got: {} })
  })

  it('默认 render 把对象转成 JSON 文本块', () => {
    const tool = defineTool({
      name: 'x', description: 'd', parameters: {},
      async execute() { return { a: 1 } },
    })
    expect(tool.render!({}, { a: 1 })).toEqual([{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }])
    expect(tool.render!({}, '直接是字符串')).toEqual([{ type: 'text', text: '直接是字符串' }])
  })

  it('toJsonSchema：params 变成模型看的 JSON Schema，required 只列真必填', () => {
    const tool = defineTool({
      name: 'x', description: 'd',
      parameters: {
        a: { type: 'string', required: true, description: '甲' },
        b: { type: 'number' },
        c: { type: 'array', items: { type: 'string' } },
        d: { type: 'object', properties: { e: { type: 'boolean', required: true } } },
      },
      async execute() { return {} },
    })
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string', description: '甲' },
        b: { type: 'number' },
        c: { type: 'array', items: { type: 'string' } },
        d: { type: 'object', properties: { e: { type: 'boolean' } }, required: ['e'] },
      },
      required: ['a'],
    })
  })

  it('宿主给的 signal 原样透传；没给就按 timeoutMs 兜一个', async () => {
    const seen: Array<AbortSignal | undefined> = []
    const { ctx, tools } = fakeCtx()
    createHost(ctx, () => {}).registerTool(defineTool({
      name: 'x', description: 'd', parameters: {}, timeoutMs: 5000,
      async execute(_a, e) { seen.push(e.signal); return {} },
    }))
    const real = AbortSignal.timeout(1000)
    await tools[0]!.execute({}, { signal: real })
    expect(seen[0]).toBe(real)
    // 老 Harness 不给 signal：兜一个，工具不该拿不到
    await tools[0]!.execute({}, {})
    expect(seen[1]).toBeInstanceOf(AbortSignal)
    expect(seen[1]).not.toBe(real)
  })
})

describe('effect 的生命周期透传', () => {
  it('宿主没有 ctx.effect 时回调立刻执行一次（不静默丢掉注册）', () => {
    const spy = vi.fn()
    const ctx: Record<string, unknown> = { tools: { register: () => () => {} }, get: () => undefined }
    createHost(ctx, () => {}).effect(() => { spy(); return () => {} }, 'label')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('有 ctx.effect 时把 label 原样传下去（诊断日志靠它区分是谁的清理函数）', () => {
    const seen: string[] = []
    const ctx: Record<string, unknown> = {
      tools: { register: () => () => {} },
      get: () => undefined,
      effect: (_cb: unknown, label: string) => { seen.push(label) },
    }
    createHost(ctx, () => {}).effect(() => {}, 'dsh-browser-use: routes')
    expect(seen).toEqual(['dsh-browser-use: routes'])
  })
})
