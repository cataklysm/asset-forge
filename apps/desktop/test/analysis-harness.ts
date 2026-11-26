import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { vi } from 'vitest';
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult, JobSummary } from '@assetforge/contracts';
import type { ModelImageSource, WorkspaceManager } from '@assetforge/core';
import { DEFAULT_LIMITS } from '@assetforge/jobs';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createAnalysisServices, createWorkspaceManager, type AnalysisServices } from '../src/main/composition.js';
import { createWorkspaceHandlers, dispatch, type IpcHandlers } from '../src/main/ipc.js';
import { FakeCodec } from './fake-codec.js';

/** The only key the tests use; it must never show up anywhere but in the request header. */
export const TEST_KEY = 'test-key-not-real';
export const NONE_SKIPPED = { notFound: 0, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 0 };

export interface Harness {
  base: string;
  userData: string;
  manager: WorkspaceManager;
  services: AnalysisServices;
  handlers: IpcHandlers;
  /** Every IPC result of the test, serialised. */
  responses: string[];
  /** Every captured main-console line and every provider failure line. */
  logs: string[];
  call(channel: IpcChannel, request: unknown): Promise<IpcResult<unknown>>;
  ok<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  importImages(count: number, prefix?: string): Promise<string[]>;
  until(check: (summary: JobSummary) => boolean, timeoutMs?: number): Promise<JobSummary>;
  close(): Promise<void>;
}

/**
 * The analysis services and the IPC handlers as the app wires them, with a fake credential store,
 * the given environment and the raw source bytes standing in for the model JPEG.
 */
export async function createHarness(
  o: { env?: NodeJS.ProcessEnv; codec?: FakeCodec; images?: ModelImageSource } = {},
): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), 'af-analysis-'));
  const userData = join(base, 'userData');
  const sources = join(base, 'sources');
  await mkdir(sources, { recursive: true });
  const logs: string[] = [];
  const capture = (...args: unknown[]) => {
    logs.push(format(...args));
  };
  const spies = (['error', 'warn', 'log', 'info'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(capture),
  );

  const manager = createWorkspaceManager({ userDataPath: userData, migrationsFolder: MIGRATIONS_FOLDER });
  const services = createAnalysisServices({
    manager,
    userDataPath: userData,
    secrets: o.codec ?? new FakeCodec(),
    env: o.env ?? {},
    images: o.images ?? { jpeg: (path) => readFile(path) },
    log: (line) => logs.push(line),
    limits: { ...DEFAULT_LIMITS, local_gpu: 1 },
  });
  const handlers = createWorkspaceHandlers(
    manager,
    {
      pickDirectory: async () => null,
      pickFiles: async () => [],
      confirmRemoveWorkspace: async () => 'cancel',
      confirmRemoveWorkflow: async () => false,
    },
    {
      openPath: async () => '',
      showItemInFolder: () => {},
      workspaceOpened: () => services.workspaceOpened(),
      workspaceClosing: () => services.workspaceClosing(),
    },
    services.jobHost,
    services,
  );
  const responses: string[] = [];

  const call = async (channel: IpcChannel, request: unknown): Promise<IpcResult<unknown>> => {
    const result = await dispatch(handlers, channel, request);
    responses.push(JSON.stringify(result));
    return result;
  };
  const ok = async <C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> => {
    const result = await call(channel, request);
    if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
    return result.value as IpcResponse<C>;
  };

  let imported = 0;
  return {
    base,
    userData,
    manager,
    services,
    handlers,
    responses,
    logs,
    call,
    ok,
    async importImages(count, prefix = 'image') {
      const paths: string[] = [];
      for (let i = 0; i < count; i++) {
        const path = join(sources, `${prefix}-${imported}.png`);
        await writeFile(path, `image content ${prefix} ${imported}`);
        imported++;
        paths.push(path);
      }
      const results = await ok('files:import', { sourcePaths: paths });
      return results.map((r) => r.file!.id);
    },
    async until(check, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const summary = await ok('jobs:summary', {});
        if (check(summary)) return summary;
        if (Date.now() > deadline) throw new Error(`Timed out; last summary ${JSON.stringify(summary)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async close() {
      try {
        await services.workspaceClosing();
        await manager.close();
        await rm(base, { recursive: true, force: true });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    },
  };
}

/** Every file below `dir`, as latin1 text, so a plaintext search covers databases and their journals too. */
export async function filesBelow(dir: string): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out.push({ path, text: (await readFile(path)).toString('latin1') });
  }
  return out;
}
