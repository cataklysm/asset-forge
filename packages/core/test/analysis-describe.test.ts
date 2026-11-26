import { describe, expect, it } from 'vitest';
import { describeImage, IMAGE_PROMPT, MAX_PROMPT_TEXT } from '../src/index.js';
import { rejectsWith, setup, UNKNOWN_ID, type Setup } from './analysis-setup.js';

const MODEL = 'llava:13b';

function describeWith(c: Setup, fileId: string, signal = new AbortController().signal, prompt = IMAGE_PROMPT) {
  return describeImage({ session: c.session, vision: () => c.vision, images: c.images }, { fileId, model: MODEL, prompt, signal });
}

/** Nothing was written: no job, analysis, proposal or tag. */
function expectNoWrites(c: Setup): void {
  expect(c.db.jobs.rows).toEqual([]);
  expect(c.db.analyses.rows.size).toBe(0);
  expect(c.db.analyses.proposals.size).toBe(0);
  expect(c.db.tags.fileAssignments).toEqual([]);
}

describe('describeImage', () => {
  it('sends the JPEG with the image prompt and the model and returns the trimmed text', async () => {
    const c = await setup();
    expect(await describeWith(c, c.file.id)).toBe('A red sports car seen from the front.');
    expect(c.images.calls).toEqual([`/memory/${c.file.relativePath}`]);
    expect(c.vision.describeCalls).toEqual([{ image: new Uint8Array([0xff, 0xd8, 0xff]), prompt: IMAGE_PROMPT, model: MODEL }]);
    expectNoWrites(c);
  });

  it('sends exactly the prompt it is given', async () => {
    const c = await setup();
    const prompt = '  Describe only the armour.\n\nNothing else.  ';
    await describeWith(c, c.file.id, new AbortController().signal, prompt);
    expect(c.vision.describeCalls.map((call) => call.prompt)).toEqual([prompt]);
  });

  it('cuts the text at 4000 characters', async () => {
    const c = await setup();
    c.vision.description = `  ${'a'.repeat(5000)}`;
    expect(MAX_PROMPT_TEXT).toBe(4000);
    expect(await describeWith(c, c.file.id)).toBe('a'.repeat(4000));
  });

  it('fails invalid_response for an empty text', async () => {
    const c = await setup();
    c.vision.description = ' \n\t ';
    await rejectsWith(describeWith(c, c.file.id), 'invalid_response');
    expectNoWrites(c);
  });

  it('fails file_unavailable for a file that cannot be analysed, without asking the provider', async () => {
    const c = await setup();
    const blend = await c.importOne('scene.blend');
    await rejectsWith(describeWith(c, blend.id), 'file_unavailable');
    await rejectsWith(describeWith(c, UNKNOWN_ID), 'file_unavailable');
    c.images.script = [null];
    await rejectsWith(describeWith(c, c.file.id), 'file_unavailable');
    expect(c.vision.describeCalls).toEqual([]);
    expectNoWrites(c);
  });

  it('fails provider_not_configured without a provider', async () => {
    const c = await setup();
    const result = describeImage({ session: c.session, vision: () => null, images: c.images }, { fileId: c.file.id, model: MODEL, prompt: IMAGE_PROMPT, signal: new AbortController().signal });
    await rejectsWith(result, 'provider_not_configured');
    expect(c.images.calls).toEqual([]);
  });

  it('rethrows the reason of an aborted signal', async () => {
    const c = await setup();
    const controller = new AbortController();
    const reason = new Error('cancelled');
    c.vision.describe = async () => {
      controller.abort(reason);
      return 'text';
    };
    await expect(describeWith(c, c.file.id, controller.signal)).rejects.toBe(reason);

    const before = new AbortController();
    before.abort(reason);
    await expect(describeWith(c, c.file.id, before.signal)).rejects.toBe(reason);
    expect(c.vision.describeCalls).toHaveLength(1);
    expectNoWrites(c);
  });

  it('describes the image prompt as one English paragraph', () => {
    expect(IMAGE_PROMPT).not.toContain('\n');
    for (const word of ['subject', 'materials', 'colours', 'lighting', 'view', 'style']) expect(IMAGE_PROMPT).toContain(word);
  });
});
