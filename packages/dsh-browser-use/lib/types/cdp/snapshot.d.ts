import type { CdpConnection } from './client.js';
export interface RefEntry {
    readonly backendDOMNodeId: number;
}
export declare class RefRegistry {
    private map;
    private counter;
    reset(): void;
    alloc(backendDOMNodeId: number): string;
    get(ref: string): RefEntry | undefined;
}
export interface SnapshotResult {
    readonly text: string;
    readonly url: string;
    readonly title: string;
}
export declare function takeSnapshot(conn: CdpConnection, refs: RefRegistry): Promise<SnapshotResult>;
export declare function refToPoint(conn: CdpConnection, refs: RefRegistry, ref: string): Promise<{
    x: number;
    y: number;
}>;
export declare function refToObjectId(conn: CdpConnection, refs: RefRegistry, ref: string): Promise<string>;
//# sourceMappingURL=snapshot.d.ts.map