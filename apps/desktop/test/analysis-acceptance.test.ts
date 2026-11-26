import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcChannel, IpcRequest, IpcResponse, JobSummary } from '@assetforge/contracts';
import type { WorkspaceManager } from '@assetforge/core';
import { DEFAULT_LIMITS } from '@assetforge/jobs';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createOllamaVision, OLLAMA_PROVIDER } from '@assetforge/providers';
import { MOCK_MODEL, startMockProvider, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { createWorkspaceManager } from '../src/main/composition.js';
import { createWorkspaceHandlers, dispatch } from '../src/main/ipc.js';
import { createJobHost } from '../src/main/job-host.js';

let base: string;
let manager: WorkspaceManager;
let mock: MockProvider;
/** The phase 4a request shape in the phase 4b contract: an explicit file list, applied. */
const filesRequest = (fileIds: string[]) => ({ target: { kind: 'files' as const, fileIds }, model: MOCK_MODEL, mode: 'apply' as const, force: true });
const NONE_SKIPPED = { notFound: 0, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 0 };

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-analysis-accept-'));
  manager = createWorkspaceManager({ userDataPath: join(base, 'userData'), migrationsFolder: MIGRATIONS_FOLDER });
  mock = await startMockProvider({ port: 0, delayMs: 150 });
});
afterEach(async () => {
  await manager.close();
  await mock.close();
  await rm(base, { recursive: true, force: true });
});

/** The tags the mock answers for these image bytes. */
async function mockTagsOf(bytes: Uint8Array): Promise<string[]> {
  const response = await fetch(`${mock.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MOCK_MODEL,
      stream: false,
      format: { type: 'object' },
      messages: [{ role: 'user', content: 'tag', images: [Buffer.from(bytes).toString('base64')] }],
    }),
  });
  const json = (await response.json()) as { message: { content: string } };
  return (JSON.parse(json.message.content) as { tags: string[] }).tags;
}

const active = (s: JobSummary) => s.queued + s.running + s.waiting;

describe('phase 4a acceptance', () => {
  it('analyses a batch through cancel, retry and a close mid-batch without touching manual tags', async () => {
    const adapter = createOllamaVision({ baseUrl: mock.url });
    const jobHost = createJobHost({
      manager,
      vision: () => adapter,
      images: { jpeg: (path) => readFile(path) },
      provider: OLLAMA_PROVIDER,
      defaultModel: () => MOCK_MODEL,
      limits: { ...DEFAULT_LIMITS, local_gpu: 1 },
    });
    // While held, opening a workspace does not start its scheduler.
    let holdScheduler = false;
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
        workspaceOpened: () => (holdScheduler ? Promise.resolve() : jobHost.workspaceOpened()),
        workspaceClosing: () => jobHost.workspaceClosing(),
      },
      jobHost,
    );
    const call = async <C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> => {
      const result = await dispatch(handlers, channel, request);
      if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
      return result.value as IpcResponse<C>;
    };
    const until = async (check: (s: JobSummary) => boolean): Promise<JobSummary> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const summary = await call('jobs:summary', {});
        if (check(summary)) return summary;
        if (Date.now() > deadline) throw new Error(`Timed out; last summary ${JSON.stringify(summary)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    try {
      // Six small PNGs with different content.
      const workspaceRoot = join(base, 'workspace');
      const sources = join(base, 'sources');
      await mkdir(sources, { recursive: true });
      const paths: string[] = [];
      for (let i = 0; i < 6; i++) {
        const path = join(sources, `image-${i}.png`);
        const background = { r: i * 40, g: 255 - i * 40, b: (i * 90) % 256 };
        await writeFile(path, await sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer());
        paths.push(path);
      }
      await call('workspace:create', { name: 'Analysis', rootPath: workspaceRoot });
      const imported = await call('files:import', { sourcePaths: paths });
      const fileIds = imported.map((r) => r.file!.id);

      // Two manual tags: one the mock will also return for that image, one it will not.
      const overlapping = (await mockTagsOf(await readFile(paths[0]!)))[0]!;
      await call('files:addTag', { fileId: fileIds[0]!, name: overlapping });
      await call('files:addTag', { fileId: fileIds[1]!, name: 'hand picked' });
      const manual = new Map([
        [fileIds[0]!, overlapping],
        [fileIds[1]!, 'hand picked'],
      ]);

      expect(await call('analysis:enqueue', filesRequest(fileIds))).toEqual({ enqueued: 6, skipped: NONE_SKIPPED });

      // Cancel all while the batch runs.
      await until((s) => s.succeeded >= 1);
      await call('jobs:cancelAll', {});
      const afterCancel = await until((s) => active(s) === 0);
      expect(afterCancel.cancelled).toBeGreaterThanOrEqual(1);

      // Retry the cancelled ones and close the workspace while the next one runs.
      expect(await call('jobs:retryFailed', {})).toEqual({ retried: afterCancel.cancelled });
      await until((s) => s.running === 1);
      const [interrupted] = (await call('jobs:list', { limit: 10, offset: 0, status: 'running' })).items;
      expect(interrupted).toBeDefined();
      await call('workspace:close', {});

      // Reopen without starting the scheduler: the interrupted job is back in the queue, its run not counted.
      holdScheduler = true;
      await call('workspace:open', { rootPath: workspaceRoot });
      expect((await call('jobs:summary', {})).running).toBe(0);
      const jobs = (await call('jobs:list', { limit: 10, offset: 0 })).items;
      expect(jobs.find((j) => j.id === interrupted!.id)).toMatchObject({ status: 'queued', attempt: 0 });

      holdScheduler = false;
      await jobHost.workspaceOpened();
      await until((s) => s.succeeded === 6 && active(s) === 0);

      // Every file has the mock's eight tags as AI tags, minus the one it carries manually.
      const files = (await call('files:list', { limit: 10, offset: 0, scope: { kind: 'all' } })).items;
      expect(files).toHaveLength(6);
      for (const file of files) {
        const expected = (await mockTagsOf(await readFile(paths[fileIds.indexOf(file.id)]!))).filter(
          (name) => name !== manual.get(file.id),
        );
        const ai = file.tags.filter((t) => t.origin === 'ai').map((t) => t.name);
        expect(ai.sort()).toEqual(expected.sort());
        const own = manual.get(file.id);
        const manualTags = file.tags.filter((t) => t.origin === 'manual').map((t) => t.name);
        expect(manualTags).toEqual(own === undefined ? [] : [own]);
        if (own !== undefined) expect(file.tags.filter((t) => t.name === own)).toHaveLength(1);
      }
      expect(files.find((f) => f.id === fileIds[0])!.tags.filter((t) => t.origin === 'ai')).toHaveLength(7);

      for (const fileId of fileIds) {
        expect(await manager.read((s) => s.database.analyses.get(fileId))).toMatchObject({ model: 'mock-vision' });
      }
      expect(mock.requests.some((r) => r.headers['authorization'] !== undefined)).toBe(false);
    } finally {
      await jobHost.workspaceClosing();
    }
  });
});
