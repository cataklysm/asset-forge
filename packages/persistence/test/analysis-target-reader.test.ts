import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AnalysisTarget, FileKind, FileRole } from '@assetforge/contracts';
import { BUILT_IN_ASSET_TYPES, type AnalysisFingerprint, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE_ID = uuid(1);
const TYPE_ID = uuid(2);
const ASSET_A = uuid(3);
const ASSET_B = uuid(4);
const ASSET_C = uuid(5);
const SHA = 'a'.repeat(64);
const FP: AnalysisFingerprint = { provider: 'ollama', model: 'qwen', promptVersion: 1 };
const MIME = ['image/png', 'image/jpeg'] as const;

// Inbox
const I_RUST = uuid(101);
const I_OTHER = uuid(102);
const I_TEXT = uuid(103);
const I_PENDING = uuid(104);
// Asset A ("Pump", asset tag "hero")
const A_REF = uuid(201);
const A_CONCEPT = uuid(202);
// Asset B ("Valve")
const B_REF = uuid(301);

let dir: string;
let db: WorkspaceDatabase;
let handle: Database.Database;
let nextId = 5000;

interface FileSpec {
  id: string;
  name: string;
  mimeType?: string;
  kind?: FileKind;
  complete?: boolean;
  asset?: { id: string; role: FileRole };
}

async function addFile(f: FileSpec): Promise<void> {
  await db.files.insertPending({
    id: f.id,
    storageId: STORAGE_ID,
    originalName: f.name,
    relativePath: `inbox/${f.id}/${f.name}`,
    mimeType: f.mimeType ?? 'image/png',
    importedAt: T0,
    kind: f.kind ?? 'image',
  });
  if (f.complete !== false) await db.files.markComplete(f.id, { sizeBytes: 1, sha256: SHA, width: null, height: null });
  if (f.asset) {
    await db.files.setPlacement(f.id, { relativePath: `assets/${f.asset.id}/${f.name}`, assetId: f.asset.id, role: f.asset.role });
  }
}

const addAsset = (id: string, name: string) =>
  db.assets.insert({ id, name, typeId: TYPE_ID, description: '', status: 'draft', createdAt: T0, updatedAt: T0 });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-targets-'));
  const pragma = vi.spyOn(Database.prototype, 'pragma');
  try {
    db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
    handle = pragma.mock.contexts[0] as Database.Database;
  } finally {
    pragma.mockRestore();
  }
  await db.storages.ensurePrimary({ id: STORAGE_ID, createdAt: T0 });
  await db.assetTypes.insertMissing([
    { id: TYPE_ID, key: BUILT_IN_ASSET_TYPES[0]!.key, name: 'T', sortOrder: 0, builtIn: true, defaultWorkflowTemplateId: null },
  ]);
  await addAsset(ASSET_A, 'Pump');
  await addAsset(ASSET_B, 'Valve');
  await db.tags.addToAsset({ assetId: ASSET_A, name: 'hero', displayName: 'hero', origin: 'manual', newId: uuid(nextId++), now: T0 });

  await addFile({ id: I_RUST, name: 'rust.png' });
  await addFile({ id: I_OTHER, name: 'other.png' });
  await addFile({ id: I_TEXT, name: 'notes.txt', mimeType: 'text/plain', kind: 'document' });
  await addFile({ id: I_PENDING, name: 'pending.png', complete: false });
  await addFile({ id: A_REF, name: 'a-ref.png', asset: { id: ASSET_A, role: 'reference' } });
  await addFile({ id: A_CONCEPT, name: 'a-concept.png', asset: { id: ASSET_A, role: 'concept' } });
  await addFile({ id: B_REF, name: 'b.png', asset: { id: ASSET_B, role: 'reference' } });
  await db.tags.addToFile({ fileId: I_RUST, name: 'metal', displayName: 'metal', origin: 'manual', newId: uuid(nextId++), now: T0 });
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const page = (target: AnalysisTarget, o: { fingerprint?: AnalysisFingerprint; afterId?: string | null; limit?: number } = {}) =>
  db.analysisTargets.page({
    target,
    fingerprint: o.fingerprint ?? FP,
    mimeTypes: MIME,
    afterId: o.afterId ?? null,
    limit: o.limit ?? 100,
  });
const ids = async (target: AnalysisTarget) => (await page(target)).map((e) => e.fileId);
const count = (target: AnalysisTarget, fingerprint: AnalysisFingerprint = FP) =>
  db.analysisTargets.count({ target, fingerprint, mimeTypes: MIME });
const analysedOf = async (fileId: string, fingerprint: AnalysisFingerprint = FP) =>
  (await page({ kind: 'files', fileIds: [fileId] }, { fingerprint }))[0]?.analysed;

const applyAnalysis = (fileId: string) =>
  db.analyses.apply({ fileId, sha256: SHA, tags: [], provider: FP.provider, model: FP.model, promptVersion: FP.promptVersion, promptName: null, now: T1 });
const proposeFor = (fileId: string) =>
  db.analyses.propose({ fileId, sha256: SHA, ...FP, tags: [{ name: 'blue', displayName: 'blue' }], promptName: null, createdAt: T1 });

describe('analysis target reader', () => {
  test('a files target lists the known files by id and marks the analysable ones', async () => {
    expect(await page({ kind: 'files', fileIds: [I_PENDING, uuid(999), I_TEXT, I_RUST] })).toEqual([
      { fileId: I_RUST, analysable: true, analysed: false },
      { fileId: I_TEXT, analysable: false, analysed: false },
      { fileId: I_PENDING, analysable: false, analysed: false },
    ]);
    expect(await count({ kind: 'files', fileIds: [I_PENDING, uuid(999), I_TEXT, I_RUST] })).toEqual({
      analysable: 1,
      alreadyAnalysed: 0,
      alreadyQueued: 0,
      notAnalysable: 2,
    });
  });

  test('a file filter target uses the file list filter', async () => {
    const inbox = { kind: 'inbox' } as const;
    expect(await ids({ kind: 'fileFilter', filter: { scope: inbox } })).toEqual([I_RUST, I_OTHER, I_TEXT, I_PENDING]);
    expect(await ids({ kind: 'fileFilter', filter: { scope: inbox, query: 'rus' } })).toEqual([I_RUST]);
    expect(await ids({ kind: 'fileFilter', filter: { scope: inbox, tagNames: ['metal'] } })).toEqual([I_RUST]);
    expect(await ids({ kind: 'fileFilter', filter: { scope: inbox, tagNames: ['Metal'] } })).toEqual([I_RUST]);
    expect(await ids({ kind: 'fileFilter', filter: { scope: inbox, tagNames: ['missing'] } })).toEqual([]);
    expect(await ids({ kind: 'fileFilter', filter: { scope: inbox, kind: 'document' } })).toEqual([I_TEXT]);
    expect(await ids({ kind: 'fileFilter', filter: { scope: { kind: 'all' }, role: 'concept' } })).toEqual([A_CONCEPT]);
    expect(await count({ kind: 'fileFilter', filter: { scope: inbox, tagNames: ['missing'] } })).toEqual({
      analysable: 0,
      alreadyAnalysed: 0,
      alreadyQueued: 0,
      notAnalysable: 0,
    });
  });

  test('an asset target lists every file of the asset', async () => {
    expect(await ids({ kind: 'asset', assetId: ASSET_A })).toEqual([A_REF, A_CONCEPT]);
    expect(await ids({ kind: 'asset', assetId: uuid(998) })).toEqual([]);
    expect(await count({ kind: 'asset', assetId: ASSET_A })).toMatchObject({ analysable: 2 });
  });

  test('an asset filter target lists the files of the matching assets', async () => {
    expect(await ids({ kind: 'assetFilter', filter: {} })).toEqual([A_REF, A_CONCEPT, B_REF]);
    expect(await ids({ kind: 'assetFilter', filter: { fileRole: 'reference' } })).toEqual([A_REF, B_REF]);
    expect(await ids({ kind: 'assetFilter', filter: { tagNames: ['hero'] } })).toEqual([A_REF, A_CONCEPT]);
    expect(await ids({ kind: 'assetFilter', filter: { query: 'pump' } })).toEqual([A_REF, A_CONCEPT]);
    expect(await ids({ kind: 'assetFilter', filter: { query: 'valve', fileRole: 'reference' } })).toEqual([B_REF]);
    expect(await ids({ kind: 'assetFilter', filter: { fileKind: 'document' } })).toEqual([]);
    expect(await ids({ kind: 'assetFilter', filter: { tagNames: ['missing'] } })).toEqual([]);
  });

  test('analysed follows the analysis row and the waiting proposal with the same fingerprint and hash', async () => {
    await applyAnalysis(A_REF);
    await proposeFor(A_CONCEPT);
    expect(await analysedOf(A_REF)).toBe(true);
    expect(await analysedOf(A_CONCEPT)).toBe(true);
    expect(await analysedOf(B_REF)).toBe(false);
    expect(await analysedOf(A_REF, { ...FP, model: 'llava' })).toBe(false);
    expect(await analysedOf(A_CONCEPT, { ...FP, model: 'llava' })).toBe(false);
    expect(await analysedOf(A_REF, { ...FP, promptVersion: 2 })).toBe(false);
    expect(await analysedOf(A_REF, { ...FP, provider: 'other' })).toBe(false);
    handle.prepare('update file set sha256 = ? where id in (?, ?)').run('b'.repeat(64), A_REF, A_CONCEPT);
    expect(await analysedOf(A_REF)).toBe(false);
    expect(await analysedOf(A_CONCEPT)).toBe(false);
  });

  test('count splits the target into disjoint groups and counts active jobs as queued', async () => {
    await applyAnalysis(A_REF);
    await proposeFor(A_CONCEPT);
    const job = {
      id: uuid(900),
      type: 'vision.analyze_file',
      resourceClass: 'local_gpu' as const,
      fileId: B_REF,
      payload: { version: 2 },
      dedupeKey: `vision.analyze_file:${B_REF}`,
    };
    await db.jobs.enqueue({ jobs: [job, { ...job, id: uuid(901), fileId: I_RUST, dedupeKey: `vision.analyze_file:${I_RUST}` }], now: T0 });
    const all = { kind: 'fileFilter', filter: { scope: { kind: 'all' } } } as const;
    expect(await count(all)).toEqual({ analysable: 1, alreadyAnalysed: 2, alreadyQueued: 2, notAnalysable: 2 });
    expect(await count(all, { ...FP, model: 'llava' })).toEqual({ analysable: 3, alreadyAnalysed: 0, alreadyQueued: 2, notAnalysable: 2 });

    await db.jobs.cancelPending({ id: uuid(900), now: T1 });
    expect(await count(all)).toEqual({ analysable: 2, alreadyAnalysed: 2, alreadyQueued: 1, notAnalysable: 2 });
  });

  test('an analysed file counts as analysed, not as queued', async () => {
    await applyAnalysis(B_REF);
    await db.jobs.enqueue({
      jobs: [
        {
          id: uuid(900),
          type: 'vision.analyze_file',
          resourceClass: 'local_gpu',
          fileId: B_REF,
          lane: null,
          payload: { version: 2 },
          dedupeKey: `vision.analyze_file:${B_REF}`,
        },
      ],
      now: T0,
    });
    expect(await count({ kind: 'asset', assetId: ASSET_B })).toEqual({ analysable: 0, alreadyAnalysed: 1, alreadyQueued: 0, notAnalysable: 0 });
  });

  test('without mime types nothing is analysable', async () => {
    expect(await db.analysisTargets.page({ target: { kind: 'asset', assetId: ASSET_A }, fingerprint: FP, mimeTypes: [], afterId: null, limit: 10 })).toEqual([
      { fileId: A_REF, analysable: false, analysed: false },
      { fileId: A_CONCEPT, analysable: false, analysed: false },
    ]);
  });

  test('keyset pages cover a large target exactly once', async () => {
    await addAsset(ASSET_C, 'Crate');
    const insert = handle.prepare(
      `insert into file (id, storage_id, asset_id, role, original_name, relative_path, mime_type, sha256, status, kind, imported_at)
       values (?, ?, ?, 'reference', ?, ?, 'image/png', ?, 'complete', 'image', ?)`,
    );
    handle.transaction(() => {
      for (let i = 0; i < 1201; i++) {
        const id = uuid(100_000 + i);
        insert.run(id, STORAGE_ID, ASSET_C, `c${i}.png`, `assets/${ASSET_C}/c${i}.png`, SHA, T0);
      }
    })();
    const target = { kind: 'asset', assetId: ASSET_C } as const;
    const seen: string[] = [];
    const sizes: number[] = [];
    let afterId: string | null = null;
    for (;;) {
      const entries = await page(target, { afterId, limit: 500 });
      if (entries.length === 0) break;
      sizes.push(entries.length);
      seen.push(...entries.map((e) => e.fileId));
      afterId = entries.at(-1)!.fileId;
    }
    expect(sizes).toEqual([500, 500, 201]);
    expect(new Set(seen).size).toBe(1201);
    expect(seen).toEqual([...seen].sort());
    expect(await count(target)).toMatchObject({ analysable: 1201 });
  });
});

describe('trashed files as analysis targets', () => {
  /** Sends the analysable inbox image I_OTHER and the asset file A_CONCEPT to the trash. */
  async function trashSome(): Promise<void> {
    for (const id of [I_OTHER, A_CONCEPT]) {
      await db.fileMoves.begin({
        fileId: id,
        kind: 'trash',
        targetRelativePath: `.assetforge/trash/${id}_f.png`,
        targetAssetId: null,
        targetRole: null,
        createdAt: T1,
      });
      await db.fileMoves.commit(id);
    }
  }

  test('a trashed file is not analysable for a files target', async () => {
    await trashSome();
    expect(await page({ kind: 'files', fileIds: [I_RUST, I_OTHER, A_CONCEPT] })).toEqual([
      { fileId: I_RUST, analysable: true, analysed: false },
      { fileId: I_OTHER, analysable: false, analysed: false },
      { fileId: A_CONCEPT, analysable: false, analysed: false },
    ]);
  });

  test('a trashed file is not analysable for a fileFilter target', async () => {
    await trashSome();
    expect(await ids({ kind: 'fileFilter', filter: { scope: { kind: 'inbox' } } })).toEqual([I_RUST, I_TEXT, I_PENDING]);
    expect(await ids({ kind: 'fileFilter', filter: { scope: { kind: 'all' } } })).not.toContain(I_OTHER);
    expect(await page({ kind: 'fileFilter', filter: { scope: { kind: 'trash' } } })).toEqual([
      { fileId: I_OTHER, analysable: false, analysed: false },
      { fileId: A_CONCEPT, analysable: false, analysed: false },
    ]);
  });

  test('count agrees with page', async () => {
    await trashSome();
    const targets: AnalysisTarget[] = [
      { kind: 'files', fileIds: [I_RUST, I_OTHER, A_CONCEPT, I_TEXT] },
      { kind: 'fileFilter', filter: { scope: { kind: 'trash' } } },
      { kind: 'fileFilter', filter: { scope: { kind: 'all' } } },
    ];
    for (const target of targets) {
      const entries = await page(target);
      const preview = await count(target);
      expect({ target, preview }).toEqual({
        target,
        preview: {
          analysable: entries.filter((e) => e.analysable).length,
          alreadyAnalysed: 0,
          alreadyQueued: 0,
          notAnalysable: entries.filter((e) => !e.analysable).length,
        },
      });
    }
    expect(await count({ kind: 'fileFilter', filter: { scope: { kind: 'trash' } } })).toEqual({
      analysable: 0,
      alreadyAnalysed: 0,
      alreadyQueued: 0,
      notAnalysable: 2,
    });
  });
});
