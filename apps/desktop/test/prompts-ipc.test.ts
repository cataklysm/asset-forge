import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ipcContract, type IpcChannel, type PromptDetail } from '@assetforge/contracts';
import type { WorkspaceManager } from '@assetforge/core';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceManager } from '../src/main/composition.js';
import { createWorkspaceHandlers, dispatch, type IpcHandlers } from '../src/main/ipc.js';
import { idleJobHost, idleServices, noopHost } from './idle-job-host.js';

let base: string;
let manager: WorkspaceManager;
let handlers: IpcHandlers;

const uuid = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-prompts-ipc-'));
  manager = createWorkspaceManager({ userDataPath: join(base, 'userData'), migrationsFolder: MIGRATIONS_FOLDER });
  handlers = createWorkspaceHandlers(manager, {
    pickDirectory: async () => null,
    pickFiles: async () => [],
    confirmRemoveWorkspace: async () => 'cancel',
    confirmRemoveWorkflow: async () => false,
  }, noopHost, idleJobHost, idleServices);
});
afterEach(async () => {
  await manager.close();
  await rm(base, { recursive: true, force: true });
});

const call = (channel: IpcChannel, request: unknown) => dispatch(handlers, channel, request);

async function ok<T = any>(channel: IpcChannel, request: unknown): Promise<T> {
  const result = await call(channel, request);
  if (!result.ok) throw new Error(`${channel} failed: ${result.error.code} ${result.error.message}`);
  return result.value as T;
}

const openWorkspace = () => ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });

const page = { offset: 0, limit: 10 };
const create = (title: string, content = 'A {{subject}} at dusk') =>
  ok<PromptDetail>('prompts:create', { title, description: '', content, defaults: { subject: 'fox' } });

describe('prompts IPC', () => {
  it('answers no_workspace_open for every prompts channel when nothing is open', async () => {
    const requests: Partial<Record<IpcChannel, unknown>> = {
      'prompts:list': page,
      'prompts:get': { promptId: uuid },
      'prompts:create': { title: 'T', description: '', content: 'C', defaults: {} },
      'prompts:update': { promptId: uuid, title: 'T', description: '' },
      'prompts:saveVersion': { promptId: uuid, baseVersionId: uuid, content: 'C', defaults: {} },
      'prompts:delete': { promptId: uuid },
      'prompts:addTag': { promptId: uuid, name: 'night' },
      'prompts:removeTag': { promptId: uuid, name: 'night' },
    };
    expect(Object.keys(requests)).toEqual(Object.keys(ipcContract).filter((c) => c.startsWith('prompts:')));
    for (const [channel, request] of Object.entries(requests)) {
      expect(ipcContract[channel as IpcChannel].request.safeParse(request).success, channel).toBe(true);
      expect(await call(channel as IpcChannel, request), channel).toMatchObject({
        ok: false,
        error: { code: 'no_workspace_open' },
      });
    }
  });

  it('creates, lists, saves a version, reads and deletes a prompt', async () => {
    await openWorkspace();
    const hero = await create(' Hero shot ');
    expect(hero).toMatchObject({ title: 'Hero shot', currentVersion: { number: 1, variables: [{ name: 'subject', defaultValue: 'fox' }] } });
    await create('Plain', 'An empty field');
    await ok('prompts:addTag', { promptId: hero.id, name: 'Night' });

    const listed = await ok('prompts:list', { ...page, query: 'DUSK' });
    expect(listed).toMatchObject({ total: 1, items: [{ id: hero.id }] });
    expect((await ok('prompts:list', { ...page, tagNames: ['night'] })).items.map((p: PromptDetail) => p.id)).toEqual([hero.id]);
    expect((await ok('prompts:list', page)).total).toBe(2);

    const saved = await ok<PromptDetail>('prompts:saveVersion', {
      promptId: hero.id,
      baseVersionId: hero.currentVersion.id,
      content: 'A {{subject}} at dawn',
      defaults: {},
    });
    expect(saved.currentVersion.number).toBe(2);
    expect(await call('prompts:saveVersion', {
      promptId: hero.id,
      baseVersionId: hero.currentVersion.id,
      content: 'Again',
      defaults: {},
    })).toEqual({ ok: false, error: { code: 'invalid_operation', message: 'This prompt was changed in the meantime' } });

    const read = await ok<PromptDetail>('prompts:get', { promptId: hero.id });
    expect(read.versions.map((v) => [v.number, v.content])).toEqual([
      [2, 'A {{subject}} at dawn'],
      [1, 'A {{subject}} at dusk'],
    ]);
    expect(read.tags).toEqual([{ name: 'night', displayName: 'Night', origin: 'manual' }]);

    expect(await ok('prompts:delete', { promptId: hero.id })).toEqual({});
    expect(await call('prompts:get', { promptId: hero.id })).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'This prompt does not exist' },
    });
  });

  it('answers the fixed validation messages', async () => {
    await openWorkspace();
    await create('Hero');
    expect(await call('prompts:create', { title: 'HERO', description: '', content: 'x', defaults: {} })).toEqual({
      ok: false,
      error: { code: 'validation_failed', message: 'This title is already used' },
    });
  });

  it('answers invalid_request for a malformed request', async () => {
    await openWorkspace();
    const invalid = { ok: false, error: { code: 'invalid_request' } };
    expect(await call('prompts:list', { offset: 0, limit: 0 })).toMatchObject(invalid);
    expect(await call('prompts:get', { promptId: 'not-a-uuid' })).toMatchObject(invalid);
    expect(await call('prompts:addTag', { promptId: uuid, name: 'x'.repeat(201) })).toMatchObject(invalid);
  });

  it('counts, suggests and merges prompt tags through the tag channels', async () => {
    await openWorkspace();
    const hero = await create('Hero');
    await ok('prompts:addTag', { promptId: hero.id, name: 'Front view' });
    await ok('prompts:addTag', { promptId: hero.id, name: 'Frontal' });

    expect(await ok('tags:usage', { name: 'front view' })).toMatchObject({ exists: true, prompts: 1, assets: 0, files: 0 });
    expect(await ok('tags:suggest', { prefix: 'fro', limit: 10 })).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'front view' })]),
    );

    expect(await ok('tags:rename', { from: 'front view', to: 'Frontal', merge: true })).toMatchObject({
      name: 'frontal',
      merged: true,
    });
    expect((await ok<PromptDetail>('prompts:get', { promptId: hero.id })).tags).toEqual([
      { name: 'frontal', displayName: 'Frontal', origin: 'manual' },
    ]);
  });
});
