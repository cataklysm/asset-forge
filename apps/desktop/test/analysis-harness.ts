import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { vi } from 'vitest';
import type {
  IpcChannel,
  IpcRequest,
  IpcResponse,
  IpcResult,
  JobSummary,
  ProviderOptions,
  ProviderView,
} from '@assetforge/contracts';
import type {
  GenerationImageSource,
  ImageProbe,
  ModelImageSource,
  RemoteFileSource,
  WorkspaceManager,
} from '@assetforge/core';
import { DEFAULT_LIMITS } from '@assetforge/jobs';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { startMockProvider, type MockFailure, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { createAnalysisServices, type AnalysisServices } from '../src/main/analysis-services.js';
import { createWorkspaceManager } from '../src/main/composition.js';
import { createGenerationImageSource } from '../src/main/generation-image-source.js';
import type { HostActions } from '../src/main/host-actions.js';
import { dispatch, type IpcHandlers } from '../src/main/ipc.js';
import { createWorkspaceHandlers } from '../src/main/workspace-handlers.js';
import type { SchedulerClock } from '../src/main/job-host.js';
import type { SiteSessions } from '../src/main/site-sessions.js';
import { FakeCodec } from './fake-codec.js';
import { pngOf, pngProbe } from './png-fixture.js';

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
    /** Absent keeps the stored options (the defaults for a new entry). */
    options?: ProviderOptions;
  }): Promise<ProviderView>;
  /** Saves a `venice` entry for a mock (its Venice endpoints live under `/api/v1`), like `provider`. */
  venice(o: { name?: string; url: string; apiKey?: string | null; timeoutSeconds?: number }): Promise<ProviderView>;
  /** Imports one real PNG of the given size, into the inbox or into an asset with a role; answers the file id. */
  importPng(o: {
    name: string;
    width: number;
    height: number;
    shade?: number;
    target?: { assetId: string; role: 'concept' | 'reference' };
  }): Promise<string>;
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
  o: {
    env?: NodeJS.ProcessEnv;
    codec?: FakeCodec;
    images?: ModelImageSource;
    imageProbe?: ImageProbe;
    generationImages?: GenerationImageSource;
    /** With it, every retry delay of the scheduler passes at once (the scheduler's clock jumps ahead). */
    fastRetries?: boolean;
    /** The scheduler's clock; wins over `fastRetries`. */
    clock?: SchedulerClock;
    /** The network side of the URL import; without it the app's own (public addresses only). */
    remote?: RemoteFileSource;
    /** Replaces single host actions; the defaults open nothing and start and stop the jobs. */
    host?: Partial<HostActions>;
    /** The site windows and sessions; without them none can open. */
    siteSessions?: SiteSessions;
    /** The pause between two crawl page loads. */
    siteWait?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
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

  const manager = createWorkspaceManager({
    userDataPath: userData,
    migrationsFolder: MIGRATIONS_FOLDER,
    imageProbe: o.imageProbe ?? pngProbe,
  });
  const services = createAnalysisServices({
    manager,
    userDataPath: userData,
    secrets: o.codec ?? new FakeCodec(),
    env: o.env ?? {},
    images: o.images ?? { jpeg: (path) => readFile(path) },
    // No preview service: every test image is a small PNG, which is sent as it is.
    generationImages: o.generationImages ?? createGenerationImageSource({ get: async () => null }),
    log: (line) => logs.push(line),
    limits: { ...DEFAULT_LIMITS, local_gpu: 1 },
    appVersion: 'test',
    ...(o.remote === undefined ? {} : { remote: o.remote }),
    ...(o.siteSessions === undefined ? {} : { siteSessions: o.siteSessions }),
    ...(o.siteWait === undefined ? {} : { siteWait: o.siteWait }),
    ...(o.clock !== undefined ? { clock: o.clock } : o.fastRetries === true ? { clock: jumpingClock() } : {}),
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
      ...o.host,
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
        ...(p.options === undefined ? {} : { options: p.options }),
      });
      saved.set(view.name, view.id);
      return view;
    },
    async venice(p) {
      const name = p.name ?? 'Venice';
      const id = saved.get(name);
      const view = await ok('providers:save', {
        ...(id === undefined ? {} : { id }),
        kind: 'venice',
        name,
        baseUrl: `${p.url}/api/v1`,
        timeoutSeconds: p.timeoutSeconds ?? 30,
        taggingModel: null,
        promptModel: null,
        ...(p.apiKey === undefined ? {} : { apiKey: p.apiKey }),
      });
      saved.set(view.name, view.id);
      return view;
    },
    async importPng(p) {
      const path = join(sources, p.name);
      await writeFile(path, pngOf(p.width, p.height, p.shade ?? 0));
      const [result] = await ok('files:import', {
        sourcePaths: [path],
        ...(p.target === undefined ? {} : { target: p.target }),
      });
      if (result?.file == null || result.error !== null) throw new Error('The PNG could not be imported');
      return result.file.id;
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

/** A scheduler clock that jumps ahead by every delay it is asked to wait, and fires at once. */
function jumpingClock(): SchedulerClock {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    setTimer(fn, ms) {
      offset += Math.max(ms, 0);
      return setTimeout(fn, 0);
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
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
