import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { vi } from 'vitest';
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult, JobSummary, ProviderView } from '@assetforge/contracts';
import type { ModelImageSource, WorkspaceManager } from '@assetforge/core';
import { DEFAULT_LIMITS } from '@assetforge/jobs';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { startMockProvider, type MockFailure, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { createAnalysisServices, createWorkspaceManager, type AnalysisServices } from '../src/main/composition.js';
import { createWorkspaceHandlers, dispatch, type IpcHandlers } from '../src/main/ipc.js';
import { FakeCodec } from './fake-codec.js';

/** The keys the tests use; they must never show up anywhere but in the request header. */
export const TEST_KEY = 'test-key-not-real';
export const TEST_KEY_2 = 'test-key-not-real-2';
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
  /**
   * Saves a provider entry through `providers:save`: created the first time a name is used, replaced
   * (same id) afterwards. `apiKey` absent keeps the stored key, null deletes it. No default models unless given.
   */
  provider(o: {
    name?: string;
    url: string;
    apiKey?: string | null;
    taggingModel?: string | null;
    promptModel?: string | null;
    timeoutSeconds?: number;
  }): Promise<ProviderView>;
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
      openExternal: async () => {},
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

  /** The ids of the entries saved by `provider`, by name. */
  const saved = new Map<string, string>();

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
    async provider(p) {
      const name = p.name ?? 'Mock';
      const id = saved.get(name);
      const view = await ok('providers:save', {
        ...(id === undefined ? {} : { id }),
        name,
        baseUrl: p.url,
        timeoutSeconds: p.timeoutSeconds ?? 30,
        taggingModel: p.taggingModel ?? null,
        promptModel: p.promptModel ?? null,
        ...(p.apiKey === undefined ? {} : { apiKey: p.apiKey }),
      });
      saved.set(view.name, view.id);
      return view;
    },
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

/**
 * Two in-process mocks, each requiring its own key: A takes `TEST_KEY`, B takes `TEST_KEY_2`. A request
 * with the other key, or with none, gets 401.
 */
export async function startTwoMocks(
  o: { delayMs?: number; failuresA?: MockFailure[]; failuresB?: MockFailure[] } = {},
): Promise<{ a: MockProvider; b: MockProvider; close(): Promise<void> }> {
  const delay = o.delayMs === undefined ? {} : { delayMs: o.delayMs };
  const a = await startMockProvider({ port: 0, apiKey: TEST_KEY, failures: o.failuresA ?? [], ...delay });
  const b = await startMockProvider({ port: 0, apiKey: TEST_KEY_2, failures: o.failuresB ?? [], ...delay });
  return {
    a,
    b,
    async close() {
      await Promise.allSettled([a.close(), b.close()]);
    },
  };
}
