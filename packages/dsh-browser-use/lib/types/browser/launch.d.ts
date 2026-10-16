import type { BrowserPreference } from '../config.js';
export type BrowserKind = 'chrome' | 'edge';
export interface BrowserCandidate {
    readonly kind: BrowserKind;
    readonly label: string;
    readonly path: string;
}
export declare const BROWSER_KIND_LABELS: Record<BrowserKind, string>;
type Env = Readonly<Record<string, string | undefined>>;
export declare function candidatePaths(kind: BrowserKind, platform: NodeJS.Platform, env: Env): readonly string[];
export declare function detectBrowsers(platform?: NodeJS.Platform, env?: Env): readonly BrowserCandidate[];
export declare function pickBrowser(candidates: readonly BrowserCandidate[], preference: BrowserPreference): BrowserCandidate | undefined;
export declare function buildLaunchArgs(port: number, profileDir: string, url: string): string[];
export declare function spawnBrowser(path: string, args: readonly string[]): void;
export declare function portOf(endpoint: string): number;
export declare function probeEndpoint(endpoint: string, timeoutMs?: number): Promise<boolean>;
export declare function waitForEndpoint(endpoint: string, options?: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
}): Promise<void>;
export declare function readActivePort(profileDir: string): number | undefined;
export declare function clearActivePort(profileDir: string): void;
export declare function liveEndpointFromProfile(profileDir: string): Promise<string | undefined>;
export interface LaunchRequest {
    readonly candidate: BrowserCandidate;
    readonly profileDir: string;
    readonly url: string;
    readonly timeoutMs?: number;
}
export declare function launchBrowser(request: LaunchRequest): Promise<{
    readonly endpoint: string;
    readonly label: string;
}>;
export {};
//# sourceMappingURL=launch.d.ts.map