import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * A worker thread cannot load TypeScript source, so the main tests run the backup check worker from an esbuild
 * bundle (`test/backup-worker.ts` names it). better-sqlite3 stays external and resolves from
 * `apps/desktop/node_modules`.
 *
 * @returns resolves once the worker is built
 */
export async function setup(): Promise<void> {
  await build({
    entryPoints: [fileURLToPath(new URL('../../../packages/persistence/src/backup-check-worker.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['better-sqlite3'],
    outfile: fileURLToPath(new URL('../.test-build/backup-check-worker.mjs', import.meta.url)),
    logLevel: 'warning',
  });
}
