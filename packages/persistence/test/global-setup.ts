import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** The built backup check worker the tests run. */
export const BACKUP_CHECK_WORKER_BUILD = '../.test-build/backup-check-worker.mjs';

/**
 * A worker thread cannot load TypeScript source, so the tests run the backup check worker from an esbuild bundle.
 * better-sqlite3 stays external and resolves from `packages/persistence/node_modules`.
 */
export async function setup(): Promise<void> {
  await build({
    entryPoints: [fileURLToPath(new URL('../src/backup-check-worker.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['better-sqlite3'],
    outfile: fileURLToPath(new URL(BACKUP_CHECK_WORKER_BUILD, import.meta.url)),
    logLevel: 'warning',
  });
}
