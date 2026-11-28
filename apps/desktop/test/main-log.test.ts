import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetForgeError, type WorkspaceManager, type WorkspaceSession } from '@assetforge/core';
import { createPauseGate } from '@assetforge/jobs';
import { InMemoryJobRepository } from '../../../packages/core/test/memory-jobs.js';
import { createChangeFeed } from '../src/main/change-feed.js';
import { createWorkspaceHost } from '../src/main/composition.js';
import { dispatch, toIpcError, type IpcHandlers } from '../src/main/ipc.js';
import { createJobHost } from '../src/main/job-host.js';
import {
  IPC_CONTRACT_EVENT,
  IPC_FAILED_EVENT,
  ipcContractLine,
  ipcFailureLine,
  JOB_RECOVERY_EVENT,
  jobRecoveryLine,
  schedulerLogLine,
} from '../src/main/main-log.js';
import { hangingRemote, noGenerations } from './idle-job-host.js';

// The lines of the main process: fixed texts, ids, counts and codes, never a path, a name or a message.

const MARKER = 'SECRET_PATH_MARKER';
const WORKSPACE = '5c1e7a90-2b3d-4f4e-8a6b-7c8d9e0f1a2b';

/**
 * A Node-like error with the marker in every text field.
 *
 * @param code the system code
 * @returns the error
 */
function pathError(code: string): Error {
  return Object.assign(new Error(`${code}: open '/data/${MARKER}/a.png'`), {
    code,
    syscall: 'open',
    path: `/data/${MARKER}/a.png`,
    stack: `Error: at /data/${MARKER}/a.png`,
  });
}

/**
 * Checks that no line carries the marker.
 *
 * @param lines the lines written
 */
function expectNoMarker(lines: readonly string[]): void {
  for (const line of lines) expect(line).not.toContain(MARKER);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the main log lines', () => {
  it('describe a failed IPC handler by its channel and the safe error', () => {
    expect(ipcFailureLine('files:list', pathError('SQLITE_BUSY'))).toBe(
      `${IPC_FAILED_EVENT}: channel=files:list error=Error code=SQLITE_BUSY syscall=open`,
    );
    expect(ipcFailureLine(`/${MARKER}`, pathError('EIO'))).toBe(
      `${IPC_FAILED_EVENT}: channel=? error=Error code=EIO syscall=open`,
    );
    expect(ipcFailureLine(undefined, 'text')).toBe(`${IPC_FAILED_EVENT}: error=non-error string`);
  });

  it('count the issues of a refused answer without quoting them', () => {
    expect(ipcContractLine('files:list', 2)).toBe(`${IPC_CONTRACT_EVENT}: channel=files:list issues=2`);
  });

  it('write a scheduler message with its safe cause, and counts as fields', () => {
    expect(schedulerLogLine('Job outcome could not be stored', pathError('SQLITE_FULL'))).toBe(
      'Job outcome could not be stored: error=Error code=SQLITE_FULL syscall=open',
    );
    expect(schedulerLogLine('Job handlers did not end before the stop deadline', { abandoned: 2 })).toBe(
      'Job handlers did not end before the stop deadline: abandoned=2',
    );
    expect(schedulerLogLine('Job pause gate failed', { path: `/${MARKER}` })).toBe(
      'Job pause gate failed: error=non-error object',
    );
    expect(schedulerLogLine('Job pause gate failed', {})).toBe('Job pause gate failed: error=non-error object');
    expect(schedulerLogLine('Job pause gate failed', undefined)).toBe(
      'Job pause gate failed: error=non-error undefined',
    );
  });

  it('write the job recovery only when it did something', () => {
    const zero = { released: 0, retried: 0, failed: 0, unroutedAssigned: 0, generationsEnded: 0 };
    expect(jobRecoveryLine(WORKSPACE, zero)).toBeNull();
    expect(jobRecoveryLine(WORKSPACE, { ...zero, failed: 1 })).toBe(
      `${JOB_RECOVERY_EVENT}: workspace=${WORKSPACE} released=0 retried=0 failed=1 unroutedAssigned=0 generationsEnded=0`,
    );
  });
});

describe('the workspace wiring', () => {
  it('hands the log to the workspace host, and none without one', () => {
    const log = (): void => {};
    expect(createWorkspaceHost({ userDataPath: '/user', migrationsFolder: '/m', log }).log).toBe(log);
    expect(createWorkspaceHost({ userDataPath: '/user', migrationsFolder: '/m' }).log).toBeUndefined();
  });
});

describe('the IPC boundary log', () => {
  it('writes one safe line for an unexpected error and none for a domain error', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toIpcError(pathError('EPERM'), 'files:list')).toEqual({
      code: 'internal_error',
      message: 'Unexpected error',
    });
    expect(toIpcError(new AssetForgeError('not_found', 'File not found'), 'files:list')).toEqual({
      code: 'not_found',
      message: 'File not found',
    });
    expect(log.mock.calls).toEqual([[`${IPC_FAILED_EVENT}: channel=files:list error=Error code=EPERM syscall=open`]]);
  });

  it('writes the channel and the issue count of an answer the contract refuses', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { 'dialog:pickDirectory': async () => ({ path: `/${MARKER}` }) } as unknown as IpcHandlers;
    await dispatch(broken, 'dialog:pickDirectory', {});
    const lines = log.mock.calls.map((call) => call.join(' '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^${IPC_CONTRACT_EVENT}: channel=dialog:pickDirectory issues=\\d+$`));
    expectNoMarker(lines);
  });
});

/** What the fake workspace of a job host test is made of. */
interface FakeWorkspace {
  /** The jobs of the workspace. */
  jobs: InMemoryJobRepository;
  /** Answers how many pending generations were closed. */
  reconcile: () => Promise<number>;
}

/**
 * A job host on a fake open workspace whose lines are collected.
 *
 * @param workspace the jobs and the generation reconcile
 * @returns the host and the lines
 */
function jobHost(workspace: FakeWorkspace) {
  const session = {
    summary: { id: WORKSPACE, name: 'Demo', rootPath: `/ws/${MARKER}`, lastOpenedAt: '2026-01-01T00:00:00.000Z' },
    database: { jobs: workspace.jobs, generations: { reconcile: workspace.reconcile } },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  } as unknown as WorkspaceSession;
  const manager = {
    current: () => session.summary,
    read: async (work: (current: WorkspaceSession) => Promise<unknown>) => work(session),
  } as unknown as WorkspaceManager;
  const lines: string[] = [];
  const host = createJobHost({
    feed: createChangeFeed(),
    manager,
    vision: () => null,
    images: { jpeg: async () => Buffer.alloc(0) },
    provider: () => null,
    pause: createPauseGate({}),
    firstEntry: () => null,
    ...noGenerations,
    remote: hangingRemote,
    // A retry timer never fires on its own.
    clock: { now: () => new Date('2026-01-01T00:00:00.000Z'), setTimer: () => ({}), clearTimer: () => {} },
    log: (line) => lines.push(line),
  });
  return { host, lines };
}

/**
 * Leaves one job of a type without a handler `running`, as an earlier session would.
 *
 * @param jobs the repository
 * @returns resolves once the row is running
 */
async function leaveRunning(jobs: InMemoryJobRepository): Promise<void> {
  const now = '2026-01-01T00:00:00.000Z';
  await jobs.enqueue({
    jobs: [
      {
        id: 'job-001',
        type: 'test.left',
        resourceClass: 'cpu',
        fileId: null,
        lane: null,
        payload: {},
        dedupeKey: null,
      },
    ],
    now,
  });
  await jobs.claimNext({ resourceClass: 'cpu', types: ['test.left'], now });
}

describe('the job recovery on open', () => {
  it('writes nothing when nothing was recovered', async () => {
    const { host, lines } = jobHost({ jobs: new InMemoryJobRepository(), reconcile: async () => 0 });
    await host.workspaceOpened();
    await host.workspaceClosing();
    expect(lines).toEqual([]);
  });

  it('writes one line with the released jobs and the closed generations', async () => {
    const jobs = new InMemoryJobRepository();
    await leaveRunning(jobs);
    const { host, lines } = jobHost({ jobs, reconcile: async () => 2 });
    await host.workspaceOpened();
    await host.workspaceClosing();
    expect(lines).toEqual([
      `${JOB_RECOVERY_EVENT}: workspace=${WORKSPACE} released=1 retried=0 failed=0 unroutedAssigned=0 generationsEnded=2`,
    ]);
  });

  it('writes the failures of the preparation and of the scheduler without a path', async () => {
    const jobs = new InMemoryJobRepository();
    const listByStatus = jobs.listByStatus.bind(jobs);
    jobs.listByStatus = (status) =>
      status === 'running' ? Promise.reject(pathError('SQLITE_IOERR')) : listByStatus(status);
    const { host, lines } = jobHost({ jobs, reconcile: () => Promise.reject(pathError('SQLITE_BUSY')) });
    await host.workspaceOpened();
    await host.workspaceClosing();
    expect(lines).toEqual([
      `Pending generations could not be reconciled: workspace=${WORKSPACE} error=Error code=SQLITE_BUSY syscall=open`,
      // The recovery of the start, then its first pass tries again.
      'Interrupted jobs could not be recovered: error=Error code=SQLITE_IOERR syscall=open',
      'Interrupted jobs could not be recovered: error=Error code=SQLITE_IOERR syscall=open',
    ]);
    expectNoMarker(lines);
  });
});
