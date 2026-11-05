/**
 * `migrate-config` CLI — TypeScript analogue of the .NET
 * `Pipeline.Tools.MigrateConfig.Program` entry point in TASK.md.
 *
 * Usage:
 *
 *   npx ts-node tools/migrate-config/main.ts \
 *     --root <fs-root>            # defaults to process.cwd()
 *     --tenant <name>             # or PIPELINE_STORE_TENANT
 *     --account-url <azure-url>   # or AZURE_STORAGE_ACCOUNT_URL
 *
 * The tool wires an `FsConfigStore` as the read side and an
 * `AzureConfigStore` (via `createAzureConfigStore`, so the production
 * `DefaultAzureCredential` chain authenticates the call) as the write side,
 * delegates to `migrate()` for the per-row work, prints a per-kind summary,
 * and exits 0 when no row failed or 1 otherwise.
 */
import { createAzureConfigStore } from '../../adapters/azure/AzureConfigStore';
import { FsConfigStore } from '../../adapters/fs-config-store/FsConfigStore';
import type { ConfigStoreOptions, Logger } from '../../core/ports';

import { formatSummary, migrate, totalFailed } from './migrate';

export interface ParsedArgs {
  readonly root: string;
  readonly tenant: string;
  readonly accountUrl: string;
}

/**
 * Parse `--root`, `--tenant`, `--account-url` out of `argv` and fall back to
 * `PIPELINE_STORE_TENANT` / `AZURE_STORAGE_ACCOUNT_URL` for the latter two.
 * Throws when a required value is missing on both sides.
 */
export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): ParsedArgs {
  let root: string | undefined;
  let tenant: string | undefined;
  let accountUrl: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        root = argv[++i];
        break;
      case '--tenant':
        tenant = argv[++i];
        break;
      case '--account-url':
        accountUrl = argv[++i];
        break;
      default:
        throw new Error(`migrate-config: unrecognised argument "${arg}"`);
    }
  }

  root ??= cwd;
  tenant ??= env.PIPELINE_STORE_TENANT;
  accountUrl ??= env.AZURE_STORAGE_ACCOUNT_URL;

  if (!tenant) {
    throw new Error(
      'migrate-config: --tenant <name> is required (or set PIPELINE_STORE_TENANT)',
    );
  }
  if (!accountUrl) {
    throw new Error(
      'migrate-config: --account-url <url> is required (or set AZURE_STORAGE_ACCOUNT_URL)',
    );
  }

  return { root, tenant, accountUrl };
}

function defaultLogger(): Logger {
  /* eslint-disable no-console */
  return {
    info: (m, meta) => console.log(`[info ] ${m}`, meta ?? ''),
    warn: (m, meta) => console.warn(`[warn ] ${m}`, meta ?? ''),
    error: (m, meta) => console.error(`[error] ${m}`, meta ?? ''),
    debug: (m, meta) => console.debug(`[debug] ${m}`, meta ?? ''),
  };
  /* eslint-enable no-console */
}

/**
 * Programmatic entry point — returned exit code is what the CLI hands to
 * `process.exit`. Exposed for tests so they can drive the tool without
 * spawning a child process.
 */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  logger: Logger = defaultLogger(),
  out: (line: string) => void = (line) => {
    // eslint-disable-next-line no-console
    console.log(line);
  },
): Promise<number> {
  const args = parseArgs(argv, env, cwd);

  const options: ConfigStoreOptions = {
    tenant: args.tenant,
    backendKind: 'dual',
    azureStorageAccountUrl: args.accountUrl,
    fsRootPath: args.root,
  };

  const source = new FsConfigStore(options);
  const target = createAzureConfigStore(options);

  const summary = await migrate({ source, target, logger });
  for (const line of formatSummary(summary)) out(line);
  return totalFailed(summary) === 0 ? 0 : 1;
}

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
