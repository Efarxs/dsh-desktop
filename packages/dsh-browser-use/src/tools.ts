/**
 * 模型-facing 的浏览器工具集（对标 playwright-mcp 核心）。
 * 每个工具执行后尽量返回新快照，保持 sense-plan-act 闭环。
 */
import { setTimeout as delay } from 'node:timers/promises';
import { defineTool, type HostContract, type ToolDefinition } from './compat/host.js';
import { refToObjectId, refToPoint } from './cdp/snapshot.js';
import { originOf, type BrowserUseConfig } from './config.js';
import type { BrowserService } from './service.js';

type Ctx = { svc: BrowserService; cfg: BrowserUseConfig; log: (m: string) => void };

const S = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const B = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d);
const N = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

async function freshSnapshot(ctx: Ctx) {
  const s = await ctx.svc.snapshot();
  return { url: s.url, title: s.title, snapshot: s.text };
}

async function mouseClick(ctx: Ctx, x: number, y: number, button: 'left' | 'right' = 'left', clickCount = 1) {
  const conn = ctx.svc.conn();
  const btn = button === 'right' ? 'right' : 'left';
  await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: btn, clickCount });
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: btn, clickCount });
}

const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
};

async function pressKey(ctx: Ctx, key: string) {
  const conn = ctx.svc.conn();
  const mapped = KEY_MAP[key];
  if (mapped) {
    await conn.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...mapped });
    await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...mapped });
  } else if (key.length === 1) {
    await conn.send('Input.dispatchKeyEvent', { type: 'char', text: key });
  } else {
    throw new Error(`browser-use: 不认识的按键 ${key}（支持 Enter/Tab/Escape/方向键/单字符等）`);
  }
}

export function buildTools(ctx: Ctx): ToolDefinition[] {
  const { svc, cfg, log } = ctx;
  void log;

  return [
    defineTool({
      name: 'browser_navigate',
      description: '【桌面内置·优先使用】在桌面内嵌浏览器里打开指定 URL。需要打开/操作网页时必须用本系列工具，不要用 skill、shell、pwsh 或 CLI（如 agent-browser）去开浏览器。首次访问未批准的站点会要求先经用户批准。执行后返回新页面快照。',
      parameters: { url: { type: 'string', required: true, description: '要打开的完整 URL' } },
      timeoutMs: 30000,
      async execute(a) {
        const snap = await svc.navigate(S(a['url']));
        return { ok: true, ...snap };
      },
    }),

    defineTool({
      name: 'browser_snapshot',
      description: '【桌面内置·优先使用】抓取当前页面的可访问性快照：带 [ref=eN] 编号的元素树。click/type 等动作都用 ref 定位。做任何操作前先看快照。',
      parameters: {},
      timeoutMs: 20000,
      async execute(a, exec) {
        await svc.ensure(exec.signal);
        return freshSnapshot(ctx);
      },
    }),

    defineTool({
      name: 'browser_click',
      description: '【桌面内置·优先使用】点击快照里的元素。执行后返回新快照。',
      parameters: {
        ref: { type: 'string', required: true, description: '快照里的 [ref=eN] 编号' },
        button: { type: 'string', description: 'left（默认）或 right' },
        doubleClick: { type: 'boolean', description: '是否双击' },
      },
      timeoutMs: 20000,
      async execute(a, exec) {
        await svc.ensure(exec.signal);
        const p = await refToPoint(svc.conn(), svc.refsRegistry(), S(a['ref']));
        const button = S(a['button'], 'left') === 'right' ? 'right' : 'left';
        await mouseClick(ctx, p.x, p.y, button, B(a['doubleClick']) ? 2 : 1);
        await delay(500);
        return { ok: true, ...(await freshSnapshot(ctx)) };
      },
    }),

    defineTool({
      name: 'browser_type',
      description: '【桌面内置·优先使用】向快照里的可编辑元素输入文本（先聚焦再输入，支持中文）。执行后返回新快照。',
      parameters: {
        ref: { type: 'string', required: true, description: '输入框/文本域的 [ref=eN]' },
        text: { type: 'string', required: true, description: '要输入的文本' },
        submit: { type: 'boolean', description: '输入完是否按回车提交' },
        clearFirst: { type: 'boolean', description: '是否先清空已有内容（默认 true）' },
      },
      timeoutMs: 20000,
      async execute(a, exec) {
        await svc.ensure(exec.signal);
        const conn = svc.conn();
        const ref = S(a['ref']);
        const p = await refToPoint(conn, svc.refsRegistry(), ref);
        await mouseClick(ctx, p.x, p.y);
        await delay(200);
        if (B(a['clearFirst'], true)) {
          const objectId = await refToObjectId(conn, svc.refsRegistry(), ref);
          await conn.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: 'function() { if ("value" in this) { this.value = ""; this.dispatchEvent(new Event("input", {bubbles: true})); } }',
          }).catch(() => {});
        }
        await conn.send('Input.insertText', { text: S(a['text']) });
        if (B(a['submit'])) await pressKey(ctx, 'Enter');
        await delay(400);
        return { ok: true, ...(await freshSnapshot(ctx)) };
      },
    }),

    defineTool({
      name: 'browser_press_key',
      description: '【桌面内置·优先使用】按键盘按键：Enter、Tab、Escape、Backspace、Delete、ArrowLeft/Right/Up/Down、Home、End，或单个字符。',
      parameters: {
        key: { type: 'string', required: true, description: '按键名' },
        ref: { type: 'string', description: '可选：先聚焦该元素再按键' },
      },
      timeoutMs: 15000,
      async execute(a, exec) {
        await svc.ensure(exec.signal);
        if (a['ref']) {
          const p = await refToPoint(svc.conn(), svc.refsRegistry(), S(a['ref']));
          await mouseClick(ctx, p.x, p.y);
          await delay(200);
        }
        await pressKey(ctx, S(a['key']));
        await delay(300);
        return { ok: true, ...(await freshSnapshot(ctx)) };
      },
    }),

    defineTool({
      name: 'browser_hover',
      description: '【桌面内置·优先使用】鼠标悬停在元素上（触发 hover 菜单/提示）。',
      parameters: { ref: { type: 'string', required: true, description: '[ref=eN]' } },
      timeoutMs: 15000,
      async execute(a, exec) {
        await svc.ensure(exec.signal);
        const p = await refToPoint(svc.conn(), svc.refsRegistry(), S(a['ref']));
        await svc.conn().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
        await delay(400);
        return { ok: true, ...(await freshSnapshot(ctx)) };
      },
    }),

    defineTool({
      name: 'browser_select_option',
      description: '【桌面内置·优先使用】下拉框选择选项。',
      parameters: {
        ref: { type: 'string', required: true, description: 'select 元素的 [ref=eN]' },
        values: { type: 'array', required: true, description: '要选中的 option value 数组', items: { type: 'string' } },
      },
      timeoutMs: 15000,
      async execute(a, exec) {
        await svc.ensure(exec.signal);
        const conn = svc.conn();
        const objectId = await refToObjectId(conn, svc.refsRegistry(), S(a['ref']));
        const values = Array.isArray(a['values']) ? (a['values'] as unknown[]).map(String) : [];
        await conn.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function() {
            const want = new Set(${JSON.stringify(values)});
            for (const opt of this.options || []) opt.selected = want.has(opt.value) || want.has(opt.text);
            this.dispatchEvent(new Event('input', {bubbles: true}));
            this.dispatchEvent(new Event('change', {bubbles: true}));
            return true;
          }`,
          returnByValue: true,
        });
        await delay(400);
        return { ok: true, ...(await freshSnapshot(ctx)) };
      },
    }),

    defineTool({
      name: 'browser_take_screenshot',
      description: '【桌面内置·优先使用】截取当前页面（JPEG）。用于视觉确认：快照看不清样式/验证码/图片内容时用。',
      parameters: { fullPage: { type: 'boolean', description: '是否截全页（默认只截视口）' } },
      timeoutMs: 20000,
      render: (_a, v) => {
        const r = v as { imageBlock?: unknown; bytes?: number; note?: string };
        const parts: unknown[] = [{ type: 'text', text: r.note ?? `截图已拍摄（JPEG，约 ${r.bytes ?? 0} 字节）` }];
        // 图片块由 host 层的 saveImageBlock 造好（形状见 compat/host.ts 的说明）。
        // **不要退回 OpenAI 式 `image_url`** —— 那会让整轮请求构造失败。
        if (r.imageBlock !== undefined) parts.push(r.imageBlock);
        return parts;
      },
      async execute(a, exec) {
        await svc.ensure(exec.signal);
        const r = await svc.conn().send<{ data?: string }>('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 80,
          captureBeyondViewport: B(a['fullPage']),
        });
        const base64 = typeof r.data === 'string' ? r.data : '';
        const bytes = Buffer.from(base64, 'base64');
        const size = bytes.length;

        // 模型不认图片时不要发图片块：整轮请求会崩在构造阶段，
        // 而且报错信息（`cannot represent ... image_url`）完全不提工具名，排查成本极高。
        // 先问一句再发（取不到 = 不知道，按"能发"走）。
        const capable = exec.modelSupportsImages === undefined ? undefined : await exec.modelSupportsImages();
        if (capable === false) {
          return { bytes: size, note: `截图已拍摄（JPEG，约 ${size} 字节），但当前模型不支持图片输入，没能附上画面。换一个支持图片的模型再试。` };
        }

        const imageBlock = exec.saveImageBlock === undefined
          ? undefined
          : await exec.saveImageBlock(new Uint8Array(bytes), 'image/jpeg', 'browser-screenshot.jpg');
        return {
          bytes: size,
          ...(imageBlock === undefined
            ? { note: `截图已拍摄（JPEG，约 ${size} 字节），但宿主没有可用的附件存储，图片没能附上。` }
            : { imageBlock }),
        };
      },
    }),

    defineTool({
      name: 'browser_wait_for',
      description: '【桌面内置·优先使用】等待：指定文本出现（轮询快照），或单纯等一段时间。最多 30 秒。',
      parameters: {
        text: { type: 'string', description: '要等待出现的文本（不填则只等时长）' },
        timeoutMs: { type: 'number', description: '毫秒，上限 30000' },
      },
      timeoutMs: 35000,
      async execute(a, exec) {
        await svc.ensure(exec.signal);
        const want = S(a['text']).trim();
        const timeout = Math.min(Math.max(N(a['timeoutMs'], want ? 10000 : 3000), 500), 30000);
        if (!want) {
          await delay(timeout);
          return { ok: true, waitedMs: timeout };
        }
        const start = Date.now();
        for (;;) {
          const s = await svc.snapshot();
          if (s.text.includes(want) || (s.title && s.title.includes(want))) {
            return { ok: true, found: true, ...(await freshSnapshot(ctx)) };
          }
          if (Date.now() - start > timeout) return { ok: false, found: false, note: `等了 ${timeout}ms 没见到「${want}」` };
          await delay(600);
        }
      },
    }),

    defineTool({
      name: 'browser_navigate_back',
      description: '【桌面内置·优先使用】浏览器后退。执行后返回新快照。',
      parameters: {},
      timeoutMs: 20000,
      async execute(_a, exec) {
        await svc.ensure(exec.signal);
        const conn = svc.conn();
        const hist = await conn.send<{ currentIndex?: number; entries?: unknown[] }>('Page.getNavigationHistory', {});
        const idx = typeof hist.currentIndex === 'number' ? hist.currentIndex : 0;
        if (idx <= 0) return { ok: false, note: '已经在历史第一页，无处可退' };
        await conn.send('Page.navigateToHistoryEntry', { entryId: (hist.entries?.[idx - 1] as Record<string, unknown>)?.['id'] });
        await delay(800);
        return { ok: true, ...(await freshSnapshot(ctx)) };
      },
    }),

    defineTool({
      name: 'browser_tabs',
      description: '【桌面内置·优先使用】标签页管理：list（列出）、new（新建并打开 URL）、select（切换到指定页）、close（关闭）。',
      parameters: {
        action: { type: 'string', required: true, description: 'list | new | select | close', enum: ['list', 'new', 'select', 'close'] },
        targetId: { type: 'string', description: 'select/close 用，list 返回的 targetId' },
        url: { type: 'string', description: 'new 用，要打开的 URL' },
      },
      timeoutMs: 20000,
      async execute(a, exec) {
        await svc.ensure(exec.signal);
        const action = S(a['action']);
        if (action === 'list') {
          const pages = await svc.listPages();
          return { tabs: pages.map((t) => ({ targetId: t.id, title: t.title, url: t.url, current: t.id === svc.currentTargetId })) };
        }
        if (action === 'new') {
          const t = await svc.newPage(S(a['url'], 'about:blank'));
          await svc.switchTo(t.id);
          return { ok: true, ...(await freshSnapshot(ctx)), note: `已新建并切换到标签页：${t.title}` };
        }
        if (action === 'select') {
          const t = await svc.switchTo(S(a['targetId']));
          return { ok: true, ...(await freshSnapshot(ctx)), note: `已切换到：${t.title}` };
        }
        if (action === 'close') {
          await svc.closePage(S(a['targetId']));
          return { ok: true };
        }
        throw new Error(`browser-use: 未知 action ${action}`);
      },
    }),

    defineTool({
      name: 'browser_handle_dialog',
      description: '【桌面内置·优先使用】处理页面弹出的 alert/confirm/prompt。页面有未处理的对话框时会阻塞后续操作。',
      parameters: {
        accept: { type: 'boolean', description: 'true=确定，false=取消（默认 true）' },
        promptText: { type: 'string', description: 'prompt 弹窗要填的文本' },
      },
      timeoutMs: 15000,
      async execute(a, exec) {
        await svc.ensure(exec.signal);
        const d = svc.takeDialog();
        if (!d) return { ok: false, note: '当前没有待处理的对话框' };
        await svc.conn().send('Page.handleJavaScriptDialog', {
          accept: B(a['accept'], true),
          ...(a['promptText'] !== undefined ? { promptText: S(a['promptText']) } : {}),
        });
        return { ok: true, handled: d };
      },
    }),

    defineTool({
      name: 'browser_evaluate',
      description: '【桌面内置·优先使用】在页面里执行一段 JS 并拿回返回值。危险操作：默认关闭，需插件配置 allowEvaluate=true 才可用。',
      parameters: { expression: { type: 'string', required: true, description: 'JS 表达式' } },
      timeoutMs: 20000,
      async execute(a, exec) {
        if (!cfg.allowEvaluate) {
          throw new Error('browser-use: browser_evaluate 默认关闭（等价 codex 的 full_cdp_access，需审批）。如确需使用，请在插件配置里打开 allowEvaluate。');
        }
        await svc.ensure(exec.signal);
        const r = await svc.conn().send<{ result?: { value?: unknown; description?: string } }>('Runtime.evaluate', {
          expression: S(a['expression']),
          returnByValue: true,
        });
        return { value: r.result?.value ?? r.result?.description ?? null };
      },
    }),

    defineTool({
      name: 'browser_find',
      description: '【桌面内置·优先使用】在当前快照里按关键字搜索，返回带上下文的片段。快照太长时先用它定位，比全量重抓省 token。',
      parameters: { query: { type: 'string', required: true, description: '关键字' } },
      timeoutMs: 20000,
      async execute(a, exec) {
        await svc.ensure(exec.signal);
        const s = await svc.snapshot();
        const q = S(a['query']).toLowerCase();
        const lines = s.text.split('\n');
        const hits: string[] = [];
        lines.forEach((ln, i) => {
          if (ln.toLowerCase().includes(q)) {
            const ctxLines = lines.slice(Math.max(0, i - 1), i + 2);
            hits.push(ctxLines.join('\n'));
          }
        });
        return { query: S(a['query']), hits: hits.slice(0, 20), totalHits: hits.length, url: s.url };
      },
    }),

    defineTool({
      name: 'browser_approve_origin',
      description: '【桌面内置·优先使用】批准模型访问某个站点（origin）。browser_navigate 遇到未批准站点会返回 NEEDS_APPROVAL 并请模型询问用户；用户说"允许"后，模型调这个工具批准，再继续。',
      parameters: { origin: { type: 'string', required: true, description: '例如 https://ops.rrzu.com' } },
      timeoutMs: 10000,
      async execute(a) {
        const origin = S(a['origin']).trim();
        if (!originOf(origin)) throw new Error(`browser-use: ${origin} 不是合法的 http(s) origin`);
        svc.policy.approve(origin);
        return { ok: true, origin, note: `${origin} 已批准，本会话内有效` };
      },
    }),

    defineTool({
      name: 'browser_status',
      description: '【桌面内置·优先使用】看浏览器当前状态：是否运行、当前 URL/标题、有没有待处理的对话框。',
      parameters: {},
      timeoutMs: 10000,
      async execute() {
        return svc.status();
      },
    }),
  ];
}

export function registerBrowserTools(host: HostContract, ctx: Ctx): Array<() => void> {
  return buildTools(ctx).map((t) => host.registerTool(t));
}
