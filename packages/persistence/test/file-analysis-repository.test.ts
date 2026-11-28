import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BUILT_IN_ASSET_TYPES, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE_ID = uuid(1);
const TYPE_ID = uuid(2);
const ASSET_ID = uuid(3);
const FILE_ID = uuid(4);
const SHA = 'a'.repeat(64);

let dir: string;
let db: WorkspaceDatabase;
let handle: Database.Database;
let nextTagId = 5000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-analysis-'));
  const pragma = vi.spyOn(Database.prototype, 'pragma');
  try {
    db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
    handle = pragma.mock.contexts[0] as Database.Database;
  } finally {
    pragma.mockRestore();
  }
  await db.storages.ensurePrimary({ id: STORAGE_ID, createdAt: T0 });
  await db.assetTypes.insertMissing([
    {
      id: TYPE_ID,
      key: BUILT_IN_ASSET_TYPES[0]!.key,
      name: 'T',
      sortOrder: 0,
      builtIn: true,
      defaultWorkflowTemplateId: null,
    },
  ]);
  await db.assets.insert({
    id: ASSET_ID,
    name: 'Pump',
    typeId: TYPE_ID,
    description: '',
    status: 'draft',
    createdAt: T0,
    updatedAt: T0,
  });
  await addFile(FILE_ID);
  await db.files.setPlacement(FILE_ID, {
    relativePath: `assets/${ASSET_ID}/f.png`,
    assetId: ASSET_ID,
    role: 'reference',
  });
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function addFile(id: string, complete = true): Promise<void> {
  await db.files.insertPending({
    id,
    storageId: STORAGE_ID,
    originalName: 'f.png',
    relativePath: `inbox/${id}/f.png`,
    mimeType: 'image/png',
    importedAt: T0,
    kind: 'image',
  });
  if (complete) await db.files.markComplete(id, { sizeBytes: 1, sha256: SHA, width: null, height: null });
}

const t = (name: string, displayName = name) => ({ name, displayName, newId: uuid(nextTagId++) });

const apply = (
  o: {
    fileId?: string;
    sha256?: string;
    tags?: ReturnType<typeof t>[];
    model?: string;
    promptName?: string | null;
    now?: string;
  } = {},
) =>
  db.analyses.apply({
    fileId: o.fileId ?? FILE_ID,
    sha256: o.sha256 ?? SHA,
    tags: o.tags ?? [t('rusty'), t('metal')],
    provider: 'ollama',
    model: o.model ?? 'qwen',
    promptVersion: 1,
    promptName: o.promptName === undefined ? null : o.promptName,
    now: o.now ?? T1,
  });

const tagsOf = async (fileId = FILE_ID) => (await db.files.get(fileId))!.tags.map((a) => `${a.name}/${a.origin}`);
const rowCount = (table: string) => (handle.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

describe('file analysis repository', () => {
  test('apply writes the ai tags and the analysis row', async () => {
    expect(await db.analyses.get(FILE_ID)).toBeNull();
    expect(await apply({ tags: [t('rusty', 'Rusty'), t('metal')] })).toBe(true);
    expect(await db.files.get(FILE_ID)).toMatchObject({
      tags: [
        { name: 'metal', displayName: 'metal', origin: 'ai' },
        { name: 'rusty', displayName: 'Rusty', origin: 'ai' },
      ],
    });
    expect(await db.analyses.get(FILE_ID)).toEqual({
      fileId: FILE_ID,
      sha256: SHA,
      provider: 'ollama',
      model: 'qwen',
      promptVersion: 1,
      promptName: null,
      analysedAt: T1,
    });
  });

  test('apply writes nothing for an unknown file, a pending file or a different sha256', async () => {
    const pending = uuid(40);
    await addFile(pending, false);
    expect(await apply({ fileId: uuid(99) })).toBe(false);
    expect(await apply({ fileId: pending })).toBe(false);
    expect(await apply({ sha256: 'b'.repeat(64) })).toBe(false);
    expect(rowCount('file_tag')).toBe(0);
    expect(rowCount('tag')).toBe(0);
    expect(rowCount('file_analysis')).toBe(0);
  });

  test('apply on an inbox file writes its tags and analysis row without an asset to reindex', async () => {
    const inbox = uuid(41);
    await addFile(inbox);
    expect(await apply({ fileId: inbox, tags: [t('rusty')] })).toBe(true);
    expect(await tagsOf(inbox)).toEqual(['rusty/ai']);
    expect(await db.analyses.get(inbox)).toMatchObject({ fileId: inbox, sha256: SHA, analysedAt: T1 });
    expect(await tagsOf()).toEqual([]);
  });

  test('a second apply replaces the earlier ai assignments and the analysis row', async () => {
    await apply({ tags: [t('rusty'), t('metal')] });
    expect(await apply({ tags: [t('metal'), t('blue')], model: 'llava', now: T2 })).toBe(true);
    expect(await tagsOf()).toEqual(['blue/ai', 'metal/ai']);
    expect(await db.analyses.get(FILE_ID)).toMatchObject({ model: 'llava', analysedAt: T2 });
    expect(rowCount('file_analysis')).toBe(1);
  });

  test('manual assignments stay, and a tag carried manually gets no ai assignment', async () => {
    await db.tags.addToFile({
      fileId: FILE_ID,
      name: 'rusty',
      displayName: 'rusty',
      origin: 'manual',
      newId: uuid(4000),
      now: T0,
    });
    await db.tags.addToFile({
      fileId: FILE_ID,
      name: 'kept',
      displayName: 'kept',
      origin: 'manual',
      newId: uuid(4001),
      now: T0,
    });
    expect(await apply({ tags: [t('rusty'), t('metal')] })).toBe(true);
    expect(await tagsOf()).toEqual(['kept/manual', 'metal/ai', 'rusty/manual']);
  });

  test('a successful apply changes no workflow step and not the asset status', async () => {
    const versionId = uuid(60);
    const stepIds = [uuid(61), uuid(62)];
    await db.workflowTemplates.insertTemplate({
      id: uuid(50),
      key: 'character',
      name: 'Character',
      builtIn: true,
      createdAt: T0,
    });
    await db.workflowTemplates.insertVersion({
      id: versionId,
      templateId: uuid(50),
      version: 1,
      steps: [
        { id: stepIds[0]!, position: 0, key: 'concept', name: 'Concept', mandatory: true },
        { id: stepIds[1]!, position: 1, key: 'texturing', name: 'Texturing', mandatory: true },
      ],
      createdAt: T0,
    });
    await db.assetWorkflows.insert(
      { id: uuid(70), assetId: ASSET_ID, templateVersionId: versionId, createdAt: T0 },
      stepIds.map((stepDefinitionId, i) => ({ id: uuid(71 + i), stepDefinitionId, updatedAt: T0 })),
    );
    const snapshot = () => ({
      asset: handle.prepare('select status, updated_at from asset where id = ?').get(ASSET_ID),
      steps: handle.prepare('select * from asset_workflow_step order by id').all(),
    });
    const before = snapshot();
    expect(before.steps).toHaveLength(2);

    expect(await apply({ now: T2 })).toBe(true);
    expect(snapshot()).toEqual(before);
    expect((await db.assets.get(ASSET_ID))?.status).toBe('draft');
  });

  test('duplicate tag names in one answer give one assignment', async () => {
    expect(await apply({ tags: [t('metal'), t('metal')] })).toBe(true);
    expect(await tagsOf()).toEqual(['metal/ai']);
  });

  test('the asset search and the tag filters find an ai tag afterwards', async () => {
    await apply({ tags: [t('corroded')] });
    expect((await db.assets.list({ limit: 10, offset: 0, query: 'corro' })).items.map((a) => a.id)).toEqual([ASSET_ID]);
    expect((await db.assets.list({ limit: 10, offset: 0, tagNames: ['corroded'] })).items.map((a) => a.id)).toEqual([
      ASSET_ID,
    ]);
    expect(
      (await db.files.list({ limit: 10, offset: 0, scope: { kind: 'all' }, tagNames: ['corroded'] })).items.map(
        (f) => f.id,
      ),
    ).toEqual([FILE_ID]);

    await apply({ tags: [t('shiny')], now: T2 });
    expect((await db.assets.list({ limit: 10, offset: 0, query: 'corro' })).total).toBe(0);
  });
});

describe('analysis of a trashed file', () => {
  const LIVE_ID = uuid(5);

  /** Sends FILE_ID to the trash through a committed `trash` move; LIVE_ID stays in the inbox. */
  async function setup(): Promise<void> {
    await addFile(LIVE_ID);
    await db.fileMoves.begin({
      fileId: FILE_ID,
      kind: 'trash',
      targetRelativePath: `.assetforge/trash/${FILE_ID}_f.png`,
      targetAssetId: null,
      targetRole: null,
      createdAt: T1,
    });
    await db.fileMoves.commit(FILE_ID);
  }
  const fileRows = (table: string, fileId: string) =>
    (handle.prepare(`select count(*) as n from ${table} where file_id = ?`).get(fileId) as { n: number }).n;

  test('apply writes nothing to a trashed file', async () => {
    await setup();
    expect(await apply()).toBe(false);
    expect(fileRows('file_tag', FILE_ID)).toBe(0);
    expect(fileRows('file_analysis', FILE_ID)).toBe(0);
    expect(await apply({ fileId: LIVE_ID })).toBe(true);
    expect(fileRows('file_tag', LIVE_ID)).toBe(2);
  });

  test('propose writes nothing to a trashed file', async () => {
    await setup();
    const proposal = (fileId: string) => ({
      fileId,
      sha256: SHA,
      provider: 'ollama',
      model: 'qwen',
      promptVersion: 1,
      tags: [{ name: 'rusty', displayName: 'rusty' }],
      promptName: null,
      createdAt: T2,
    });
    expect(await db.analyses.propose(proposal(FILE_ID))).toBe(false);
    expect(fileRows('file_analysis_proposal', FILE_ID)).toBe(0);
    expect(await db.analyses.propose(proposal(LIVE_ID))).toBe(true);
    expect(fileRows('file_analysis_proposal', LIVE_ID)).toBe(1);
  });
});

describe('the recorded analysis prompt name', () => {
  const proposal = (promptName: string | null) => ({
    fileId: FILE_ID,
    sha256: SHA,
    provider: 'ollama',
    model: 'qwen',
    promptVersion: 1,
    tags: [{ name: 'rusty', displayName: 'rusty' }],
    promptName,
    createdAt: T1,
  });

  test('apply stores the prompt name and get returns it', async () => {
    expect(await apply({ promptName: 'General' })).toBe(true);
    expect(await db.analyses.get(FILE_ID)).toMatchObject({ promptName: 'General' });
  });

  test('an apply without a prompt name after a named one stores null', async () => {
    await apply({ promptName: 'General' });
    expect(await apply({ promptName: null, now: T2 })).toBe(true);
    expect(await db.analyses.get(FILE_ID)).toMatchObject({ promptName: null, analysedAt: T2 });
  });

  test('propose stores the prompt name and getProposal returns it', async () => {
    expect(await db.analyses.propose(proposal('Detail'))).toBe(true);
    expect(await db.analyses.getProposal(FILE_ID)).toMatchObject({ promptName: 'Detail', stale: false });
  });

  test('accepting a proposal writes its prompt name to the analysis row', async () => {
    await apply({ promptName: 'General' });
    await db.analyses.propose(proposal('Detail'));
    expect(
      await db.analyses.acceptProposal({ fileId: FILE_ID, sha256: SHA, createdAt: T1, tags: [t('rusty')], now: T2 }),
    ).toBe('accepted');
    expect(await db.analyses.get(FILE_ID)).toMatchObject({ promptName: 'Detail', analysedAt: T2 });
  });
});
