import { CdpConnection, type CdpTarget } from './cdp/client.js';
import { RefRegistry } from './cdp/snapshot.js';
import { type BrowserUseConfig } from './config.js';
import { OriginPolicy } from './policy.js';
export interface DialogInfo {
    readonly type: string;
    readonly message: string;
    readonly url: string;
}
export declare class BrowserService {
    private readonly cfg;
    private readonly log;
    private hub;
    private pageConn;
    private target;
    private endpoint;
    private browserLabel;
    private launchedOwn;
    private starting;
    private readonly refs;
    private readonly dialogs;
    readonly policy: OriginPolicy;
    constructor(cfg: BrowserUseConfig, log: (m: string) => void);
    get isRunning(): boolean;
    get currentTargetId(): string;
    get currentUrl(): string;
    ensure(signal?: AbortSignal): Promise<void>;
    private wirePage;
    private start;
    conn(): CdpConnection;
    refsRegistry(): RefRegistry;
    status(): Record<string, unknown>;
    snapshot(): Promise<{
        text: string;
        url: string;
        title: string;
    }>;
    navigate(url: string, signal?: AbortSignal): Promise<{
        text: string;
        url: string;
        title: string;
    }>;
    takeDialog(): DialogInfo | undefined;
    peekDialogs(): readonly DialogInfo[];
    switchTo(targetId: string): Promise<CdpTarget>;
    listPages(): Promise<CdpTarget[]>;
    newPage(url: string): Promise<CdpTarget>;
    closePage(targetId: string): Promise<void>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=service.d.ts.map