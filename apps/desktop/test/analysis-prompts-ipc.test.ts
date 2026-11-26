import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './analysis-harness.js';

const UNKNOWN = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('analysis prompt IPC', () => {
  it('lists, saves, resets and deletes without an open workspace', async () => {
    h = await createHarness();
    expect(await h.ok('workspace:current', {})).toBeNull();
    const listed = await h.ok('analysisPrompts:list', {});
    expect(listed.prompts.map((p) => [p.purpose, p.name])).toEqual([
      ['tagging', 'Default'],
      ['image_prompt', 'Default'],
    ]);
    expect(listed.lastUsed).toEqual({ tagging: null, imagePrompt: null });

    const saved = await h.ok('analysisPrompts:save', { purpose: 'tagging', name: 'Mine', text: 'My text', maxTags: 7 });
    expect(saved).toEqual({ id: expect.any(String), purpose: 'tagging', name: 'Mine', text: 'My text', maxTags: 7 });
    const reset = await h.ok('analysisPrompts:reset', { id: saved.id });
    expect(reset).toMatchObject({ id: saved.id, name: 'Mine', maxTags: 15 });
    expect(reset.text).not.toBe('My text');
    expect(await h.ok('analysisPrompts:delete', { id: saved.id })).toEqual({});
    expect((await h.ok('analysisPrompts:list', {})).prompts).toEqual(listed.prompts);
  });

  it('rejects a too long name in the request, a duplicate name and an unknown id', async () => {
    h = await createHarness();
    expect(
      await h.call('analysisPrompts:save', { purpose: 'image_prompt', name: 'n'.repeat(61), text: 't' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await h.call('analysisPrompts:save', { purpose: 'image_prompt', name: ' default ', text: 't' })).toEqual({
      ok: false,
      error: { code: 'invalid_operation', message: 'An analysis prompt with this name already exists' },
    });
    expect(await h.call('analysisPrompts:delete', { id: UNKNOWN })).toMatchObject({
      ok: false,
      error: { code: 'not_found', message: 'The analysis prompt does not exist' },
    });
  });
});
