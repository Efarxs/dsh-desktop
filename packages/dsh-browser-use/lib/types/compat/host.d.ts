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
    readonly render?: (args: unknown, value: unknown) => readonly unknown[];
    execute(args: unknown, ctx: ToolRunContext): Promise<unknown>;
}
export interface ToolRunContext {
    readonly signal: AbortSignal;
    readonly saveImageBlock?: (data: Uint8Array, mediaType: string, name?: string) => Promise<unknown | undefined>;
    readonly modelSupportsImages?: () => Promise<boolean | undefined>;
}
export type HttpMethod = 'GET' | 'HEAD' | 'POST';
export interface HttpRoute {
    readonly path: string;
    readonly methods: readonly HttpMethod[];
    handle(request: {
        readonly method: string;
        readonly url: string;
    }): Promise<Response>;
}
export interface HostContract {
    registerTool(tool: ToolDefinition): () => void;
    effect(callback: () => void | (() => void), label: string): void;
    registerHttpRoute(route: HttpRoute): (() => void) | undefined;
    withConnection(install: (host: HostContract) => void): void;
}
export declare function toJsonSchema(params: Readonly<Record<string, ToolParameter>>): Record<string, unknown>;
export declare function defineTool(spec: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, ToolParameter>>;
    readonly timeoutMs?: number;
    readonly render?: (args: Record<string, unknown>, value: unknown) => readonly unknown[];
    execute(args: Record<string, unknown>, ctx: ToolRunContext): Promise<unknown>;
}): ToolDefinition;
export declare function createHost(context: unknown, log: (m: string) => void): HostContract;
//# sourceMappingURL=host.d.ts.map