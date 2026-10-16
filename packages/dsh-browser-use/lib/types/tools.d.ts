import { type HostContract, type ToolDefinition } from './compat/host.js';
import { type BrowserUseConfig } from './config.js';
import type { BrowserService } from './service.js';
type Ctx = {
    svc: BrowserService;
    cfg: BrowserUseConfig;
    log: (m: string) => void;
};
export declare function buildTools(ctx: Ctx): ToolDefinition[];
export declare function registerBrowserTools(host: HostContract, ctx: Ctx): Array<() => void>;
export {};
//# sourceMappingURL=tools.d.ts.map