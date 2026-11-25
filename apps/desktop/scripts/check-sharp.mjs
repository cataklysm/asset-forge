// Proves that Sharp loads in a worker thread of a real Electron main process.
// Usage (ELECTRON_RUN_AS_NODE unset): electron scripts/check-sharp.mjs <worker-path>
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { app } from 'electron';

// A 40x20 red PNG; the main thread must not import Sharp to create it.
const SOURCE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAALklEQVRIie3VwQkAMBACwem/aVPGQVjwL4i6xolkrKhXuTQnHci6TEFCWPQ/Fh99+h0OPLImvgAAAABJRU5ErkJggg==';

const TIMEOUT_MS = 15000;

function finish(ok, detail) {
  console.log(ok ? 'sharp-check: ok' : `sharp-check: failed${detail ? ` (${detail})` : ''}`);
  app.exit(ok ? 0 : 1);
}

function runJob(workerPath, job) {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(workerPath);
    const timer = setTimeout(() => reject(new Error('worker did not answer')), TIMEOUT_MS);
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once('message', (response) => {
      clearTimeout(timer);
      void worker.terminate().then(() => resolvePromise(response));
    });
    worker.postMessage({ id: 1, job });
  });
}

async function main() {
  // argv: [electron, script, ...]; Chromium switches such as --user-data-dir are skipped.
  const workerArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (!workerArg) {
    finish(false, 'missing worker path');
    return;
  }
  await app.whenReady();
  const dir = mkdtempSync(join(app.getPath('temp'), 'assetforge-sharp-check-'));
  try {
    const sourcePath = join(dir, 'source.png');
    const targetPath = join(dir, 'preview.webp');
    writeFileSync(sourcePath, Buffer.from(SOURCE_PNG_BASE64, 'base64'));
    const response = await runJob(resolve(workerArg), { sourcePath, targetPath, longestEdge: 10 });
    const written = response?.result === 'ok' && statSync(targetPath).size > 0;
    rmSync(dir, { recursive: true, force: true });
    finish(written, written ? undefined : `worker answered ${JSON.stringify(response)}`);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    finish(false, error instanceof Error ? error.message : 'unexpected error');
  }
}

void main();
