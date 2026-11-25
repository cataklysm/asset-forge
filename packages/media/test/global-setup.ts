import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * A worker thread cannot load TypeScript source, so the tests run the worker from an esbuild
 * bundle. Sharp stays external and resolves from `packages/media/node_modules`.
 */
export async function setup(): Promise<void> {
  await build({
    entryPoints: [fileURLToPath(new URL('../src/preview-worker.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['sharp'],
    outfile: fileURLToPath(new URL('../.test-build/preview-worker.mjs', import.meta.url)),
    logLevel: 'warning',
  });
}
