import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_PROMPT,
  ANALYSIS_PROMPT_VERSION,
  ANALYSIS_FORMAT_LINE,
  ANALYSIS_SCHEMA,
  addFileTag,
  builtInAnalysisPrompt,
  cleanAnalysisTags,
  composeTaggingRequest,
  IMAGE_PROMPT,
  isAnalysable,
  JobError,
  LEGACY_TAG_LIMIT,
  MAX_ANALYSIS_TAGS,
} from '../src/index.js';
import type { FileRecord } from '@assetforge/contracts';
import { jobFor, LEGACY_V4, PROVIDER, rejectsWith, setup, UNKNOWN_ID } from './analysis-setup.js';
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
    thumbnail: true,
    openable: true,
    kind: 'image',
    width: null,
    height: null,
    durationMs: null,
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
      isAnalysable({
        ...complete,
        relativePath: '.assetforge/trash/a.png',
        openable: false,
        deletedAt: '2026-11-26T11:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('is false for a video', () => {
    for (const mimeType of ['video/mp4', 'video/webm']) {
      expect(
        isAnalysable({
          ...complete,
          originalName: 'a.mp4',
          relativePath: 'inbox/a.mp4',
          mimeType,
          kind: 'video',
          previewable: false,
          thumbnail: true,
        }),
      ).toBe(false);
    }
  });
});

describe('cleanAnalysisTags', () => {
  it('drops non-strings, invalid and duplicate tags', () => {
    expect(
      cleanAnalysisTags({ tags: ['Red  Car', 'red car', 7, '', 'x'.repeat(200), null] }, LEGACY_TAG_LIMIT),
    ).toEqual([{ name: 'red car', displayName: 'Red Car' }]);
  });

  it('keeps the first distinct tags up to the limit', () => {
    const tags = Array.from({ length: 500 }, (_, i) => `tag ${i}`);
    const cleaned = cleanAnalysisTags({ tags }, LEGACY_TAG_LIMIT);
    expect(LEGACY_TAG_LIMIT).toBe(20);
    expect(cleaned.map((t) => t.name)).toEqual(tags.slice(0, 20));
  });

  it('counts the limit after dropping repeats and unusable entries', () => {
    expect(cleanAnalysisTags({ tags: ['a', 'A', 'b', '', 3, 'c'] }, 2)).toEqual([
      { name: 'a', displayName: 'a' },
      { name: 'b', displayName: 'b' },
    ]);
    expect(cleanAnalysisTags({ tags: ['a', 'A', 'b', '', 3, 'c'] }, 1)).toEqual([{ name: 'a', displayName: 'a' }]);
  });

  it('keeps 50 of 60 distinct tags at the upper bound', () => {
    const tags = Array.from({ length: 60 }, (_, i) => `tag ${i}`);
    expect(MAX_ANALYSIS_TAGS).toBe(50);
    expect(cleanAnalysisTags({ tags }, MAX_ANALYSIS_TAGS)).toHaveLength(50);
  });

  it('yields nothing for answers of another shape', () => {
    for (const answer of [
      {},
      'text',
      { tags: 'a' },
      null,
      undefined,
      42,
      ['a', 'b'],
      { tags: { 0: 'a' } },
      { tags: [[], {}, 1] },
    ]) {
      expect(cleanAnalysisTags(answer, LEGACY_TAG_LIMIT)).toEqual([]);
    }
  });
});

describe('composeTaggingRequest', () => {
  it('appends the limit line and the format line to the text', () => {
    expect(composeTaggingRequest({ text: 'Look at the armour.', maxTags: 25 })).toBe(
      'Look at the armour.\nGive at most 25 tags.\n' + ANALYSIS_FORMAT_LINE,
    );
    expect(ANALYSIS_FORMAT_LINE).toBe('Answer only with JSON of the form {"tags": ["...", "..."]}.');
  });
});

describe('builtInAnalysisPrompt', () => {
  it('has a tagging text with 15 tags and neither a format nor a count', () => {
    const tagging = builtInAnalysisPrompt('tagging');
    expect(tagging.maxTags).toBe(15);
    expect(tagging.text).not.toContain('JSON');
    expect(tagging.text).not.toMatch(/\d tags/);
    expect(tagging.text).toBe(
      [
        'Describe this image with short tags in English, all in lower case.',
        'Cover what is shown, the materials and the dominant colours.',
        'Include exactly one view tag, for example "front view", "side view", "three-quarter view", "top view" or "close-up".',
        'Include exactly one style tag, for example "photorealistic", "stylized", "concept art", "line drawing" or "pixel art".',
      ].join('\n'),
    );
  });

  it('returns the image prompt without a tag limit', () => {
    expect(builtInAnalysisPrompt('image_prompt')).toEqual({ text: IMAGE_PROMPT, maxTags: null });
  });

  it('leaves the legacy prompt of v1 and v2 jobs unchanged', () => {
    expect(ANALYSIS_PROMPT).toBe(
      [
        'Describe this image with 8 to 15 short tags in English, all in lower case.',
        'Cover what is shown, the materials and the dominant colours.',
        'Include exactly one view tag, for example "front view", "side view", "three-quarter view", "top view" or "close-up".',
        'Include exactly one style tag, for example "photorealistic", "stylized", "concept art", "line drawing" or "pixel art".',
        'Answer only with JSON of the form {"tags": ["...", "..."]}.',
      ].join('\n'),
    );
  });
});

describe('the analyze file handler', () => {
  it('has the GPU class and is requeued when interrupted', async () => {
    const { handler } = await setup();
    expect(handler).toMatchObject({ resourceClass: 'local_gpu', onInterrupted: 'requeue' });
  });

  it('asks for the provider of the job lane', async () => {
    const { file, handler, lanes } = await setup();
    await handler.run(jobFor(file.id, LEGACY_V4, 'lane-b'), new AbortController().signal);
    await handler.run(jobFor(file.id, LEGACY_V4, null), new AbortController().signal);
    expect(lanes).toEqual(['lane-b', null]);
  });

  it('fails provider_not_configured when the lane has no provider, before reading the image', async () => {
    const { db, file, vision, images, handler, configure, lanes } = await setup();
    configure({ vision: null });
    await rejectsWith(
      handler.run(jobFor(file.id, LEGACY_V4, 'x'), new AbortController().signal),
      'provider_not_configured',
    );
    expect(lanes).toEqual(['x']);
    expect(images.calls).toEqual([]);
    expect(vision.calls).toEqual([]);
    expect(await db.analyses.get(file.id)).toBeNull();
    expect(await db.analyses.getProposal(file.id)).toBeNull();
  });

  it('fails provider_not_configured when the lane has no fingerprint provider id, before reading the image', async () => {
    const { db, file, vision, images, handler, configure, providerLanes } = await setup();
    configure({ vision, provider: null });
    await rejectsWith(
      handler.run(jobFor(file.id, LEGACY_V4, 'x'), new AbortController().signal),
      'provider_not_configured',
    );
    expect(providerLanes).toEqual(['x']);
    expect(images.calls).toEqual([]);
    expect(vision.calls).toEqual([]);
    expect(await db.analyses.get(file.id)).toBeNull();
  });

  it('writes the fingerprint with the provider id of the job lane', async () => {
    const { db, file, vision, handler, configure, providerLanes } = await setup();
    configure({ vision, provider: 'openai' });
    await handler.run(jobFor(file.id, LEGACY_V4, 'lane-b'), new AbortController().signal);
    expect(providerLanes).toEqual(['lane-b']);
    expect(await db.analyses.get(file.id)).toMatchObject({ provider: 'openai', model: 'mock-vision' });
  });

  it('fails provider_not_configured for a v1 payload without asking the provider', async () => {
    const { db, file, vision, images, handler } = await setup();
    await rejectsWith(
      handler.run(jobFor(file.id, { version: 1 }), new AbortController().signal),
      'provider_not_configured',
    );
    expect(images.calls).toEqual([]);
    expect(vision.calls).toEqual([]);
    expect(await db.analyses.get(file.id)).toBeNull();
  });

  it('writes the AI tags and the analysis record', async () => {
    const { db, file, vision, images, handler } = await setup();
    await handler.run(jobFor(file.id), new AbortController().signal);

    expect(images.calls).toEqual([`/memory/${file.relativePath}`]);
    expect(vision.calls).toEqual([
      {
        image: new Uint8Array([0xff, 0xd8, 0xff]),
        prompt: ANALYSIS_PROMPT,
        schema: ANALYSIS_SCHEMA,
        model: 'mock-vision',
      },
    ]);
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
    await rejectsWith(
      unchanged.handler.run(jobFor(unchanged.file.id), new AbortController().signal),
      'file_unavailable',
    );
    expect(unchanged.images.calls).toHaveLength(1);
    expect(unchanged.vision.calls).toEqual([]);

    const moved = await setup();
    moved.images.script = [
      () => {
        moved.db.files.records.set(moved.file.id, {
          ...moved.db.files.records.get(moved.file.id)!,
          relativePath: 'assets/x/car.png',
        });
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
    expect(await db.analyses.get(file.id)).toMatchObject({
      sha256: file.sha256,
      provider: PROVIDER,
      model: 'llava:13b',
      promptVersion: ANALYSIS_PROMPT_VERSION,
    });
    expect(db.tags.forFile(file.id).map((t) => t.name)).toEqual(['front view', 'metal', 'photorealistic', 'red car']);
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
      promptName: null,
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
    configure({ vision: null });
    await rejectsWith(handler.run(jobFor(file.id, apply), new AbortController().signal), 'provider_not_configured');
    expect(images.calls).toEqual([]);
  });
});

describe('the analyze file handler with a v3 payload', () => {
  const prompt = { name: 'Detail', text: 'Look at the armour.', maxTags: 3 };
  const ten = Array.from({ length: 10 }, (_, i) => `tag ${i}`);

  it('sends the composed request, applies at most maxTags tags and records the prompt name', async () => {
    const { db, file, vision, handler } = await setup();
    vision.answer = { tags: ten };
    await handler.run(
      jobFor(file.id, { version: 3, model: 'llava:13b', mode: 'apply', prompt }),
      new AbortController().signal,
    );
    expect(vision.calls).toHaveLength(1);
    expect(vision.calls[0]!.prompt).toBe(composeTaggingRequest(prompt));
    expect(vision.calls[0]!.prompt.endsWith('Give at most 3 tags.\n' + ANALYSIS_FORMAT_LINE)).toBe(true);
    expect(vision.calls[0]!.schema).toBe(ANALYSIS_SCHEMA);
    expect(vision.calls[0]!.model).toBe('llava:13b');
    expect(
      db.tags
        .forFile(file.id)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['tag 0', 'tag 1', 'tag 2']);
    expect(await db.analyses.get(file.id)).toMatchObject({
      model: 'llava:13b',
      promptVersion: ANALYSIS_PROMPT_VERSION,
      promptName: 'Detail',
    });
  });

  it('stores a proposal of at most maxTags tags with the prompt name', async () => {
    const { db, file, vision, handler } = await setup();
    vision.answer = { tags: ten };
    await handler.run(
      jobFor(file.id, { version: 3, model: 'llava:13b', mode: 'propose', prompt }),
      new AbortController().signal,
    );
    expect(await db.analyses.getProposal(file.id)).toMatchObject({
      promptName: 'Detail',
      tags: [
        { name: 'tag 0', displayName: 'tag 0' },
        { name: 'tag 1', displayName: 'tag 1' },
        { name: 'tag 2', displayName: 'tag 2' },
      ],
    });
    expect(await db.analyses.get(file.id)).toBeNull();
  });
});

describe('legacy payloads in the handler', () => {
  const thirty = Array.from({ length: 30 }, (_, i) => `tag ${i}`);

  it('a v2 job sends the legacy prompt, keeps 20 of 30 tags and records no prompt name', async () => {
    const { db, file, vision, handler } = await setup();
    vision.answer = { tags: thirty };
    await handler.run(jobFor(file.id, { version: 2, model: 'llava:13b', mode: 'apply' }), new AbortController().signal);
    expect(vision.calls[0]!.prompt).toBe(ANALYSIS_PROMPT);
    expect(db.tags.forFile(file.id)).toHaveLength(20);
    expect(await db.analyses.get(file.id)).toMatchObject({ model: 'llava:13b', promptName: null });
  });

  it('a v2 proposal keeps 20 of 30 tags and records no prompt name', async () => {
    const { db, file, vision, handler } = await setup();
    vision.answer = { tags: thirty };
    await handler.run(
      jobFor(file.id, { version: 2, model: 'llava:13b', mode: 'propose' }),
      new AbortController().signal,
    );
    const proposal = await db.analyses.getProposal(file.id);
    expect(proposal?.tags).toHaveLength(20);
    expect(proposal?.promptName).toBeNull();
  });

  it('a v4 job without a prompt sends the legacy prompt, keeps 20 of 30 tags and records no prompt name', async () => {
    const { db, file, vision, handler } = await setup();
    vision.answer = { tags: thirty };
    await handler.run(jobFor(file.id, { ...LEGACY_V4, model: 'llava:13b' }), new AbortController().signal);
    expect(vision.calls[0]).toMatchObject({ prompt: ANALYSIS_PROMPT, schema: ANALYSIS_SCHEMA, model: 'llava:13b' });
    expect(db.tags.forFile(file.id)).toHaveLength(20);
    expect(await db.analyses.get(file.id)).toMatchObject({ provider: PROVIDER, model: 'llava:13b', promptName: null });
  });
});

describe('the analyze file handler with a v4 payload', () => {
  const prompt = { name: 'Detail', text: 'Look at the armour.', maxTags: 3 };
  const ten = Array.from({ length: 10 }, (_, i) => `tag ${i}`);

  it('sends the composed request, cuts at maxTags and records the prompt name', async () => {
    const { db, file, vision, handler } = await setup();
    vision.answer = { tags: ten };
    const payload = { version: 4, model: 'llava:13b', mode: 'apply', prompt, providerName: 'RunPod' };
    await handler.run(jobFor(file.id, payload), new AbortController().signal);
    expect(vision.calls[0]).toMatchObject({ prompt: composeTaggingRequest(prompt), model: 'llava:13b' });
    expect(
      db.tags
        .forFile(file.id)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['tag 0', 'tag 1', 'tag 2']);
    expect(await db.analyses.get(file.id)).toMatchObject({
      provider: PROVIDER,
      model: 'llava:13b',
      promptName: 'Detail',
    });
  });

  it('stores a proposal of at most maxTags tags with the prompt name', async () => {
    const { db, file, vision, handler } = await setup();
    vision.answer = { tags: ten };
    const payload = { version: 4, model: 'llava:13b', mode: 'propose', prompt, providerName: 'RunPod' };
    await handler.run(jobFor(file.id, payload), new AbortController().signal);
    expect(await db.analyses.getProposal(file.id)).toMatchObject({ promptName: 'Detail', model: 'llava:13b' });
    expect((await db.analyses.getProposal(file.id))?.tags).toHaveLength(3);
    expect(await db.analyses.get(file.id)).toBeNull();
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
      await rejectsWith(
        handler.run(jobFor(file.id, { version: 2, model: 'mock-vision', mode }), new AbortController().signal),
        'file_unavailable',
      );
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

describe('the effects of the analyze file handler', () => {
  for (const mode of ['apply', 'propose'] as const) {
    it(`reports the file once it stored the result (${mode})`, async () => {
      const { file, handler, effects } = await setup();
      await handler.run(jobFor(file.id, { version: 2, model: 'mock-vision', mode }), new AbortController().signal);
      expect(effects.changed).toEqual([file.id]);
      expect(effects.added).toEqual([]);
    });
  }

  it('reports nothing when it failed or the file was trashed', async () => {
    const failed = await setup();
    failed.vision.answer = { tags: [] };
    await rejectsWith(failed.handler.run(jobFor(failed.file.id), new AbortController().signal), 'invalid_response');
    expect(failed.effects.changed).toEqual([]);

    const trashed = await setup();
    trashed.vision.respond = async () => {
      await trashForTest(trashed.session, [trashed.file.id]);
      return { tags: ['car'] };
    };
    await rejectsWith(trashed.handler.run(jobFor(trashed.file.id), new AbortController().signal), 'file_unavailable');
    expect(trashed.effects.changed).toEqual([]);
  });

  it('still succeeds when the report throws', async () => {
    const { db, file, handler, effects } = await setup();
    effects.throwing = true;
    await handler.run(jobFor(file.id), new AbortController().signal);
    expect(effects.changed).toEqual([file.id]);
    expect(await db.analyses.get(file.id)).not.toBeNull();
  });
});
