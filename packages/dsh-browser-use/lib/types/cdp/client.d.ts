export declare class CdpUnreachableError extends Error {
    readonly endpoint: string;
    readonly code: string;
    constructor(endpoint: string, reason: string);
}
export declare class CdpProtocolError extends Error {
    readonly code: string;
    constructor(message: string);
}
export declare class CdpCommandTimeoutError extends CdpProtocolError {
    readonly method: string;
    readonly timeoutMs: number;
    readonly code: string;
    constructor(method: string, timeoutMs: number);
}
export interface CdpTarget {
    readonly id: string;
    readonly type: string;
    readonly title: string;
    readonly url: string;
    readonly webSocketDebuggerUrl: string;
}
export declare function listTargets(endpoint: string, timeoutMs?: number): Promise<CdpTarget[]>;
export declare function createTarget(endpoint: string, url: string, timeoutMs?: number): Promise<CdpTarget>;
export declare function closeTarget(endpoint: string, targetId: string): Promise<void>;
type EventHandler = (params: Record<string, unknown>, sessionId: string) => void;
export declare class CdpConnection {
    private readonly socket;
    private readonly label;
    private readonly log;
    private nextId;
    private readonly pending;
    private readonly handlers;
    private closed;
    private constructor();
    static connect(url: string, label: string, log: (m: string) => void, timeoutMs?: number): Promise<CdpConnection>;
    get isClosed(): boolean;
    send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>;
    on(method: string, handler: EventHandler): () => void;
    private dispatch;
    close(): void;
}
export declare class BrowserHub {
    readonly endpoint: string;
    private readonly conn;
    private readonly log;
    private constructor();
    static attach(endpoint: string, log: (m: string) => void): Promise<BrowserHub>;
    createPage(url?: string): Promise<CdpTarget>;
    onTargetCreated(handler: (targetId: string, url: string) => void): () => void;
    close(): void;
}
export declare function connectPage(target: CdpTarget, log: (m: string) => void): Promise<CdpConnection>;
export {};
//# sourceMappingURL=client.d.ts.map