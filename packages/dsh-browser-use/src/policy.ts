/**
 * 按 origin 的访问审批（对标 codex BrowserUseOriginPolicy.full_cdp_access）。
 * - 配置 allowedOrigins：预批准，一直放行
 * - 运行时批准：模型调 browser_approve_origin，用户在对话里说"允许"后模型执行
 * - 新 origin 策略 newOriginPolicy: ask（默认，工具返回 NEEDS_APPROVAL 让模型去问用户）
 *   / allow（直接放行） / deny（直接拒绝）
 */
import { originOf, type NewOriginPolicy } from './config.js';

export type OriginVerdict = 'allow' | 'needs_approval' | 'deny';

export class OriginPolicy {
  private readonly runtimeApproved = new Set<string>();

  constructor(
    private readonly preApproved: readonly string[],
    private readonly newOriginPolicy: NewOriginPolicy,
  ) {}

  approve(origin: string): void {
    if (origin) this.runtimeApproved.add(origin);
  }

  isApproved(origin: string): boolean {
    return this.preApproved.includes(origin) || this.runtimeApproved.has(origin);
  }

  check(url: string): { verdict: OriginVerdict; origin: string } {
    const origin = originOf(url);
    if (!origin) return { verdict: 'allow', origin }; // about:blank、chrome:// 等
    if (this.isApproved(origin)) return { verdict: 'allow', origin };
    if (this.newOriginPolicy === 'allow') return { verdict: 'allow', origin };
    if (this.newOriginPolicy === 'deny') return { verdict: 'deny', origin };
    return { verdict: 'needs_approval', origin };
  }

  approvalMessage(origin: string): string {
    return [
      `NEEDS_APPROVAL：模型想访问 ${origin}，该站点尚未被批准。`,
      '请用中文询问用户是否允许。用户说"允许/可以"后，调用 browser_approve_origin(origin) 再继续；',
      '用户拒绝则停止该站点的操作并说明。',
    ].join('\n');
  }
}
