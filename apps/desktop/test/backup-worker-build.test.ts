import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import config, { BACKUP_CHECK_WORKER_ENTRY } from '../electron.vite.config.js';

/** The part of the build configuration the test reads. */
type MainInput = { main?: { build?: { rolldownOptions?: { input?: Record<string, string> } } } };

describe('the backup check worker build input', () => {
  it('names a source file that exists', async () => {
    await expect(access(BACKUP_CHECK_WORKER_ENTRY)).resolves.toBeUndefined();
  });

  it('is built under the name the main process loads (backup-check-worker.js)', () => {
    const resolve = config as unknown as (env: { command: string; mode: string }) => MainInput;
    const input = resolve({ command: 'build', mode: 'production' }).main?.build?.rolldownOptions?.input;
    expect(input?.['backup-check-worker']).toBe(BACKUP_CHECK_WORKER_ENTRY);
  });
});
