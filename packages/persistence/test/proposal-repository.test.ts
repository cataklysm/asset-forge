import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BUILT_IN_ASSET_TYPES, type Proposal, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';
const T3 = '2026-01-01T00:00:03.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE_ID = uuid(1);
const TYPE_ID = uuid(2);
const ASSET_ID = uuid(3);
const FILE_ID = uuid(4);
const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

let dir: string;
let dbPath: string;
let db: WorkspaceDatabase;
let handle: Database.Database;
let nextTagId = 5000;

async function open(): Promise<void> {
  const pragma = vi.spyOn(Database.prototype, 'pragma');
  try {
    db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    handle = pragma.mock.contexts[0] as Database.Database;
  } finally {
    pragma.mockRestore();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-proposal-'));
  dbPath = join(dir, 'ws.db');
  await open();
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
const tagsOf = async (fileId = FILE_ID) => (await db.files.get(fileId))!.tags.map((a) => `${a.name}/${a.origin}`);
const rowCount = (table: string) => (handle.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
const changeHash = (sha256: string, fileId = FILE_ID) =>
  handle.prepare('update file set sha256 = ? where id = ?').run(sha256, fileId);

const proposal = (o: Partial<Proposal> = {}): Proposal => ({
  fileId: FILE_ID,
  sha256: SHA,
  provider: 'ollama',
  model: 'qwen',
  promptVersion: 1,
  tags: [
    { name: 'rusty', displayName: 'Rusty' },
    { name: 'metal', displayName: 'metal' },
  ],
  promptName: null,
  createdAt: T1,
  ...o,
});

const accept = (tags: ReturnType<typeof t>[], o: { sha256?: string; now?: string; fileId?: string } = {}) =>
  db.analyses.acceptProposal({ fileId: o.fileId ?? FILE_ID, sha256: o.sha256 ?? SHA, tags, now: o.now ?? T2 });

describe('tag proposals', () => {
  test('propose stores the proposal and leaves tags and the analysis row alone', async () => {
    expect(await db.analyses.getProposal(FILE_ID)).toBeNull();
    expect(await db.analyses.propose(proposal())).toBe(true);
    expect(await db.analyses.getProposal(FILE_ID)).toEqual({ ...proposal(), stale: false });
    expect(rowCount('file_tag')).toBe(0);
    expect(rowCount('tag')).toBe(0);
    expect(await db.analyses.get(FILE_ID)).toBeNull();
  });

  test('a new proposal replaces the older one', async () => {
    await db.analyses.propose(proposal());
    expect(
      await db.analyses.propose(
        proposal({ model: 'llava', tags: [{ name: 'blue', displayName: 'Blue' }], createdAt: T2 }),
      ),
    ).toBe(true);
    expect(await db.analyses.getProposal(FILE_ID)).toMatchObject({
      model: 'llava',
      tags: [{ name: 'blue', displayName: 'Blue' }],
      createdAt: T2,
    });
    expect(rowCount('file_analysis_proposal')).toBe(1);
  });

  test('propose writes nothing for an unknown, a pending or a changed file', async () => {
    const pending = uuid(40);
    await addFile(pending, false);
    expect(await db.analyses.propose(proposal({ fileId: uuid(99) }))).toBe(false);
    expect(await db.analyses.propose(proposal({ fileId: pending }))).toBe(false);
    expect(await db.analyses.propose(proposal({ sha256: OTHER_SHA }))).toBe(false);
    expect(rowCount('file_analysis_proposal')).toBe(0);
  });

  test('a proposal is stale once the file content changed', async () => {
    await db.analyses.propose(proposal());
    changeHash(OTHER_SHA);
    expect(await db.analyses.getProposal(FILE_ID)).toMatchObject({ stale: true, sha256: SHA });
  });

  test('a proposal survives reopening the workspace', async () => {
    await db.analyses.propose(proposal());
    await db.close();
    await open();
    expect(await db.analyses.getProposal(FILE_ID)).toEqual({ ...proposal(), stale: false });
  });

  test('accept applies exactly the given tags, writes the analysis row and deletes the proposal', async () => {
    await db.tags.addToFile({
      fileId: FILE_ID,
      name: 'old',
      displayName: 'old',
      origin: 'ai',
      newId: uuid(4000),
      now: T0,
    });
    await db.tags.addToFile({
      fileId: FILE_ID,
      name: 'rusty',
      displayName: 'rusty',
      origin: 'manual',
      newId: uuid(4001),
      now: T0,
    });
    await db.analyses.propose(
      proposal({
        tags: [
          { name: 'rusty', displayName: 'Rusty' },
          { name: 'metal', displayName: 'metal' },
          { name: 'blue', displayName: 'blue' },
        ],
      }),
    );

    expect(await accept([t('rusty', 'Rusty'), t('metal')], { now: T3 })).toBe(true);
    expect(await tagsOf()).toEqual(['metal/ai', 'rusty/manual']);
    expect(await db.analyses.get(FILE_ID)).toEqual({
      fileId: FILE_ID,
      sha256: SHA,
      provider: 'ollama',
      model: 'qwen',
      promptVersion: 1,
      promptName: null,
      analysedAt: T3,
    });
    expect(await db.analyses.getProposal(FILE_ID)).toBeNull();
    expect((await db.assets.list({ limit: 10, offset: 0, query: 'meta' })).items.map((a) => a.id)).toEqual([ASSET_ID]);
  });

  test('accept changes no workflow step and not the asset status', async () => {
    const versionId = uuid(60);
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
      steps: [{ id: uuid(61), position: 0, key: 'concept', name: 'Concept', mandatory: true }],
      createdAt: T0,
    });
    await db.assetWorkflows.insert({ id: uuid(70), assetId: ASSET_ID, templateVersionId: versionId, createdAt: T0 }, [
      { id: uuid(71), stepDefinitionId: uuid(61), updatedAt: T0 },
    ]);
    const snapshot = () => ({
      asset: handle.prepare('select status, updated_at from asset where id = ?').get(ASSET_ID),
      steps: handle.prepare('select * from asset_workflow_step order by id').all(),
    });
    const before = snapshot();
    await db.analyses.propose(proposal());
    expect(await accept([t('metal')])).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  test('accept of a stale proposal deletes it and changes nothing else', async () => {
    await db.analyses.propose(proposal());
    changeHash(OTHER_SHA);
    expect(await accept([t('metal')])).toBe(false);
    expect(await db.analyses.getProposal(FILE_ID)).toBeNull();
    expect(rowCount('file_tag')).toBe(0);
    expect(await db.analyses.get(FILE_ID)).toBeNull();
  });

  test('accept with a hash other than the proposal deletes it', async () => {
    await db.analyses.propose(proposal());
    expect(await accept([t('metal')], { sha256: OTHER_SHA })).toBe(false);
    expect(await db.analyses.getProposal(FILE_ID)).toBeNull();
    expect(rowCount('file_tag')).toBe(0);
  });

  test('accept with a tag outside the stored proposal writes nothing and keeps the proposal', async () => {
    await db.analyses.propose(proposal());
    expect(await accept([t('metal'), t('wood')])).toBe(false);
    expect(await db.analyses.getProposal(FILE_ID)).toEqual({ ...proposal(), stale: false });
    expect(rowCount('file_tag')).toBe(0);
    expect(rowCount('tag')).toBe(0);
    expect(await db.analyses.get(FILE_ID)).toBeNull();
  });

  test('accept with no tags writes nothing and keeps the proposal', async () => {
    await db.analyses.propose(proposal());
    expect(await accept([])).toBe(false);
    expect(await db.analyses.getProposal(FILE_ID)).toEqual({ ...proposal(), stale: false });
    expect(rowCount('file_tag')).toBe(0);
    expect(await db.analyses.get(FILE_ID)).toBeNull();
  });

  test('accept without a proposal returns false', async () => {
    expect(await accept([t('metal')])).toBe(false);
    expect(rowCount('file_tag')).toBe(0);
    expect(await db.analyses.get(FILE_ID)).toBeNull();
  });

  test('apply deletes a waiting proposal', async () => {
    await db.analyses.propose(proposal());
    expect(
      await db.analyses.apply({
        fileId: FILE_ID,
        sha256: SHA,
        tags: [t('blue')],
        provider: 'ollama',
        model: 'qwen',
        promptVersion: 1,
        promptName: null,
        now: T2,
      }),
    ).toBe(true);
    expect(await db.analyses.getProposal(FILE_ID)).toBeNull();
  });

  test('discard deletes the proposal and is idempotent', async () => {
    await db.analyses.propose(proposal());
    await db.analyses.discardProposal(FILE_ID);
    expect(await db.analyses.getProposal(FILE_ID)).toBeNull();
    await expect(db.analyses.discardProposal(FILE_ID)).resolves.toBeUndefined();
  });

  test('file records carry hasProposal and files:list filters on it', async () => {
    const other = uuid(41);
    await addFile(other);
    expect((await db.files.get(FILE_ID))?.hasProposal).toBe(false);
    await db.analyses.propose(proposal());
    expect((await db.files.get(FILE_ID))?.hasProposal).toBe(true);
    expect((await db.files.get(other))?.hasProposal).toBe(false);

    const ids = async (hasProposal?: boolean) =>
      (
        await db.files.list({
          limit: 10,
          offset: 0,
          scope: { kind: 'all' },
          ...(hasProposal !== undefined && { hasProposal }),
        })
      ).items
        .map((f) => f.id)
        .sort();
    expect(await ids(true)).toEqual([FILE_ID]);
    expect(await ids(false)).toEqual([other]);
    expect(await ids()).toEqual([FILE_ID, other]);
    expect((await db.files.list({ limit: 10, offset: 0, scope: { kind: 'all' }, hasProposal: true })).total).toBe(1);
  });

  test('acceptProposal on a trashed file returns false and keeps the proposal', async () => {
    await db.analyses.propose(proposal());
    await db.fileMoves.begin({
      fileId: FILE_ID,
      kind: 'trash',
      targetRelativePath: `.assetforge/trash/${FILE_ID}_f.png`,
      targetAssetId: null,
      targetRole: null,
      createdAt: T2,
    });
    await db.fileMoves.commit(FILE_ID);

    expect(await accept([t('metal')], { now: T3 })).toBe(false);
    // The proposal waits for the file to come back from the trash.
    expect(await db.analyses.getProposal(FILE_ID)).toEqual({ ...proposal(), stale: false });
    expect(rowCount('file_tag')).toBe(0);
    expect(await db.analyses.get(FILE_ID)).toBeNull();
    expect((await db.files.get(FILE_ID))?.hasProposal).toBe(true);
  });
});

describe('tag rename and waiting proposals', () => {
  const tagAsset = (name: string, displayName = name) =>
    db.tags.addToAsset({ assetId: ASSET_ID, name, displayName, origin: 'manual', newId: uuid(nextTagId++), now: T0 });
  const rawProposal = (fileId: string) =>
    handle.prepare('select * from file_analysis_proposal where file_id = ?').get(fileId);
  const pairs = (...names: [string, string][]) => names.map(([name, displayName]) => ({ name, displayName }));

  test('a merge rewrites the source entry with the target display name and keeps the rest of the proposal', async () => {
    const other = uuid(41);
    await addFile(other);
    await tagAsset('front view', 'Front View');
    await tagAsset('frontal', 'frontal');
    const held = proposal({ tags: pairs(['front view', 'Front View'], ['metal', 'Metal']), promptName: 'Default' });
    await db.analyses.propose(held);
    const third = uuid(44);
    await addFile(third);
    await db.analyses.propose(proposal({ fileId: other, tags: pairs(['metal', 'Metal'], ['frontal', 'frontal']) }));
    await db.analyses.propose(proposal({ fileId: third, tags: pairs(['metal', 'Metal']) }));
    const before = rawProposal(other) as { tags: string };
    const untouched = rawProposal(third);

    await db.tags.rename({ from: 'front view', name: 'frontal', displayName: 'Frontal', merge: true });
    expect(await db.analyses.getProposal(FILE_ID)).toEqual({
      ...held,
      tags: pairs(['frontal', 'Frontal'], ['metal', 'Metal']),
      stale: false,
    });
    // The target entry takes the new display name; nothing else of that proposal changes.
    expect(rawProposal(other)).toEqual({
      ...before,
      tags: JSON.stringify(pairs(['metal', 'Metal'], ['frontal', 'Frontal'])),
    });
    expect(rawProposal(third)).toEqual(untouched);
  });

  test('a proposal holding source and target keeps one entry at the first position', async () => {
    await tagAsset('front view', 'Front View');
    await tagAsset('front', 'Front');
    await db.analyses.propose(proposal({ tags: pairs(['front view', 'Front View'], ['front', 'Front']) }));
    await db.tags.rename({ from: 'front view', name: 'front', displayName: 'FRONT', merge: true });
    expect((await db.analyses.getProposal(FILE_ID))!.tags).toEqual(pairs(['front', 'FRONT']));
  });

  test('a merge gives every kept target entry the new display name, also in proposals without the source', async () => {
    const other = uuid(42);
    await addFile(other);
    await tagAsset('front view', 'Front View');
    await tagAsset('front', 'Front');
    await db.analyses.propose(proposal({ tags: pairs(['front', 'Front'], ['front view', 'Front View']) }));
    await db.analyses.propose(proposal({ fileId: other, tags: pairs(['metal', 'Metal'], ['front', 'Front']) }));
    await db.tags.rename({ from: 'front view', name: 'front', displayName: 'FRONT', merge: true });
    expect((await db.analyses.getProposal(FILE_ID))!.tags).toEqual(pairs(['front', 'FRONT']));
    expect((await db.analyses.getProposal(other))!.tags).toEqual(pairs(['metal', 'Metal'], ['front', 'FRONT']));
  });

  test('a display-name-only change rewrites proposals holding the tag and leaves the others alone', async () => {
    const other = uuid(43);
    await addFile(other);
    await tagAsset('front', 'front');
    await db.analyses.propose(proposal({ tags: pairs(['front', 'front'], ['metal', 'Metal']) }));
    await db.analyses.propose(proposal({ fileId: other, tags: pairs(['metal', 'Metal']) }));
    const untouched = rawProposal(other);
    await db.tags.rename({ from: 'front', name: 'front', displayName: 'Front', merge: false });
    expect((await db.analyses.getProposal(FILE_ID))!.tags).toEqual(pairs(['front', 'Front'], ['metal', 'Metal']));
    expect(rawProposal(other)).toEqual(untouched);
  });

  test('names with LIKE wildcards, quotes and backslashes are rewritten exactly', async () => {
    const names = ['50%', 'a_b', 'say "hi"', 'back\\slash'];
    const files = names.map((_, i) => uuid(50 + i));
    for (const [i, name] of names.entries()) {
      await addFile(files[i]!);
      await tagAsset(name);
      await db.analyses.propose(proposal({ fileId: files[i]!, tags: pairs([name, name], ['metal', 'metal']) }));
    }
    const lookalike = uuid(60);
    await addFile(lookalike);
    await db.analyses.propose(proposal({ fileId: lookalike, tags: pairs(['50x', '50x']) }));
    const untouched = rawProposal(lookalike);

    for (const [i, name] of names.entries()) {
      await db.tags.rename({ from: name, name: `renamed ${i}`, displayName: `Renamed ${i}`, merge: false });
      expect((await db.analyses.getProposal(files[i]!))!.tags).toEqual(
        pairs([`renamed ${i}`, `Renamed ${i}`], ['metal', 'metal']),
      );
    }
    expect(rawProposal(lookalike)).toEqual(untouched);
  });

  test('a rewritten proposal is accepted with the new name, not with the old one', async () => {
    await tagAsset('front view', 'Front View');
    await db.analyses.propose(proposal({ tags: pairs(['front view', 'Front View'], ['metal', 'metal']) }));
    await db.tags.rename({ from: 'front view', name: 'frontal', displayName: 'Frontal', merge: false });

    expect(await accept([t('front view', 'Front View')])).toBe(false);
    expect(await accept([t('frontal', 'Frontal')])).toBe(true);
    expect(await tagsOf()).toEqual(['frontal/ai']);
  });
});
