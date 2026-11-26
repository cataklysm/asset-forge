import { expect } from 'vitest';
import { ANALYZE_FILE_JOB, type FileRecord } from '@assetforge/contracts';
import { createAnalyzeFileHandler, JobError, WorkspaceManager, type Job, type WorkspaceSession } from '../src/index.js';
import { createFakeHost, FakeModelImageSource, FakeVisionProvider } from './fakes.js';

export const ROOT = '/ws/a';
export const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
export const T0 = '2026-01-01T00:00:00.000Z';
export const PROVIDER = 'ollama';

/** A workspace with one imported `car.png`, a fake provider and image source, and the analyze handler. */
export async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const db = fake.databases.get(summary.id)!;
  const storage = fake.storages.get(ROOT)!;
  const session: WorkspaceSession = await manager.read(async (s) => s);
  const importOne = async (name: string) => {
    fake.sources.set(`/src/${name}`, Buffer.from(name));
    return (await manager.importFiles([`/src/${name}`]))[0]!.file!;
  };
  /** Inserts a complete PNG record directly, bypassing the import, for large targets. */
  const seedFile = (patch: Partial<FileRecord> = {}): FileRecord => {
    const id = crypto.randomUUID();
    const record: FileRecord = {
      id,
      storageId: session.storageId,
      assetId: null,
      role: null,
      originalName: `${id}.png`,
      relativePath: `inbox/${id}.png`,
      mimeType: 'image/png',
      sizeBytes: 1,
      sha256: id.replace(/-/g, '').padEnd(64, '0'),
      status: 'complete',
      error: null,
      importedAt: T0,
      previewable: true,
      openable: true,
      kind: 'image',
      width: null,
      height: null,
      tags: [],
      hasProposal: false,
      deletedAt: null,
      trashedAssetId: null,
      trashedAssetName: null,
      trashedRole: null,
      ...patch,
    };
    db.files.records.set(id, record);
    return record;
  };
  const file = await importOne('car.png');
  const vision = new FakeVisionProvider();
  const images = new FakeModelImageSource();
  let configured: { vision: FakeVisionProvider | null } = { vision };
  /** The lane of every provider lookup of the handler. */
  const lanes: (string | null)[] = [];
  const handler = createAnalyzeFileHandler({
    session,
    vision: (lane) => {
      lanes.push(lane);
      return configured.vision;
    },
    images,
    provider: PROVIDER,
  });
  const configure = (c: { vision: FakeVisionProvider | null }) => {
    configured = c;
  };
  return { manager, db, storage, session, importOne, seedFile, file, vision, images, handler, configure, lanes };
}

export type Setup = Awaited<ReturnType<typeof setup>>;

export const LANE = 'lane-a';

/** A v4 payload without a prompt: the legacy request with the model `mock-vision`. */
export const LEGACY_V4 = { version: 4, model: 'mock-vision', mode: 'apply', prompt: null, providerName: 'Local' } as const;

export function jobFor(fileId: string | null, payload: unknown = LEGACY_V4, lane: string | null = LANE): Job {
  return {
    id: 'job-1',
    type: ANALYZE_FILE_JOB,
    resourceClass: 'local_gpu',
    status: 'running',
    fileId,
    lane,
    payload,
    dedupeKey: fileId === null ? null : `${ANALYZE_FILE_JOB}:${fileId}`,
    attempt: 1,
    runAfter: null,
    errorCode: null,
    errorMessage: null,
    createdAt: T0,
    startedAt: T0,
    finishedAt: null,
    updatedAt: T0,
  };
}

export async function rejectsWith(p: Promise<unknown>, code: JobError['code']): Promise<void> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(JobError);
  expect((error as JobError).code).toBe(code);
}
