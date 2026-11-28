import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_QUIT_DEADLINE_MS } from '@assetforge/contracts';
import { closeApp, type ShutdownParts } from '../src/main/app-shutdown.js';

/**
 * Shutdown parts that record every call in order.
 *
 * @param calls the list the calls are recorded in
 * @param failing the steps that reject
 * @returns the parts
 */
function recordingParts(calls: string[], failing: string[] = []): ShutdownParts {
  const step = (name: string) => async () => {
    calls.push(name);
    if (failing.includes(name)) throw new Error(name);
  };
  return {
    siteSessions: { shutdown: () => void calls.push('sessions.shutdown') },
    manager: {
      cancelImport: () => {
        calls.push('manager.cancelImport');
        return true;
      },
      close: step('manager.close'),
    },
    services: { workspaceClosing: step('services.workspaceClosing') },
    restores: { abortAll: () => void calls.push('restores.abortAll') },
    previews: { close: step('previews.close') },
    logError: (message) => void calls.push(`log ${message}`),
    flushLog: async () => void calls.push('log.flush'),
  };
}

describe('closing the app', () => {
  it('cancels a running import before the jobs stop and the workspace closes', async () => {
    const calls: string[] = [];
    await closeApp(recordingParts(calls));
    expect(calls).toEqual([
      'sessions.shutdown',
      'manager.cancelImport',
      'restores.abortAll',
      'services.workspaceClosing',
      'manager.close',
      'previews.close',
      'log.flush',
    ]);
  });

  it('still closes the preview service when closing the workspace failed', async () => {
    const calls: string[] = [];
    await closeApp(recordingParts(calls, ['manager.close']));
    expect(calls).toEqual([
      'sessions.shutdown',
      'manager.cancelImport',
      'restores.abortAll',
      'services.workspaceClosing',
      'manager.close',
      'log Closing the workspace failed',
      'previews.close',
      'log.flush',
    ]);
  });

  it('closes the workspace with the quit deadline for its final backup, after the jobs stopped', async () => {
    const calls: string[] = [];
    const parts = recordingParts(calls);
    const close = vi.fn(async (options?: { backupDeadlineMs?: number }) => {
      calls.push(`manager.close ${options?.backupDeadlineMs}`);
    });
    await closeApp({ ...parts, manager: { ...parts.manager, close } });
    expect(close).toHaveBeenCalledWith({ backupDeadlineMs: BACKUP_QUIT_DEADLINE_MS });
    expect(calls.indexOf(`manager.close ${BACKUP_QUIT_DEADLINE_MS}`)).toBeGreaterThan(
      calls.indexOf('services.workspaceClosing'),
    );
  });

  describe('with a hanging backup', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('resolves once the deadline passed to the close has run out', async () => {
      vi.useFakeTimers();
      const calls: string[] = [];
      const parts = recordingParts(calls);
      // Stands in for the manager: the final backup never finishes, the close gives it up at the deadline.
      const close = (options?: { backupDeadlineMs?: number }) =>
        new Promise<void>((resolve) => setTimeout(resolve, options?.backupDeadlineMs ?? Number.MAX_SAFE_INTEGER));
      let settled = false;
      const closing = closeApp({ ...parts, manager: { ...parts.manager, close } }).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(BACKUP_QUIT_DEADLINE_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(settled).toBe(true);
      expect(calls.slice(-2)).toEqual(['previews.close', 'log.flush']);
    });
  });

  it('never rejects when the final backup fails', async () => {
    const calls: string[] = [];
    const parts = recordingParts(calls);
    const close = async () => {
      throw new Error('backup failed');
    };
    await expect(closeApp({ ...parts, manager: { ...parts.manager, close } })).resolves.toBeUndefined();
    expect(calls.slice(-3)).toEqual(['log Closing the workspace failed', 'previews.close', 'log.flush']);
  });

  it('never rejects when closing the preview service failed', async () => {
    const calls: string[] = [];
    await expect(closeApp(recordingParts(calls, ['previews.close']))).resolves.toBeUndefined();
    expect(calls.slice(-2)).toEqual(['log Closing the preview service failed', 'log.flush']);
  });
});
