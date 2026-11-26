import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_PROMPT,
  ANALYSIS_PROMPT_VERSION,
  ANALYSIS_SCHEMA,
  addFileTag,
  cleanAnalysisTags,
  isAnalysable,
  JobError,
  MAX_ANALYSIS_TAGS,
} from '../src/index.js';
import type { FileRecord } from '@assetforge/contracts';
import { jobFor, PROVIDER, rejectsWith, setup, UNKNOWN_ID } from './analysis-setup.js';
import { trashForTest } from './fakes.js';

describe('isAnalysable', () => {
  const complete: FileRecord = {
    id: '22222222-2222-4222-8222-222222222222',
    storageId: '33333333-3333-4333-8333-333333333333',
    assetId: null,
    role: null,
    originalName: 'a.png',
    relativePath: 'inbox/a.png',
    mimeType: 'image/png',
    sizeBytes: 3,
    sha256: 'a'.repeat(64),
    status: 'complete',
    error: null,
    importedAt: '2026-11-26T10:00:00.000Z',
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
  };

  it('is true for a complete previewable image and false once it is in the trash', () => {
    expect(isAnalysable(complete)).toBe(true);
    expect(
      isAnalysable({ ...complete, relativePath: '.assetforge/trash/a.png', openable: false, deletedAt: '2026-11-26T11:00:00.000Z' }),
    ).toBe(false);
  });
});

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

describe('the analyze file handler', () => {
  it('has the GPU class and is requeued when interrupted', async () => {
    const { handler } = await setup();
    expect(handler).toMatchObject({ resourceClass: 'local_gpu', onInterrupted: 'requeue' });
  });

  it('fails provider_not_configured without a provider or a model, before reading the image', async () => {
    const { db, file, vision, images, handler, configure } = await setup();
    configure({ vision: null, model: 'mock-vision' });
    await rejectsWith(handler.run(jobFor(file.id), new AbortController().signal), 'provider_not_configured');
    configure({ vision, model: null });
    await rejectsWith(handler.run(jobFor(file.id), new AbortController().signal), 'provider_not_configured');
    expect(images.calls).toEqual([]);
    expect(vision.calls).toEqual([]);
    expect(await db.analyses.get(file.id)).toBeNull();
  });

  it('writes the AI tags and the analysis record', async () => {
    const { db, file, vision, images, handler } = await setup();
    await handler.run(jobFor(file.id), new AbortController().signal);

    expect(images.calls).toEqual([`/memory/${file.relativePath}`]);
    expect(vision.calls).toEqual([{ image: new Uint8Array([0xff, 0xd8, 0xff]), prompt: ANALYSIS_PROMPT, schema: ANALYSIS_SCHEMA, model: 'mock-vision' }]);
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

describe('the analyze file handler with a v2 payload', () => {
  const apply = { version: 2, model: 'llava:13b', mode: 'apply' };
  const propose = { version: 2, model: 'llava:13b', mode: 'propose' };

  it('applies with the payload model, sent to the provider and written to the analysis record', async () => {
    const { db, file, vision, handler } = await setup();
    await handler.run(jobFor(file.id, apply), new AbortController().signal);
    expect(vision.calls.map((c) => c.model)).toEqual(['llava:13b']);
    expect(await db.analyses.get(file.id)).toMatchObject({ sha256: file.sha256, provider: PROVIDER, model: 'llava:13b', promptVersion: ANALYSIS_PROMPT_VERSION });
    expect(db.tags.forFile(file.id).map((t) => t.name)).toEqual(['front view', 'metal', 'photorealistic', 'red car']);
  });

  it('applies without a default model', async () => {
    const { db, file, vision, handler, configure } = await setup();
    configure({ vision, model: null });
    await handler.run(jobFor(file.id, apply), new AbortController().signal);
    expect(await db.analyses.get(file.id)).toMatchObject({ model: 'llava:13b' });
  });

  it('removes a waiting proposal when it applies', async () => {
    const { db, file, handler } = await setup();
    await handler.run(jobFor(file.id, propose), new AbortController().signal);
    await handler.run(jobFor(file.id, apply), new AbortController().signal);
    expect(await db.analyses.getProposal(file.id)).toBeNull();
  });

  it('stores a proposal and leaves the tags and the analysis record alone', async () => {
    const { db, session, file, vision, handler } = await setup();
    await addFileTag(session, { fileId: file.id, name: 'mine' });
    await handler.run(jobFor(file.id, propose), new AbortController().signal);
    expect(vision.calls.map((c) => c.model)).toEqual(['llava:13b']);
    expect(await db.analyses.getProposal(file.id)).toEqual({
      fileId: file.id,
      sha256: file.sha256,
      provider: PROVIDER,
      model: 'llava:13b',
      promptVersion: ANALYSIS_PROMPT_VERSION,
      tags: [
        { name: 'red car', displayName: 'Red Car' },
        { name: 'metal', displayName: 'metal' },
        { name: 'front view', displayName: 'front view' },
        { name: 'photorealistic', displayName: 'photorealistic' },
      ],
      createdAt: expect.any(String),
      stale: false,
    });
    expect(db.tags.forFile(file.id)).toEqual([{ name: 'mine', displayName: 'mine', origin: 'manual' }]);
    expect(await db.analyses.get(file.id)).toBeNull();
  });

  it('fails file_unavailable when the proposal cannot be stored', async () => {
    const { db, file, vision, handler } = await setup();
    vision.respond = async () => {
      db.files.records.set(file.id, { ...db.files.records.get(file.id)!, sha256: 'f'.repeat(64) });
      return { tags: ['car'] };
    };
    await rejectsWith(handler.run(jobFor(file.id, propose), new AbortController().signal), 'file_unavailable');
    expect(await db.analyses.getProposal(file.id)).toBeNull();
  });

  it('fails invalid_response for zero clean tags in either mode', async () => {
    for (const payload of [apply, propose]) {
      const { db, file, vision, handler } = await setup();
      vision.answer = { tags: ['', 7] };
      await rejectsWith(handler.run(jobFor(file.id, payload), new AbortController().signal), 'invalid_response');
      expect(await db.analyses.getProposal(file.id)).toBeNull();
      expect(await db.analyses.get(file.id)).toBeNull();
    }
  });

  it('fails provider_not_configured without a provider, before reading the image', async () => {
    const { file, images, handler, configure } = await setup();
    configure({ vision: null, model: 'mock-vision' });
    await rejectsWith(handler.run(jobFor(file.id, apply), new AbortController().signal), 'provider_not_configured');
    expect(images.calls).toEqual([]);
  });
});

describe('trashed files in the handler', () => {
  for (const mode of ['apply', 'propose'] as const) {
    it(`a job whose file was trashed after the image was read ends file_unavailable and writes nothing (${mode})`, async () => {
      const { db, session, file, vision, handler } = await setup();
      vision.respond = async () => {
        await trashForTest(session, [file.id]);
        return { tags: ['car'] };
      };
      await rejectsWith(handler.run(jobFor(file.id, { version: 2, model: 'mock-vision', mode }), new AbortController().signal), 'file_unavailable');
      expect(db.tags.forFile(file.id)).toEqual([]);
      expect(await db.analyses.get(file.id)).toBeNull();
      expect(await db.analyses.getProposal(file.id)).toBeNull();
    });
  }

  it('a job started for an already trashed file ends file_unavailable', async () => {
    const { session, file, vision, images, handler } = await setup();
    await trashForTest(session, [file.id]);
    await rejectsWith(handler.run(jobFor(file.id), new AbortController().signal), 'file_unavailable');
    expect(images.calls).toEqual([]);
    expect(vision.calls).toEqual([]);
  });
});
