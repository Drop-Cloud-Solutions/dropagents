/**
 * Pack id → the factory for that pack's StackHooks. A pack with no code
 * (flows and personas only) simply has no entry here.
 *
 * Hosts call {@link stackHooksFor} with the ENABLED packs; nothing from a
 * pack that is not enabled is ever constructed.
 */
import type { StackHooks } from '../core/ports/StackHooks';
import type { Logger } from '../core/ports/Logger';
import type { PackManifest } from '../config/packs';

import { createDotnetAzureHooks } from './dotnet-azure/code';

export interface StackHookContext {
    /** Workspace clones on disk (repo id + absolute path). */
    readonly listRepos: () => ReadonlyArray<{ readonly repoId: string; readonly path: string }>;
    readonly logger: Logger;
}

const FACTORIES: Readonly<Record<string, (ctx: StackHookContext) => StackHooks>> = {
    'dotnet-azure': (ctx) => createDotnetAzureHooks(ctx),
};

export function stackHooksFor(
    packs: readonly PackManifest[],
    ctx: StackHookContext,
): StackHooks[] {
    const out: StackHooks[] = [];
    for (const pack of packs) {
        const factory = FACTORIES[pack.id];
        if (factory) out.push(factory(ctx));
    }
    return out;
}
