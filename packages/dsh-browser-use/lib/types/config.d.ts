export type BrowserPreference = 'auto' | 'chrome' | 'edge';
export type NewOriginPolicy = 'ask' | 'allow' | 'deny';
export interface ScreencastConfig {
    readonly enabled: boolean;
    readonly quality: number;
    readonly maxWidth: number;
    readonly everyNthFrame: number;
}
export interface BrowserUseConfig {
    readonly cdpEndpoint: string;
    readonly cdpEndpointSource: CdpEndpointSource;
    readonly browser: BrowserPreference;
    readonly browserProfileDir: string;
    readonly startUrl: string;
    readonly allowedOrigins: readonly string[];
    readonly newOriginPolicy: NewOriginPolicy;
    readonly allowEvaluate: boolean;
    readonly screencast: ScreencastConfig;
    readonly workDir: string;
}
export declare function resolveConfig(raw: unknown, homeDir: string): BrowserUseConfig;
export type CdpEndpointSource = '插件配置' | '环境变量 DSH_BROWSER_USE_CDP' | '文件 agent-browser-cdp.json' | '';
export declare function resolveCdpEndpoint(raw: unknown): {
    endpoint: string;
    source: CdpEndpointSource;
};
export declare function resolveProfileDir(cfg: BrowserUseConfig): string;
export declare function originOf(url: string): string;
//# sourceMappingURL=config.d.ts.map