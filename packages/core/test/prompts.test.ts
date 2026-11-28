import { describe, expect, it } from 'vitest';
import {
  addPromptTag,
  createPrompt,
  deletePrompt,
  getPrompt,
  listPrompts,
  promptTitleKey,
  removePromptTag,
  savePromptVersion,
  updatePrompt,
  WorkspaceManager,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

/** A session on the memory database whose clock moves one second per call. */
async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  await manager.create({ name: 'Demo', rootPath: ROOT });
  const base: WorkspaceSession = await manager.read(async (s) => s);
  let tick = Date.parse('2026-01-01T00:00:00.000Z');
  const session: WorkspaceSession = {
    summary: base.summary,
    storage: base.storage,
    storageId: base.storageId,
    database: base.database,
    imageProbe: base.imageProbe,
    videoProbe: base.videoProbe,
    newId: () => base.newId(),
    now: () => new Date((tick += 1000)),
  };
  return { session };
}

const input = (
  over: Partial<{ title: string; description: string; content: string; defaults: Record<string, string> }> = {},
) => ({
  title: 'Hero',
  description: '',
  content: 'A {{subject}} in {{place}}',
  defaults: {},
  ...over,
});

const vars = (n: number) => Array.from({ length: n }, (_, i) => `{{v${i}}}`).join(' ');

async function rejects(p: Promise<unknown>, code: string, message: string) {
  await expect(p).rejects.toMatchObject({ code, message });
}

describe('createPrompt', () => {
  it('stores version 1 with the variables built from the content and the defaults', async () => {
    const { session } = await setup();
    const detail = await createPrompt(
      session,
      input({
        title: '  Hero  ',
        description: ' Shot ',
        content: '  A {{subject}} in {{Place}} by {{subject}}  ',
        defaults: { place: 'the woods', unused: 'x' },
      }),
    );
    expect(detail).toMatchObject({ title: 'Hero', description: 'Shot', tags: [] });
    expect(detail.currentVersion).toMatchObject({
      number: 1,
      content: 'A {{subject}} in {{Place}} by {{subject}}',
      variables: [
        { name: 'subject', defaultValue: '' },
        { name: 'Place', defaultValue: 'the woods' },
      ],
    });
    expect(detail.versions).toHaveLength(1);
    expect(await getPrompt(session, detail.id)).toEqual(detail);
  });

  it('answers the fixed messages for title, text, length and variables', async () => {
    const { session } = await setup();
    await rejects(createPrompt(session, input({ title: '   ' })), 'validation_failed', 'A prompt needs a title');
    await rejects(createPrompt(session, input({ content: ' \n ' })), 'validation_failed', 'A prompt needs a text');
    await rejects(
      createPrompt(session, input({ title: 'x'.repeat(121) })),
      'validation_failed',
      'This text is too long',
    );
    await rejects(
      createPrompt(session, input({ description: 'x'.repeat(2001) })),
      'validation_failed',
      'This text is too long',
    );
    await rejects(
      createPrompt(session, input({ content: 'x'.repeat(8001) })),
      'validation_failed',
      'This text is too long',
    );
    await rejects(
      createPrompt(session, input({ defaults: { subject: 'x'.repeat(2001) } })),
      'validation_failed',
      'This text is too long',
    );
    await rejects(
      createPrompt(session, input({ content: vars(21) })),
      'validation_failed',
      'A prompt can have at most 20 variables',
    );
  });

  it('accepts exactly 20 variables and the length limits themselves', async () => {
    const { session } = await setup();
    const detail = await createPrompt(session, input({ content: vars(20) }));
    expect(detail.currentVersion.variables).toHaveLength(20);
    await createPrompt(
      session,
      input({ title: 't'.repeat(120), description: 'd'.repeat(2000), content: 'c'.repeat(8000) }),
    );
  });

  it('refuses a title another prompt holds in any case', async () => {
    const { session } = await setup();
    await createPrompt(session, input({ title: ' Hero ' }));
    await rejects(createPrompt(session, input({ title: 'hero' })), 'validation_failed', 'This title is already used');
    expect(promptTitleKey('  HeRo ')).toBe('hero');
  });
});

describe('updatePrompt', () => {
  it('accepts its own title in another case and refuses another prompt’s title', async () => {
    const { session } = await setup();
    const hero = await createPrompt(session, input({ title: 'Hero' }));
    await createPrompt(session, input({ title: 'Villain' }));
    const renamed = await updatePrompt(session, { promptId: hero.id, title: ' HERO ', description: ' new ' });
    expect(renamed).toMatchObject({ title: 'HERO', description: 'new' });
    expect(renamed.updatedAt > hero.updatedAt).toBe(true);
    await rejects(
      updatePrompt(session, { promptId: hero.id, title: 'villain', description: '' }),
      'validation_failed',
      'This title is already used',
    );
    await rejects(
      updatePrompt(session, { promptId: hero.id, title: ' ', description: '' }),
      'validation_failed',
      'A prompt needs a title',
    );
  });

  it('answers not_found for an unknown prompt', async () => {
    const { session } = await setup();
    await rejects(
      updatePrompt(session, { promptId: UNKNOWN_ID, title: 'X', description: '' }),
      'not_found',
      'This prompt does not exist',
    );
    await rejects(getPrompt(session, UNKNOWN_ID), 'not_found', 'This prompt does not exist');
  });
});

describe('savePromptVersion', () => {
  it('adds version 2 for changed content and moves updatedAt', async () => {
    const { session } = await setup();
    const first = await createPrompt(session, input());
    const saved = await savePromptVersion(session, {
      promptId: first.id,
      baseVersionId: first.currentVersion.id,
      content: 'A {{subject}} at night',
      defaults: {},
    });
    expect(saved.currentVersion).toMatchObject({ number: 2, content: 'A {{subject}} at night' });
    expect(saved.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(saved.updatedAt > first.updatedAt).toBe(true);
  });

  it('writes nothing for the same content with surrounding spaces and the same defaults', async () => {
    const { session } = await setup();
    const first = await createPrompt(session, input({ defaults: { subject: 'cat' } }));
    const same = await savePromptVersion(session, {
      promptId: first.id,
      baseVersionId: first.currentVersion.id,
      content: `  ${first.currentVersion.content}\n`,
      defaults: { SUBJECT: 'cat' },
    });
    expect(same).toEqual(first);
  });

  it('adds a version when only a default changed', async () => {
    const { session } = await setup();
    const first = await createPrompt(session, input());
    const saved = await savePromptVersion(session, {
      promptId: first.id,
      baseVersionId: first.currentVersion.id,
      content: first.currentVersion.content,
      defaults: { place: 'Rome' },
    });
    expect(saved.currentVersion.number).toBe(2);
    expect(saved.currentVersion.variables).toEqual([
      { name: 'subject', defaultValue: '' },
      { name: 'place', defaultValue: 'Rome' },
    ]);
  });

  it('drops a default for a variable no longer in the text, which alone causes no version', async () => {
    const { session } = await setup();
    const first = await createPrompt(session, input());
    const same = await savePromptVersion(session, {
      promptId: first.id,
      baseVersionId: first.currentVersion.id,
      content: first.currentVersion.content,
      defaults: { gone: 'value' },
    });
    expect(same).toEqual(first);
    expect(same.currentVersion.variables.map((v) => v.name)).toEqual(['subject', 'place']);
  });

  it('refuses a base that is not the current version', async () => {
    const { session } = await setup();
    const first = await createPrompt(session, input());
    await savePromptVersion(session, {
      promptId: first.id,
      baseVersionId: first.currentVersion.id,
      content: 'Second',
      defaults: {},
    });
    await rejects(
      savePromptVersion(session, {
        promptId: first.id,
        baseVersionId: first.currentVersion.id,
        content: 'Third',
        defaults: {},
      }),
      'invalid_operation',
      'This prompt was changed in the meantime',
    );
    await rejects(
      savePromptVersion(session, {
        promptId: UNKNOWN_ID,
        baseVersionId: first.currentVersion.id,
        content: 'X',
        defaults: {},
      }),
      'not_found',
      'This prompt does not exist',
    );
    expect((await getPrompt(session, first.id)).versions).toHaveLength(2);
  });

  it('checks the new content like create', async () => {
    const { session } = await setup();
    const first = await createPrompt(session, input());
    const save = (content: string) =>
      savePromptVersion(session, { promptId: first.id, baseVersionId: first.currentVersion.id, content, defaults: {} });
    await rejects(save('  '), 'validation_failed', 'A prompt needs a text');
    await rejects(save(vars(21)), 'validation_failed', 'A prompt can have at most 20 variables');
  });
});

describe('prompt tags', () => {
  it('adds a tag once, refuses an invalid name and the 51st tag, and removes a missing tag as a no-op', async () => {
    const { session } = await setup();
    const prompt = await createPrompt(session, input());
    await addPromptTag(session, { promptId: prompt.id, name: ' Dark  Forest ' });
    const twice = await addPromptTag(session, { promptId: prompt.id, name: 'dark forest' });
    expect(twice.tags).toEqual([{ name: 'dark forest', displayName: 'Dark Forest', origin: 'manual' }]);

    await rejects(
      addPromptTag(session, { promptId: prompt.id, name: '!!!' }),
      'validation_failed',
      'A tag needs a letter or digit and at most 64 characters',
    );
    await rejects(
      addPromptTag(session, { promptId: UNKNOWN_ID, name: 'x' }),
      'not_found',
      'This prompt does not exist',
    );

    for (let i = 1; i < 50; i++) await addPromptTag(session, { promptId: prompt.id, name: `tag ${i}` });
    expect((await getPrompt(session, prompt.id)).tags).toHaveLength(50);
    await rejects(
      addPromptTag(session, { promptId: prompt.id, name: 'one more' }),
      'validation_failed',
      'This prompt cannot take more tags',
    );

    const before = await getPrompt(session, prompt.id);
    expect(await removePromptTag(session, { promptId: prompt.id, name: 'not there' })).toEqual(before);
    const removed = await removePromptTag(session, { promptId: prompt.id, name: 'DARK FOREST' });
    expect(removed.tags.some((t) => t.name === 'dark forest')).toBe(false);
    await rejects(
      removePromptTag(session, { promptId: UNKNOWN_ID, name: 'x' }),
      'not_found',
      'This prompt does not exist',
    );
  });
});

describe('listPrompts', () => {
  it('folds the query words and normalises the tag names', async () => {
    const { session } = await setup();
    const forest = await createPrompt(session, input({ title: 'Über Kopf', content: 'A forest at 100% light' }));
    await createPrompt(session, input({ title: 'Plain', content: 'A field' }));
    await addPromptTag(session, { promptId: forest.id, name: 'Night' });

    const page = { offset: 0, limit: 10 };
    const titles = async (q: { query?: string; tagNames?: string[] }) =>
      (await listPrompts(session, { ...page, ...q })).items.map((p) => p.title);
    expect(await titles({})).toEqual(['Über Kopf', 'Plain']);
    expect(await titles({ query: '  UBER   forest ' })).toEqual(['Über Kopf']);
    expect(await titles({ query: '100%' })).toEqual(['Über Kopf']);
    expect(await titles({ query: '   ' })).toEqual(['Über Kopf', 'Plain']);
    expect(await titles({ tagNames: [' NIGHT '] })).toEqual(['Über Kopf']);
    expect(await listPrompts(session, { ...page, tagNames: ['!!!'] })).toEqual({ items: [], total: 0 });
  });
});

describe('deletePrompt', () => {
  it('deletes the prompt and answers not_found the second time', async () => {
    const { session } = await setup();
    const prompt = await createPrompt(session, input());
    await deletePrompt(session, prompt.id);
    await rejects(getPrompt(session, prompt.id), 'not_found', 'This prompt does not exist');
    await rejects(deletePrompt(session, prompt.id), 'not_found', 'This prompt does not exist');
  });
});
