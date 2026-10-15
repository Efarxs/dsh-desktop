/**
 * 可访问性快照：Accessibility.getFullAXTree → 过滤 → 带 [ref=eN] 的文本。
 * ref 是框架层自编号（CDP 原生没有），click/type 等工具拿 ref 反查 backendDOMNodeId。
 */
import type { CdpConnection } from './client.js';

export interface RefEntry {
  readonly backendDOMNodeId: number;
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch',
  'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'slider', 'spinbutton', 'treeitem',
]);

interface AXNode {
  nodeId: string;
  role?: { value?: string };
  name?: { value?: unknown };
  value?: { value?: unknown };
  description?: { value?: unknown };
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
  childIds?: string[];
  ignored?: boolean;
  backendDOMNodeId?: number;
}

function strVal(v: { value?: unknown } | undefined): string {
  if (!v) return '';
  return typeof v.value === 'string' ? v.value : '';
}

function propOf(node: AXNode, name: string): unknown {
  for (const p of node.properties ?? []) {
    if (p.name === name) return p.value?.value;
  }
  return undefined;
}

export class RefRegistry {
  private map = new Map<string, RefEntry>();
  private counter = 0;

  reset(): void {
    this.map.clear();
    this.counter = 0;
  }

  alloc(backendDOMNodeId: number): string {
    this.counter += 1;
    const ref = `e${this.counter}`;
    this.map.set(ref, { backendDOMNodeId });
    return ref;
  }

  get(ref: string): RefEntry | undefined {
    return this.map.get(ref);
  }
}

export interface SnapshotResult {
  readonly text: string;
  readonly url: string;
  readonly title: string;
}

/** 抓快照并重建 ref 注册表 */
export async function takeSnapshot(conn: CdpConnection, refs: RefRegistry): Promise<SnapshotResult> {
  const ax = await conn.send<{ nodes?: AXNode[] }>('Accessibility.getFullAXTree', {});
  const nodes = ax.nodes ?? [];
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    for (const c of n.childIds ?? []) {
      const arr = childrenOf.get(n.nodeId) ?? [];
      arr.push(c);
      childrenOf.set(n.nodeId, arr);
    }
  }
  const childSet = new Set<string>();
  for (const ids of childrenOf.values()) for (const id of ids) childSet.add(id);
  const roots = nodes.filter((n) => !childSet.has(n.nodeId));

  refs.reset();
  const lines: string[] = [];
  const render = (node: AXNode, depth: number): void => {
    // ignored = 装饰节点：自己不画，但 children 照常递归（否则整棵树都没了）
    if (!node.ignored) {
      const role = node.role?.value ?? '';
      const name = strVal(node.name).replace(/\s+/gu, ' ').trim().slice(0, 120);
      const value = strVal(node.value).replace(/\s+/gu, ' ').trim().slice(0, 120);
      const backendId = node.backendDOMNodeId;
      const interactive = INTERACTIVE_ROLES.has(role);
      const hasContent = name.length > 0 || value.length > 0;

      if (interactive || (hasContent && role !== '')) {
        const indent = '  '.repeat(Math.min(depth, 8));
        let ref = '';
        if (typeof backendId === 'number' && backendId > 0 && (interactive || hasContent)) {
          ref = ` [ref=${refs.alloc(backendId)}]`;
        }
        let line = `${indent}- ${role || 'text'}`;
        if (name) line += ` "${name}"`;
        if (value && role !== 'StaticText') line += `: "${value}"`;
        const states: string[] = [];
        if (propOf(node, 'disabled') === true) states.push('disabled');
        if (propOf(node, 'checked') === true) states.push('checked');
        if (propOf(node, 'focused') === true) states.push('focused');
        if (propOf(node, 'expanded') === true) states.push('expanded');
        if (states.length > 0) line += ` [${states.join(', ')}]`;
        line += ref;
        lines.push(line);
      } else if (role === 'StaticText' && name) {
        const indent = '  '.repeat(Math.min(depth, 8));
        lines.push(`${indent}- text "${name.slice(0, 200)}"`);
      }
    }
    for (const cid of childrenOf.get(node.nodeId) ?? []) {
      const child = byId.get(cid);
      if (child) render(child, depth + 1);
    }
  };
  for (const r of roots) render(r, 0);

  // 当前页面 url/title（尽量拿，拿不到不致命）
  let url = '';
  let title = '';
  try {
    const info = await conn.send<{ url?: string; title?: string }>('Target.getTargetInfo', {});
    // page 直连时 Target.getTargetInfo 可能不可用，换 Runtime 拿
    url = typeof info['url'] === 'string' ? (info['url'] as string) : '';
    title = typeof info['title'] === 'string' ? (info['title'] as string) : '';
  } catch { /* ignore */ }
  if (!url || !title) {
    try {
      const ev = await conn.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: '({url: location.href, title: document.title})',
        returnByValue: true,
      });
      const v = ev.result?.value as Record<string, unknown> | undefined;
      if (v) {
        url = typeof v['url'] === 'string' ? (v['url'] as string) : url;
        title = typeof v['title'] === 'string' ? (v['title'] as string) : title;
      }
    } catch { /* ignore */ }
  }
  return { text: lines.join('\n'), url, title };
}

/** ref → 可点击坐标（元素中心点，CSS 像素） */
export async function refToPoint(
  conn: CdpConnection,
  refs: RefRegistry,
  ref: string,
): Promise<{ x: number; y: number }> {
  const entry = refs.get(ref);
  if (!entry) throw new Error(`browser-use: 找不到 ${ref}，快照可能已过期，请重新 browser_snapshot`);
  const resolved = await conn.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
    backendNodeId: entry.backendDOMNodeId,
  });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error(`browser-use: ${ref} 对应的元素已不在 DOM 里，快照已过期`);
  try {
    await conn.send('DOM.scrollIntoViewIfNeeded', { objectId });
  } catch { /* 有些元素滚不动，直接取坐标 */ }
  const box = await conn.send<{ model?: { content?: number[] } }>('DOM.getBoxModel', { objectId });
  const quad = box.model?.content;
  if (!quad || quad.length < 8) throw new Error(`browser-use: ${ref} 取不到可视坐标（元素可能不可见）`);
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

/** ref → objectId（给 evaluate / fill 用） */
export async function refToObjectId(
  conn: CdpConnection,
  refs: RefRegistry,
  ref: string,
): Promise<string> {
  const entry = refs.get(ref);
  if (!entry) throw new Error(`browser-use: 找不到 ${ref}，快照可能已过期，请重新 browser_snapshot`);
  const resolved = await conn.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
    backendNodeId: entry.backendDOMNodeId,
  });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error(`browser-use: ${ref} 对应的元素已不在 DOM 里，快照已过期`);
  return objectId;
}
