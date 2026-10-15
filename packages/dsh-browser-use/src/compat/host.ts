/**
 * cordis 上下文 → 插件宿主契约的薄适配层。
 * 形状依据 dsh-qw-rrzu-ops 0.3.1 的实测行为（编译产物反推）：
 * - ctx.tools.register(tool) 注册模型工具
 * - ctx.effect(fn, label) 生命周期
 * - ctx.inject(['connection'], cb) 拿到 connection
 * - connection.fetch.register({path, methods, requestBody:'buffered', fetch}) 挂 HTTP 路由
 *
 * `tools` 是**必需**服务，由入口模块的 `export const inject = ['tools']` 声明；
 * 其余能力（connection 的 HTTP 路由）做存在性探测，缺了就记一条可读的诊断。
 *
 * ## 三个实测踩过的坑（改之前先读这段）
 *
 * **一、`ctx.inject` 的回调是异步的，注册不能放在它外面。**
 * `apply()` 返回之后回调才执行（实测：`apply` 同步跑完时回调还没进）。
 * 所以「先 `inject` 存下 registry，再在 `apply` 里同步调 `registerHttpRoute`」
 * 这种写法拿到的一定是 `undefined` —— 路由静默挂不上，面板永远显示"未启动"。
 * 正确的形状是与 `inject` 对称的 `withConnection(install)`：**把注册整段搬进回调里**。
 * （dsh-qw-rrzu-ops / dsh-qw-douyin-store / dsh-qw-order-desktop 都是这个形状。）
 *
 * **二、`fetch` 挂在 `connection` 上，不是 context 自己的属性。**
 * 回调收到的 context 上直接读 `.fetch` 会抛
 * `cannot get property "fetch" without inject` —— 因为插件 `inject` 的是
 * `connection` 这个名字，不是 `fetch`。要读 `ctx.connection.fetch`。
 * 同理，**没 inject connection 的裸 context 读 `.connection` 本身就抛**
 * `cannot get property "connection" without inject`，所以探测时必须 catch。
 *
 * **三、必需服务的依赖要声明在模块上，不能只写在 cordis.patch.yml 的行里。**
 * 桌面宿主用 `desktop-host-sources.patch.yml` 按 file: URL 插入本插件，那条路径
 * 根本不消费行级 `inject:`；裸读 `ctx.tools` 抛 "without inject" 之后，曾经的 apply
 * 把异常兜住直接 return，于是「插件在跑、模型一个 browser_* 都看不到」没有任何一处
 * 报错。现在由 `index.ts` 的 `export const inject = ['tools']` 兜住这条边界，
 * apply 也不再吞异常（见 test/apply.test.ts 里那个复刻 cordis 代理的假 ctx）。
 */

export interface ToolParameter {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  readonly required?: boolean;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly items?: ToolParameter;
  readonly properties?: Readonly<Record<string, ToolParameter>>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly timeoutMs?: number;
  /** 工具返回值 → 发给模型的内容块（默认转 JSON 文本） */
  readonly render?: (args: unknown, value: unknown) => readonly unknown[];
  execute(args: unknown, ctx: ToolRunContext): Promise<unknown>;
}

export interface ToolRunContext {
  readonly signal: AbortSignal;
  /**
   * 把一帧图片存成 Harness 的附件，返回可直接进内容块的图片块；存不了就返回 undefined。
   *
   * **不要自己拼 `image_url`。** Harness 的图片内容块只有一种形状 ——
   * `{ type: 'image', attachment: ref }`，`ref` 必须来自 attachment 存储。
   * `dsh-llm-deepseek` 的 `serialize()` 只认 text/reasoning/tool-call/image，
   * 别的一律抛 `UNSUPPORTED_CONTENT` —— 而且是在**构造请求时**抛，
   * 整轮对话直接崩，报错还看不出跟图片有关（实测：
   * `DeepSeek Messages cannot represent user/tool-result content image_url`）。
   *
   * 宿主没挂 attachment 存储时为 undefined，调用方要退化成纯文本。
   */
  readonly saveImageBlock?: (data: Uint8Array, mediaType: string, name?: string) => Promise<unknown | undefined>;
  /**
   * 当前模型是否声明了图片输入；**取不到返回 undefined**（= 不知道，别当成"不支持"）。
   *
   * 是个方法而不是字段：解析要走 `llm.resolveModelInfo`，只有真的要发图的工具才该付这个钱。
   * 返回 `false` 时调用方应当只发文本并说明 —— 虽然 Harness 会替文本模型把 image 块
   * 降级成文字（`projectImagesForTextModel`），但那是兜底，不该当成正常路径。
   */
  readonly modelSupportsImages?: () => Promise<boolean | undefined>;
}

export type HttpMethod = 'GET' | 'HEAD' | 'POST';

export interface HttpRoute {
  readonly path: string;
  readonly methods: readonly HttpMethod[];
  handle(request: { readonly method: string; readonly url: string }): Promise<Response>;
}

export interface HostContract {
  registerTool(tool: ToolDefinition): () => void;
  effect(callback: () => void | (() => void), label: string): void;
  registerHttpRoute(route: HttpRoute): (() => void) | undefined;
  /**
   * 等 `connection` 服务就绪后再跑 `install`，并把绑定好那个子 context 的宿主契约交给它。
   *
   * **路由必须在这里面注册**（理由见文件头）——`apply` 里同步注册是拿不到注册表的。
   * 更早的 Harness 没有该服务时回调压根不执行：插件照常加载，只是面板拿不到数据。
   */
  withConnection(install: (host: HostContract) => void): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 把参数声明转成 JSON Schema（给模型看的那份） */
export function toJsonSchema(params: Readonly<Record<string, ToolParameter>>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(params)) {
    if (p.required) required.push(name);
    properties[name] = paramToSchema(p);
  }
  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) schema['required'] = required;
  return schema;
}

function paramToSchema(p: ToolParameter): Record<string, unknown> {
  const s: Record<string, unknown> = { type: p.type };
  if (p.description) s['description'] = p.description;
  if (p.enum) s['enum'] = [...p.enum];
  if (p.items) s['items'] = paramToSchema(p.items);
  if (p.properties) {
    const props: Record<string, unknown> = {};
    const req: string[] = [];
    for (const [k, v] of Object.entries(p.properties)) {
      if (v.required) req.push(k);
      props[k] = paramToSchema(v);
    }
    s['properties'] = props;
    if (req.length > 0) s['required'] = req;
  }
  return s;
}

export function defineTool(spec: {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, ToolParameter>>;
  readonly timeoutMs?: number;
  readonly render?: (args: Record<string, unknown>, value: unknown) => readonly unknown[];
  execute(args: Record<string, unknown>, ctx: ToolRunContext): Promise<unknown>;
}): ToolDefinition {
  const schema = toJsonSchema(spec.parameters);
  const render = spec.render ?? ((_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]);
  return {
    name: spec.name,
    description: spec.description,
    parameters: schema,
    // `exactOptionalPropertyTypes` 下不能直接写 `timeoutMs: spec.timeoutMs` ——
    // 可选属性不接受显式的 undefined，得条件展开。
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    render: (a, v) => render(a as Record<string, unknown>, v),
    async execute(rawArgs: unknown, ctx: ToolRunContext): Promise<unknown> {
      const args = isRecord(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
      // 轻量必填校验
      for (const [name, p] of Object.entries(spec.parameters)) {
        if (p.required && (args[name] === undefined || args[name] === null || args[name] === '')) {
          throw new Error(`browser-use: 参数 ${name} 必填`);
        }
      }
      return spec.execute(args, ctx);
    },
  };
}

export function createHost(context: unknown, log: (m: string) => void): HostContract {
  const ctx = context as Record<string, unknown>;
  // `tools` 已经在入口用模块级 `inject` 声明，读它不会再撞
  // `cannot get property "tools" without inject`（cordis 4 的 ctx 代理对没注入的
  // 服务名直接抛）。剩下的唯一故障形态是：注入了但形状不对 —— Harness 换了版本，
  // 抛出去让宿主把它归因成本插件的 activate 失败，不要在这里降级成"加载但没工具"。
  const tools = ctx['tools'] as Record<string, unknown> | undefined;
  if (!isRecord(tools) || typeof tools['register'] !== 'function') {
    throw new Error('browser-use: 注入的 tools 服务没有 register()，当前 Harness 与本插件不兼容');
  }
  const doEffect = typeof ctx['effect'] === 'function'
    ? (ctx['effect'] as (fn: () => void | (() => void), label: string) => void)
    : (fn: () => void | (() => void)) => { fn(); };

  /**
   * 现取 fetch 注册表，**不缓存**：Harness 允许服务在运行期卸载重装，
   * 缓存下来会在那之后变成一个指向已死对象的句柄（沿用 dsh-qw-rrzu-ops 的理由）。
   *
   * 必须先 `inject(['connection'])` 才读得到 —— 这是 `withConnection` 存在的原因。
   */
  function fetchRegistry(): { register: (r: unknown) => () => void } | undefined {
    try {
      const connection = ctx['connection'];
      if (!isRecord(connection)) return undefined;
      const fetch = connection['fetch'];
      if (!isRecord(fetch) || typeof fetch['register'] !== 'function') return undefined;
      return fetch as { register: (r: unknown) => () => void };
    } catch {
      // 没 inject connection 时读 ctx.connection 就抛。这不是故障，是调用时机不对，
      // 由 registerHttpRoute 报一句可读的诊断。
      return undefined;
    }
  }

  /**
   * 把路由的返回值翻译成 harness 认的 `Response`。
   *
   * ## 为什么要过这一道，而不是让业务代码直接返 Response
   *
   * 传输层是这么消费我们的返回值的（`dsh-client-connection` 的 `handleApiRequest`）：
   *
   * ```
   * const response = await apiHandler.fetch(request)
   * const responseHeaders = Object.fromEntries(response.headers.entries())
   * res.writeHead(response.status, responseHeaders)
   * for await (const chunk of response.body) { res.write(chunk) }
   * ```
   *
   * 三个硬约束：
   * 1. `response.headers` 为 undefined 时第一行就抛，整个请求 500；
   * 2. `response.body` 为 null 时它 `res.end()` 收摊 —— 投屏流就断在这儿；
   * 3. **不设超时**：流式响应会一直 `for await` 下去，
   *    靠 `res.write()` 的背压回传。所以流里绝不能忙等。
   */
  function normalizeResponse(value: unknown): Response {
    if (value instanceof Response) return value;
    if (value === undefined || value === null) return new Response(null, { status: 204 });
    if (typeof value === 'string') return new Response(value, { status: 200 });
    try {
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch {
      return new Response(null, { status: 500 });
    }
  }

  /**
   * 读一个服务，不做 inject 声明。
   *
   * `ctx.get(name)` 是 cordis 给不声明依赖的读取口（`get(name, strict)`），
   * 与 `ctx.<name>` 属性访问不同：**后者在读没 inject 的服务时直接抛
   * `cannot get property "x" without inject`**，前者返回 undefined。
   * 插件用属性访问读 `connection` 要 catch，这里统一走 get()。
   */
  function service(name: string): Record<string, unknown> | undefined {
    try {
      const getter = ctx['get'];
      if (typeof getter !== 'function') return undefined;
      const value = (getter as (n: string) => unknown).call(ctx, name);
      return isRecord(value) ? value : undefined;
    } catch {
      // 某些 context（子 fiber）上 get 可能不可用。不是故障，当作没有这个服务。
      return undefined;
    }
  }

  /**
   * 把一帧图片存成附件，返回**可直接进内容块**的图片块。
   *
   * 形状对齐 `dsh-tool-fs` 的 `read_image`（那边是 `imageRefFromValue` +
   * `{ type: 'image', attachment }`）—— 它是本 Harness 里唯一一处
   * "工具产出图片"的官方实现，照它抄就不会错。
   */
  async function saveImageBlock(data: Uint8Array, mediaType: string, name?: string): Promise<unknown | undefined> {
    const attachments = service('attachments');
    if (attachments === undefined || typeof attachments['saveImage'] !== 'function') {
      // 部署没挂持久化附件存储（`dsh-attachment-local`）。参数合法也无法发图 ——
      // 由调用方退化成纯文本，别在这儿抛错把工具搞失败。
      log('browser-use: 宿主没有挂 attachments 服务，图片发不出去（只能给文字说明）');
      return undefined;
    }
    try {
      const ref = await (attachments['saveImage'] as (input: unknown) => Promise<unknown>)({
        data,
        mediaType,
        ...(name === undefined ? {} : { name }),
      });
      if (!isRecord(ref)) return undefined;
      return { type: 'image', attachment: ref };
    } catch (e) {
      log(`browser-use: 存图片失败：${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  /**
   * 当前模型认不认图片。
   *
   * 两步都要：先拿路由（provider/model），再问 `llm.resolveModelInfo`。
   * 任何一步拿不到就返回 undefined —— **不要返回 false**：
   * "不知道"与"确定不支持"是两件事，后者会让工具白白降级掉图片能力。
   */
  async function modelSupportsImages(execCtx: unknown): Promise<boolean | undefined> {
    const exec = isRecord(execCtx) ? execCtx : undefined;
    const agent = isRecord(exec?.['agent']) ? (exec['agent'] as Record<string, unknown>) : undefined;
    if (agent === undefined) return undefined;
    const session = isRecord(agent['session']) ? (agent['session'] as Record<string, unknown>) : undefined;
    const header = typeof session?.['requestHeader'] === 'function'
      ? (session['requestHeader'] as () => unknown)()
      : undefined;
    const config = isRecord(header) && isRecord((header as Record<string, unknown>)['config'])
      ? ((header as Record<string, unknown>)['config'] as Record<string, unknown>)
      : undefined;
    const options = isRecord(agent['options']) ? (agent['options'] as Record<string, unknown>) : undefined;
    const provider = config?.['provider'] ?? options?.['provider'];
    const model = config?.['model'] ?? options?.['model'];
    if (typeof provider !== 'string' || typeof model !== 'string') return undefined;

    const llm = service('llm');
    if (llm === undefined || typeof llm['resolveModelInfo'] !== 'function') return undefined;
    const signal = exec?.['signal'] instanceof AbortSignal ? (exec['signal'] as AbortSignal) : undefined;
    try {
      const info = await (llm['resolveModelInfo'] as (p: string, m: string, s?: AbortSignal) => Promise<unknown>)(
        provider,
        model,
        signal,
      );
      if (!isRecord(info)) return undefined;
      const modalities = info['inputModalities'];
      if (!Array.isArray(modalities)) return undefined;
      return modalities.includes('image');
    } catch {
      return undefined;
    }
  }

  return {
    registerTool(tool: ToolDefinition): () => void {
      const dispose = (tools['register'] as (t: unknown) => () => void)({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: {
          schema: { type: 'object' },
          render: tool.render ?? ((_a: unknown, v: unknown) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }]),
        },
        ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
        execute: (args: unknown, execCtx: unknown) => {
          const raw = isRecord(execCtx) ? execCtx : undefined;
          const signal = raw?.['signal'] instanceof AbortSignal
            ? (raw['signal'] as AbortSignal)
            : AbortSignal.timeout(tool.timeoutMs ?? 120000);
          return tool.execute(args, {
            signal,
            saveImageBlock,
            modelSupportsImages: () => modelSupportsImages(execCtx),
          });
        },
      });
      return typeof dispose === 'function' ? dispose : () => {};
    },
    effect(callback: () => void | (() => void), label: string): void {
      doEffect(callback, label);
    },
    registerHttpRoute(route: HttpRoute): (() => void) | undefined {
      const registry = fetchRegistry();
      if (!registry) {
        log(`browser-use: 这个 context 上没有 connection.fetch 注册表，路由 ${route.path} 挂不上（投屏面板不可用）。路由应当写在 withConnection() 里。`);
        return undefined;
      }
      const dispose = registry.register({
        path: route.path,
        methods: [...route.methods],
        requestBody: 'buffered',
        fetch: async (req: { url: string; method: string }) => {
          try {
            return normalizeResponse(await route.handle({ method: req.method, url: req.url }));
          } catch (e) {
            // 路由里抛错不能把 500 甩给传输层 —— 那样面板上只有一句没头没尾的失败。
            const message = e instanceof Error ? e.message : String(e);
            log(`browser-use: 路由 ${route.path} 处理失败：${message}`);
            return new Response(JSON.stringify({ error: message }), {
              status: 500,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            });
          }
        },
      });
      return typeof dispose === 'function' ? dispose : undefined;
    },
    withConnection(install: (host: HostContract) => void): void {
      const inject = ctx['inject'];
      if (typeof inject !== 'function') {
        log('browser-use: 这个 Harness 没有 ctx.inject，拿不到 connection（面板不可用）');
        return;
      }
      try {
        (inject as (deps: string[], cb: (c: unknown) => void) => void)(['connection'], (conn: unknown) => {
          try {
            // 给的是**绑定在 connection 子 fiber 上**的新契约：路由注册进那个 fiber，
            // connection 卸载时随之撤销（与 dsh-qw-rrzu-ops 的 withConnection 同形）。
            install(createHost(conn, log));
          } catch (e) {
            log(`browser-use: connection 就绪但契约建不起来（面板不可用）：${e instanceof Error ? e.message : String(e)}`);
          }
        });
      } catch (e) {
        log(`browser-use: 取 connection 失败（HTTP 路由不可用）：${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
