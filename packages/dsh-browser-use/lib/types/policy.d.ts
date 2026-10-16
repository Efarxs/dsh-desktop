import { type NewOriginPolicy } from './config.js';
export type OriginVerdict = 'allow' | 'needs_approval' | 'deny';
export declare class OriginPolicy {
    private readonly preApproved;
    private readonly newOriginPolicy;
    private readonly runtimeApproved;
    constructor(preApproved: readonly string[], newOriginPolicy: NewOriginPolicy);
    approve(origin: string): void;
    isApproved(origin: string): boolean;
    check(url: string): {
        verdict: OriginVerdict;
        origin: string;
    };
    approvalMessage(origin: string): string;
}
//# sourceMappingURL=policy.d.ts.map