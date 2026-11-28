import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import electron from 'electron';
import { build } from 'vite';
import assert from 'node:assert/strict';

// Build only the test entry in a temporary directory, leaving the application's out/ and user data untouched.
const temporary = await mkdtemp(path.join(tmpdir(), 'assetforge-discovery-smoke-'));
const entryArgument = process.argv.find((argument) => argument.startsWith('--entry='));
try {
  // Some managed Windows workspaces give the installed runtime an ACL Chromium cannot read.
  // Only the temporary runtime copy gets Chromium's read permission; installed files stay unchanged.
  let runtime = electron;
  if (process.argv.includes('--copy-runtime')) {
    const runtimeDirectory = path.join(temporary, 'runtime');
    await cp(path.dirname(electron), runtimeDirectory, { recursive: true });
    if (process.platform === 'win32') {
      await promisify(execFile)('icacls', [runtimeDirectory, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/T'], {
        windowsHide: true,
      });
    }
    runtime = path.join(runtimeDirectory, path.basename(electron));
  }
  await build({
    configFile: false,
    logLevel: 'warn',
    ssr: { noExternal: true },
    build: {
      ssr:
        entryArgument === undefined
          ? fileURLToPath(new URL('./site-discovery-smoke.mjs', import.meta.url))
          : path.resolve(entryArgument.slice('--entry='.length)),
      outDir: path.join(temporary, 'bundle'),
      emptyOutDir: true,
      target: 'node24',
      minify: false,
      rolldownOptions: { external: ['electron'], output: { entryFileNames: 'smoke.mjs' } },
    },
  });
  const environment = { ...process.env, ASSETFORGE_SMOKE_USER_DATA: path.join(temporary, 'user-data') };
  delete environment.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(runtime, ['--enable-logging=stderr', path.join(temporary, 'bundle', 'smoke.mjs')], {
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Native discovery smoke timed out'));
    }, 45_000);
    child.on('error', reject);
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve(status ?? 1);
    });
  });
  process.exitCode = code;
} finally {
  assert.equal(path.dirname(temporary), path.resolve(tmpdir()), 'Cleanup must stay in the owned temporary directory');
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
