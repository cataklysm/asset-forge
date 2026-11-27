import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PromptVariable } from '@assetforge/contracts';
import type { WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const T0 = '2026-11-27T10:00:00.000Z';
const T1 = '2026-11-27T10:00:01.000Z';
const T2 = '2026-11-27T10:00:02.000Z';
const T3 = '2026-11-27T10:00:03.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;
let db: WorkspaceDatabase;
let handle: Database.Database;
let nextTagId = 5000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-prompts-'));
  // Captures the connection that openWorkspaceDatabase creates (it calls `pragma` on it first).
  const pragma = vi.spyOn(Database.prototype, 'pragma');
  try {
    db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
    handle = pragma.mock.contexts[0] as Database.Database;
  } finally {
    pragma.mockRestore();
  }
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Prompt n has version 1 with id uuid(n + 100). */
const create = (
  n: number,
  title: string,
  o: { description?: string; content?: string; variables?: PromptVariable[]; now?: string } = {},
) =>
  db.prompts.create({
    id: uuid(n),
    title,
    titleKey: title.toLowerCase(),
    description: o.description ?? '',
    version: { id: uuid(n + 100), content: o.content ?? `Text of ${title}`, variables: o.variables ?? [] },
    now: o.now ?? T0,
  });

const addVersion = (promptId: string, baseVersionId: string, versionId: string, content: string, now = T1) =>
  db.prompts.addVersion({ promptId, baseVersionId, version: { id: versionId, content, variables: [] }, now });

const addTag = (promptId: string, name: string, o: { displayName?: string; now?: string; max?: number } = {}) =>
  db.prompts.addTag({
    promptId,
    name,
    displayName: o.displayName ?? name,
    newId: uuid(nextTagId++),
    now: o.now ?? T1,
    max: o.max ?? 50,
  });

const list = (q: { words?: string[]; tagNames?: string[]; offset?: number; limit?: number } = {}) =>
  db.prompts.list({ words: q.words ?? [], tagNames: q.tagNames ?? [], offset: q.offset ?? 0, limit: q.limit ?? 50 });
const ids = async (q: Parameters<typeof list>[0] = {}) => (await list(q)).items.map((p) => p.id);

const count = (table: string) => (handle.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

describe('prompt repository', () => {
  test('create writes the prompt with version 1, and get reads it back', async () => {
    const variables = [{ name: 'Subject', defaultValue: 'oak' }];
    expect(await create(1, 'Night Sky', { description: 'Dark', content: 'Paint {{Subject}} at night', variables })).toBe(true);
    const v1 = { id: uuid(101), number: 1, content: 'Paint {{Subject}} at night', variables, createdAt: T0 };
    expect(await db.prompts.get(uuid(1))).toEqual({
      id: uuid(1),
      title: 'Night Sky',
      description: 'Dark',
      tags: [],
      currentVersion: v1,
      versions: [v1],
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await db.prompts.get(uuid(99))).toBeNull();
  });

  test('versions are newest first and the current one is the highest number', async () => {
    await create(1, 'A', { content: 'one' });
    expect(await addVersion(uuid(1), uuid(101), uuid(201), 'two', T1)).toBe('ok');
    expect(await addVersion(uuid(1), uuid(201), uuid(202), 'three', T2)).toBe('ok');
    const got = (await db.prompts.get(uuid(1)))!;
    expect(got.versions.map((v) => [v.number, v.content, v.createdAt])).toEqual([
      [3, 'three', T2],
      [2, 'two', T1],
      [1, 'one', T0],
    ]);
    expect(got.currentVersion).toMatchObject({ id: uuid(202), number: 3 });
    expect(got.updatedAt).toBe(T2);
    expect(got.createdAt).toBe(T0);
  });

  test('create with a taken title key answers false and writes nothing', async () => {
    await create(1, 'Night Sky');
    expect(await create(2, 'NIGHT SKY')).toBe(false);
    expect(await db.prompts.get(uuid(2))).toBeNull();
    expect(count('prompt')).toBe(1);
    expect(count('prompt_version')).toBe(1);
  });

  test("update refuses another prompt's title key, keeps its own and answers missing for an unknown prompt", async () => {
    await create(1, 'Night Sky');
    await create(2, 'Day');
    const update = (id: string, title: string, now = T1) =>
      db.prompts.update({ id, title, titleKey: title.toLowerCase(), description: 'New', now });
    expect(await update(uuid(2), 'night sky')).toBe('title_taken');
    expect(await db.prompts.get(uuid(2))).toMatchObject({ title: 'Day', description: '', updatedAt: T0 });
    expect(await update(uuid(1), 'NIGHT SKY', T2)).toBe('ok');
    expect(await db.prompts.get(uuid(1))).toMatchObject({ title: 'NIGHT SKY', description: 'New', updatedAt: T2 });
    expect(await update(uuid(99), 'Other')).toBe('missing');
  });

  test('addVersion numbers 1, 2, 3, refuses a stale base and an unknown prompt', async () => {
    await create(1, 'A');
    expect(await addVersion(uuid(1), uuid(101), uuid(201), 'two')).toBe('ok');
    expect(await addVersion(uuid(1), uuid(101), uuid(202), 'stale', T2)).toBe('stale');
    expect(await addVersion(uuid(1), uuid(201), uuid(203), 'three', T3)).toBe('ok');
    expect(await addVersion(uuid(99), uuid(101), uuid(204), 'x')).toBe('missing');
    const got = (await db.prompts.get(uuid(1)))!;
    expect(got.versions.map((v) => v.number)).toEqual([3, 2, 1]);
    expect(got.versions.map((v) => v.content)).not.toContain('stale');
    expect(got.updatedAt).toBe(T3);
  });

  test('getVersion answers the version with the id and current title of its prompt', async () => {
    const variables = [{ name: 'x', defaultValue: '' }];
    await create(1, 'Old', { content: '{{x}}', variables });
    await addVersion(uuid(1), uuid(101), uuid(201), 'two');
    await db.prompts.update({ id: uuid(1), title: 'New', titleKey: 'new', description: '', now: T2 });
    expect(await db.prompts.getVersion(uuid(101))).toEqual({
      promptId: uuid(1),
      title: 'New',
      version: { id: uuid(101), number: 1, content: '{{x}}', variables, createdAt: T0 },
    });
    expect(await db.prompts.getVersion(uuid(999))).toBeNull();
  });

  test('a variables column that does not parse reads as an empty list', async () => {
    await create(1, 'A', { variables: [{ name: 'x', defaultValue: '' }] });
    handle.prepare("update prompt_version set variables = 'nope' where id = ?").run(uuid(101));
    expect((await db.prompts.get(uuid(1)))!.currentVersion.variables).toEqual([]);
    handle.prepare(`update prompt_version set variables = '{"v":2,"items":[]}' where id = ?`).run(uuid(101));
    expect((await db.prompts.getVersion(uuid(101)))!.version.variables).toEqual([]);
  });

  test('the variables column holds the versioned wrapper', async () => {
    const variables = [{ name: 'x', defaultValue: 'y' }];
    await create(1, 'A', { content: '{{x}}', variables });
    expect(handle.prepare('select variables from prompt_version where id = ?').get(uuid(101))).toEqual({
      variables: JSON.stringify({ v: 1, items: variables }),
    });
  });

  test('remove deletes the prompt with its versions and links and leaves the tag row', async () => {
    await create(1, 'A');
    await create(2, 'B');
    await addVersion(uuid(1), uuid(101), uuid(201), 'two');
    await addTag(uuid(1), 'forest');
    await addTag(uuid(2), 'forest');
    expect(await db.prompts.remove(uuid(1))).toBe(true);
    expect(await db.prompts.get(uuid(1))).toBeNull();
    expect(await db.prompts.getVersion(uuid(201))).toBeNull();
    expect(count('prompt_version')).toBe(1);
    expect(count('prompt_tag')).toBe(1);
    expect(count('tag')).toBe(1);
    expect(await db.prompts.remove(uuid(1))).toBe(false);
  });

  test('addTag writes one link, sets updated_at, and refuses a tag beyond max', async () => {
    await create(1, 'A');
    expect(await addTag(uuid(1), 'forest', { displayName: 'Forest', now: T1 })).toBe('ok');
    expect(await addTag(uuid(1), 'forest', { displayName: 'FOREST', now: T2 })).toBe('ok');
    expect(count('prompt_tag')).toBe(1);
    const got = (await db.prompts.get(uuid(1)))!;
    expect(got.tags).toEqual([{ name: 'forest', displayName: 'Forest', origin: 'manual' }]);
    expect(got.updatedAt).toBe(T1);
    expect(await addTag(uuid(99), 'forest')).toBe('missing');

    for (let i = 1; i < 50; i++) expect(await addTag(uuid(1), `t${i}`)).toBe('ok');
    expect(await addTag(uuid(1), 'one too many', { now: T3 })).toBe('limit');
    expect(count('prompt_tag')).toBe(50);
    expect(handle.prepare('select count(*) as n from tag where name = ?').get('one too many')).toEqual({ n: 0 });
    // A tag the prompt already carries is still a no-op at the limit.
    expect(await addTag(uuid(1), 'forest')).toBe('ok');
  });

  test('removeTag deletes the link and sets updated_at; an unknown prompt is missing', async () => {
    await create(1, 'A');
    await addTag(uuid(1), 'forest');
    await addTag(uuid(1), 'oak');
    expect(await db.prompts.removeTag({ promptId: uuid(1), name: 'forest', now: T2 })).toBe('ok');
    const got = (await db.prompts.get(uuid(1)))!;
    expect(got.tags.map((t) => t.name)).toEqual(['oak']);
    expect(got.updatedAt).toBe(T2);
    expect(await db.prompts.removeTag({ promptId: uuid(1), name: 'unknown', now: T3 })).toBe('ok');
    expect(await db.prompts.removeTag({ promptId: uuid(99), name: 'oak', now: T3 })).toBe('missing');
  });

  test('list orders by updated_at desc, then id, and pages by offset and limit with total', async () => {
    await create(3, 'C', { now: T1 });
    await create(1, 'A', { now: T1 });
    await create(2, 'B', { now: T2 });
    await create(4, 'D', { now: T0 });
    expect(await ids()).toEqual([uuid(2), uuid(1), uuid(3), uuid(4)]);
    const page = await list({ offset: 1, limit: 2 });
    expect(page.total).toBe(4);
    expect(page.items.map((p) => p.id)).toEqual([uuid(1), uuid(3)]);
    expect(page.items[0]).toEqual({
      id: uuid(1),
      title: 'A',
      description: '',
      tags: [],
      currentVersion: { id: uuid(101), number: 1, content: 'Text of A', variables: [], createdAt: T1 },
      updatedAt: T1,
    });
  });

  test('a list item carries its current version and tags', async () => {
    await create(1, 'A', { content: 'one' });
    await addVersion(uuid(1), uuid(101), uuid(201), 'two', T1);
    await addTag(uuid(1), 'oak', { displayName: 'Oak' });
    await addTag(uuid(1), 'birch');
    const [item] = (await list()).items;
    expect(item!.currentVersion).toMatchObject({ id: uuid(201), number: 2, content: 'two' });
    expect(item!.tags.map((t) => t.name)).toEqual(['birch', 'oak']);
  });

  test('a word matches title, description, current content and tag display name regardless of case', async () => {
    await create(1, 'Night Sky', { now: T3 });
    await create(2, 'B', { description: 'Rolling HILLS', now: T2 });
    await create(3, 'C', { content: 'old moon', now: T1 });
    await addVersion(uuid(3), uuid(103), uuid(203), 'bright SUN', T1);
    await create(4, 'D', { now: T0 });
    await addTag(uuid(4), 'forest', { displayName: 'Dark Forest', now: T0 });
    expect(await ids({ words: ['night'] })).toEqual([uuid(1)]);
    expect(await ids({ words: ['SKY'] })).toEqual([uuid(1)]);
    expect(await ids({ words: ['hill'] })).toEqual([uuid(2)]);
    expect(await ids({ words: ['sun'] })).toEqual([uuid(3)]);
    expect(await ids({ words: ['moon'] })).toEqual([]);
    expect(await ids({ words: ['dark'] })).toEqual([uuid(4)]);
    expect((await list({ words: ['dark'] })).total).toBe(1);
  });

  test('every word must match, each in any field', async () => {
    await create(1, 'Red barn', { description: 'at dusk' });
    await addTag(uuid(1), 'farm');
    expect(await ids({ words: ['red', 'dusk'] })).toEqual([uuid(1)]);
    expect(await ids({ words: ['farm', 'barn', 'text'] })).toEqual([uuid(1)]);
    expect(await ids({ words: ['red', 'dawn'] })).toEqual([]);
  });

  test('all given tag names must be on the prompt', async () => {
    await create(1, 'A', { now: T2 });
    await create(2, 'B', { now: T1 });
    await addTag(uuid(1), 'oak', { now: T2 });
    await addTag(uuid(1), 'pine', { now: T2 });
    await addTag(uuid(2), 'oak', { now: T1 });
    expect(await ids({ tagNames: ['oak'] })).toEqual([uuid(1), uuid(2)]);
    expect(await ids({ tagNames: ['oak', 'pine'] })).toEqual([uuid(1)]);
    expect(await ids({ tagNames: ['oak', 'unknown'] })).toEqual([]);
    expect(await ids({ tagNames: ['pine'], words: ['b'] })).toEqual([]);
  });

  test('LIKE wildcards and the escape character in a word match literally', async () => {
    await create(1, '100% wool', { content: 'x', now: T3 });
    await create(2, 'plain', { content: 'x', now: T2 });
    await create(3, '1000 sheep', { content: 'x', now: T1 });
    await create(4, 'abc', { content: 'x', now: T0 });
    await create(5, 'back\\slash', { content: 'x', now: T0 });
    expect(await ids({ words: ['100%'] })).toEqual([uuid(1)]);
    expect(await ids({ words: ['a_c'] })).toEqual([]);
    expect(await ids({ words: ['\\'] })).toEqual([uuid(5)]);
  });
});
