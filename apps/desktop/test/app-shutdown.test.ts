import { describe, expect, it } from 'vitest';
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
      'services.workspaceClosing',
      'manager.close',
      'log Closing the workspace failed',
      'previews.close',
      'log.flush',
    ]);
  });

  it('never rejects when closing the preview service failed', async () => {
    const calls: string[] = [];
    await expect(closeApp(recordingParts(calls, ['previews.close']))).resolves.toBeUndefined();
    expect(calls.slice(-2)).toEqual(['log Closing the preview service failed', 'log.flush']);
  });
});
