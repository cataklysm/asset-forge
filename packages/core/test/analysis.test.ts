import { describe, expect, it } from 'vitest';
import { ANALYZE_FILE_JOB } from '@assetforge/contracts';
import {
  ANALYSIS_PROMPT,
  ANALYSIS_SCHEMA,
  addFileTag,
  cleanAnalysisTags,
  createAnalyzeFileHandler,
  enqueueAnalysis,
  JobError,
  MAX_ANALYSIS_TAGS,
  WorkspaceManager,
  type Job,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost, FakeModelImageSource, FakeVisionProvider } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const T0 = '2026-01-01T00:00:00.000Z';

async function setup() {
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
  const file = await importOne('car.png');
  const vision = new FakeVisionProvider();
  const images = new FakeModelImageSource();
  const handler = createAnalyzeFileHandler({ session, vision, images, provider: 'ollama', model: 'mock-vision' });
  return { db, storage, session, importOne, file, vision, images, handler };
}

function jobFor(fileId: string | null, payload: unknown = { version: 1 }): Job {
  return {
    id: 'job-1',
    type: ANALYZE_FILE_JOB,
    resourceClass: 'local_gpu',
    status: 'running',
    fileId,
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

async function rejectsWith(p: Promise<unknown>, code: JobError['code']): Promise<void> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(JobError);
  expect((error as JobError).code).toBe(code);
}

describe('cleanAnalysisTags', () => {
  it('drops non-strings, invalid and duplicate tags', () => {
    expect(cleanAnalysisTags({ tags: ['Red  Car', 'red car', 7, '', 'x'.repeat(200), null] })).toEqual([
      { name: 'red car', displayName: 'Red Car' },
    ]);
  });

  it('keeps the first 20 distinct tags', () => {
    const tags = Array.from({ length: 500 }, (_, i) => `tag ${i}`);
    const cleaned = cleanAnalysisTags({ tags });
    expect(cleaned).toHaveLength(MAX_ANALYSIS_TAGS);
    expect(cleaned.map((t) => t.name)).toEqual(tags.slice(0, 20));
  });

  it('yields nothing for answers of another shape', () => {
    for (const answer of [{}, 'text', { tags: 'a' }, null, undefined, 42, ['a', 'b'], { tags: { 0: 'a' } }, { tags: [[], {}, 1] }]) {
      expect(cleanAnalysisTags(answer)).toEqual([]);
    }
  });
});

describe('enqueueAnalysis', () => {
  it('enqueues analysable files and reports the rest in request order', async () => {
    const { db, session, importOne, file } = await setup();
    const queued = await importOne('queued.png');
    const pending = await importOne('pending.png');
    db.files.records.set(pending.id, { ...db.files.records.get(pending.id)!, status: 'pending', sha256: null });
    const blend = await importOne('scene.blend');
    await enqueueAnalysis(session, { fileIds: [queued.id] });

    const result = await enqueueAnalysis(session, { fileIds: [file.id, UNKNOWN_ID, pending.id, blend.id, queued.id] });

    expect(result).toEqual({
      enqueued: 1,
      skipped: [
        { fileId: UNKNOWN_ID, reason: 'not_found' },
        { fileId: pending.id, reason: 'not_analysable' },
        { fileId: blend.id, reason: 'not_analysable' },
        { fileId: queued.id, reason: 'already_queued' },
      ],
    });
    const job = db.jobs.rows.find((j) => j.fileId === file.id)!;
    expect(job).toMatchObject({
      type: ANALYZE_FILE_JOB,
      resourceClass: 'local_gpu',
      status: 'queued',
      payload: { version: 1 },
      dedupeKey: `vision.analyze_file:${file.id}`,
    });
  });
});

describe('the analyze file handler', () => {
  it('has the GPU class and is requeued when interrupted', async () => {
    const { handler } = await setup();
    expect(handler).toMatchObject({ resourceClass: 'local_gpu', onInterrupted: 'requeue' });
  });

  it('writes the AI tags and the analysis record', async () => {
    const { db, file, vision, images, handler } = await setup();
    await handler.run(jobFor(file.id), new AbortController().signal);

    expect(images.calls).toEqual([`/memory/${file.relativePath}`]);
    expect(vision.calls).toEqual([{ image: new Uint8Array([0xff, 0xd8, 0xff]), prompt: ANALYSIS_PROMPT, schema: ANALYSIS_SCHEMA }]);
    expect(db.tags.forFile(file.id)).toEqual([
      { name: 'front view', displayName: 'front view', origin: 'ai' },
      { name: 'metal', displayName: 'metal', origin: 'ai' },
      { name: 'photorealistic', displayName: 'photorealistic', origin: 'ai' },
      { name: 'red car', displayName: 'Red Car', origin: 'ai' },
    ]);
    expect(await db.analyses.get(file.id)).toMatchObject({
      fileId: file.id,
      sha256: file.sha256,
      provider: 'ollama',
      model: 'mock-vision',
      promptVersion: 1,
    });
  });

  it('fails with file_unavailable without asking the provider when the file cannot be read', async () => {
    const cases: ((c: Awaited<ReturnType<typeof setup>>) => Promise<string>)[] = [
      async () => UNKNOWN_ID,
      async ({ db, file }) => {
        db.files.records.set(file.id, { ...db.files.records.get(file.id)!, status: 'pending' });
        return file.id;
      },
      async ({ importOne }) => (await importOne('notes.txt')).id,
      async ({ storage, file }) => {
        storage.failNext('absolutePath', new Error('/secret/path broke'));
        return file.id;
      },
      async ({ storage, file }) => {
        storage.reachable = false;
        return file.id;
      },
      async ({ images, file }) => {
        images.script = [new Error('decoder crashed')];
        return file.id;
      },
    ];
    for (const prepare of cases) {
      const c = await setup();
      const fileId = await prepare(c);
      await rejectsWith(c.handler.run(jobFor(fileId), new AbortController().signal), 'file_unavailable');
      expect(c.vision.calls).toEqual([]);
      expect(await c.db.analyses.get(fileId)).toBeNull();
    }
  });

  it('fails with internal_error for a job without file or with a bad payload', async () => {
    const { file, vision, handler } = await setup();
    await rejectsWith(handler.run(jobFor(null), new AbortController().signal), 'internal_error');
    await rejectsWith(handler.run(jobFor(file.id, { version: 2 }), new AbortController().signal), 'internal_error');
    await rejectsWith(handler.run(jobFor(file.id, null), new AbortController().signal), 'internal_error');
    expect(vision.calls).toEqual([]);
  });

  it('reads a file again from its new path when it moved while it was read', async () => {
    const { db, file, vision, images, handler } = await setup();
    const movedPath = `assets/moved/${file.relativePath.split('/').pop()}`;
    images.script = [
      () => {
        db.files.records.set(file.id, { ...db.files.records.get(file.id)!, relativePath: movedPath });
        return null;
      },
      new Uint8Array([1, 2, 3]),
    ];
    await handler.run(jobFor(file.id), new AbortController().signal);

    expect(images.calls).toEqual([`/memory/${file.relativePath}`, `/memory/${movedPath}`]);
    expect(vision.calls[0]!.image).toEqual(new Uint8Array([1, 2, 3]));
    expect(await db.analyses.get(file.id)).not.toBeNull();
  });

  it('fails with file_unavailable when no image can be produced', async () => {
    const unchanged = await setup();
    unchanged.images.script = [null];
    await rejectsWith(unchanged.handler.run(jobFor(unchanged.file.id), new AbortController().signal), 'file_unavailable');
    expect(unchanged.images.calls).toHaveLength(1);
    expect(unchanged.vision.calls).toEqual([]);

    const moved = await setup();
    moved.images.script = [
      () => {
        moved.db.files.records.set(moved.file.id, { ...moved.db.files.records.get(moved.file.id)!, relativePath: 'assets/x/car.png' });
        return null;
      },
      null,
    ];
    await rejectsWith(moved.handler.run(jobFor(moved.file.id), new AbortController().signal), 'file_unavailable');
    expect(moved.images.calls).toHaveLength(2);
    expect(moved.vision.calls).toEqual([]);
  });

  it('writes nothing when the content changed during the provider call', async () => {
    const { db, file, vision, handler } = await setup();
    vision.respond = async () => {
      db.files.records.set(file.id, { ...db.files.records.get(file.id)!, sha256: 'f'.repeat(64) });
      return { tags: ['car'] };
    };
    await rejectsWith(handler.run(jobFor(file.id), new AbortController().signal), 'file_unavailable');
    expect(db.tags.forFile(file.id)).toEqual([]);
    expect(await db.analyses.get(file.id)).toBeNull();
  });

  it('writes nothing when aborted during the provider call', async () => {
    const { db, file, vision, handler } = await setup();
    const controller = new AbortController();
    vision.respond = async () => {
      controller.abort(new Error('cancelled'));
      return { tags: ['car'] };
    };
    await expect(handler.run(jobFor(file.id), controller.signal)).rejects.toThrow('cancelled');
    expect(db.tags.forFile(file.id)).toEqual([]);
    expect(await db.analyses.get(file.id)).toBeNull();
  });

  it('does not ask the provider when aborted while the image was read', async () => {
    const { db, file, vision, images, handler } = await setup();
    const controller = new AbortController();
    images.script = [
      () => {
        controller.abort(new Error('cancelled'));
        return new Uint8Array([1]);
      },
    ];
    await expect(handler.run(jobFor(file.id), controller.signal)).rejects.toThrow('cancelled');
    expect(vision.calls).toEqual([]);
    expect(await db.analyses.get(file.id)).toBeNull();
  });

  it('fails with invalid_response for an answer without a usable tag', async () => {
    for (const answer of [null, 7, [], 'tags', {}, { tags: null }, { tags: [1, '', '!!!'] }]) {
      const { db, file, vision, handler } = await setup();
      vision.answer = answer;
      await rejectsWith(handler.run(jobFor(file.id), new AbortController().signal), 'invalid_response');
      expect(await db.analyses.get(file.id)).toBeNull();
    }
  });

  it('passes a provider JobError through unchanged', async () => {
    const { file, vision, handler } = await setup();
    const error = new JobError('provider_unreachable');
    vision.respond = async () => {
      throw error;
    };
    await expect(handler.run(jobFor(file.id), new AbortController().signal)).rejects.toBe(error);
  });

  it('leaves a manual tag the provider also names manual and single', async () => {
    const { db, session, file, handler } = await setup();
    await addFileTag(session, { fileId: file.id, name: 'metal' });
    await handler.run(jobFor(file.id), new AbortController().signal);
    expect(db.tags.forFile(file.id).filter((t) => t.name === 'metal')).toEqual([
      { name: 'metal', displayName: 'metal', origin: 'manual' },
    ]);
  });

  it('replaces the AI tags of an earlier run', async () => {
    const { db, file, vision, handler } = await setup();
    await handler.run(jobFor(file.id), new AbortController().signal);
    vision.answer = { tags: ['blue boat', 'wood'] };
    await handler.run(jobFor(file.id), new AbortController().signal);
    expect(db.tags.forFile(file.id).map((t) => t.name)).toEqual(['blue boat', 'wood']);
  });
});
