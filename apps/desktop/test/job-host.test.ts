import { describe, expect, it } from 'vitest';
import type { WorkspaceManager } from '@assetforge/core';
import { createPauseGate } from '@assetforge/jobs';
import { createChangeFeed } from '../src/main/change-feed.js';
import { createJobHost } from '../src/main/job-host.js';
import { hangingRemote, noGenerations } from './idle-job-host.js';

// The job host without a scheduler: a cancel goes straight to the database.

/** A manager with or without an open workspace whose every read fails. */
function failingManager(open: boolean): WorkspaceManager {
  return {
    current: () => (open ? ({} as ReturnType<WorkspaceManager['current']>) : null),
    read: async () => {
      throw new Error('database write failed');
    },
  } as unknown as WorkspaceManager;
}

function host(open: boolean) {
  return createJobHost({
    feed: createChangeFeed(),
    manager: failingManager(open),
    vision: () => null,
    images: { jpeg: async () => Buffer.alloc(0) },
    provider: () => null,
    pause: createPauseGate({}),
    firstEntry: () => null,
    ...noGenerations,
    remote: hangingRemote,
  });
}

describe('job host without a scheduler', () => {
  it('rejects a cancel whose database write fails', async () => {
    await expect(host(true).cancel('3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f')).rejects.toThrow();
  });

  it('rejects a cancelAll whose database write fails while a workspace is open', async () => {
    await expect(host(true).cancelAll()).rejects.toThrow();
  });

  it('answers 0 for a cancelAll without a workspace', async () => {
    expect(await host(false).cancelAll()).toBe(0);
  });
});
