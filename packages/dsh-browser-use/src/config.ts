/**
 * 插件配置。字段含义见 cordis.patch.yml 注释。
 * 全部手写校验，不依赖 schemastery，保证零运行时依赖。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type BrowserPreference = 'auto' | 'chrome' | 'edge';
export type NewOriginPolicy = 'ask' | 'allow' | 'deny';

export interface ScreencastConfig {
  readonly enabled: boolean;
  /** jpeg 质量 1-100 */
  readonly quality: number;
  /** 帧最大宽度 */
  readonly maxWidth: number;
  /** 每 N 帧取 1 帧 */
  readonly everyNthFrame: number;
}

export interface BrowserUseConfig {
  /** 留空 = 插件自己起浏览器；填了 = 优先连这个 CDP 端点，连不上再自己起 */
  readonly cdpEndpoint: string;
  /** cdpEndpoint 从哪来的（打日志用，方便定位"为什么起了真实浏览器"） */
  readonly cdpEndpointSource: CdpEndpointSource;
  readonly browser: BrowserPreference;
  /** 留空 = <workDir>/browser-profile（独立 profile，不碰日常 Chrome） */
  readonly browserProfileDir: string;
  readonly startUrl: string;
  /** 预批准的 origin，例如 ["https://ops.rrzu.com"] */
  readonly allowedOrigins: readonly string[];
  readonly newOriginPolicy: NewOriginPolicy;
  /** 是否允许 browser_evaluate 执行任意 JS（codex 的 full_cdp_access 对应物），默认关 */
  readonly allowEvaluate: boolean;
  readonly screencast: ScreencastConfig;
  /** 工作目录（插件数据：profile、日志） */
  readonly workDir: string;
}

const BROWSER_PREFS: readonly BrowserPreference[] = ['auto', 'chrome', 'edge'];
const ORIGIN_POLICIES: readonly NewOriginPolicy[] = ['ask', 'allow', 'deny'];

function str(v: unknown, dflt: string): string {
  return typeof v === 'string' ? v : dflt;
}

function num(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.min(max, Math.max(min, n));
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}

function strList(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

export function resolveConfig(raw: unknown, homeDir: string): BrowserUseConfig {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const browser = str(r['browser'], 'auto');
  const newOriginPolicy = str(r['newOriginPolicy'], 'ask');
  const sc = (typeof r['screencast'] === 'object' && r['screencast'] !== null
    ? r['screencast']
    : {}) as Record<string, unknown>;
  const workDir = str(r['workDir'], '').trim() || homeDir;
  const { endpoint: cdpEndpoint, source: cdpEndpointSource } = resolveCdpEndpoint(r);
  return {
    cdpEndpoint,
    cdpEndpointSource,
    browser: (BROWSER_PREFS as readonly string[]).includes(browser) ? (browser as BrowserPreference) : 'auto',
    browserProfileDir: str(r['browserProfileDir'], '').trim(),
    startUrl: str(r['startUrl'], 'about:blank').trim() || 'about:blank',
    allowedOrigins: strList(r['allowedOrigins']),
    newOriginPolicy: (ORIGIN_POLICIES as readonly string[]).includes(newOriginPolicy)
      ? (newOriginPolicy as NewOriginPolicy)
      : 'ask',
    allowEvaluate: bool(r['allowEvaluate'], false),
    screencast: {
      enabled: bool(sc['enabled'], true),
      quality: num(sc['quality'], 70, 1, 100),
      maxWidth: num(sc['maxWidth'], 1280, 320, 3840),
      everyNthFrame: num(sc['everyNthFrame'], 2, 1, 10),
    },
    workDir,
  };
}

/** 中继端点从哪来的（打日志用，方便定位"为什么起了真实浏览器"）。 */
export type CdpEndpointSource = '插件配置' | '环境变量 DSH_BROWSER_USE_CDP' | '文件 agent-browser-cdp.json' | '';

/**
 * 桌面壳（dsh-desktop fork）起的 CDP 中继端点。
 * 优先级：显式插件配置 > 环境变量 DSH_BROWSER_USE_CDP > <DSH_HOME>/agent-browser-cdp.json。
 * Electron main 在拉起 dsh 子进程前同时写环境变量和文件；DSH_HOME 本来就在子进程 env 里。
 */
export function resolveCdpEndpoint(raw: unknown): { endpoint: string; source: CdpEndpointSource } {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const fromConfig = str(r['cdpEndpoint'], '').trim().replace(/\/+$/u, '');
  if (fromConfig) return { endpoint: fromConfig, source: '插件配置' };
  const fromEnv = (process.env['DSH_BROWSER_USE_CDP'] ?? '').trim().replace(/\/+$/u, '');
  if (fromEnv) return { endpoint: fromEnv, source: '环境变量 DSH_BROWSER_USE_CDP' };
  const fromFile = readRelayEndpointFile();
  if (fromFile) return { endpoint: fromFile, source: '文件 agent-browser-cdp.json' };
  return { endpoint: '', source: '' };
}

/** 读 <DSH_HOME>/agent-browser-cdp.json；没有/坏了就返回空串（不是故障）。 */
function readRelayEndpointFile(): string {
  try {
    const dshHome = (process.env['DSH_HOME'] ?? '').trim();
    if (!dshHome) return '';
    const raw = readFileSync(join(dshHome, 'agent-browser-cdp.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || !parsed) return '';
    const endpoint = (parsed as Record<string, unknown>)['cdpEndpoint'];
    return typeof endpoint === 'string' ? endpoint.trim().replace(/\/+$/u, '') : '';
  } catch {
    return '';
  }
}

/** profile 目录：配置留空就用 <workDir>/browser-profile */
export function resolveProfileDir(cfg: BrowserUseConfig): string {
  const p = cfg.browserProfileDir.trim();
  if (p.length > 0) return p;
  return `${cfg.workDir.replace(/\/+$/u, '')}/browser-profile`;
}

export function originOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}
