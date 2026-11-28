import { describe, expect, test } from 'vitest';
import { InMemoryDatabase } from './fakes.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';

function setup() {
  const db = new InMemoryDatabase();
  const create = (n: number, title: string, now = T0) =>
    db.prompts.create({
      id: id(n),
      title,
      titleKey: title.toLowerCase(),
      description: '',
      version: { id: id(n + 100), content: `Text of ${title}`, variables: [] },
      now,
    });
  return { db, create };
}

describe('InMemoryPromptRepository', () => {
  test('create, update and addVersion answer like the SQLite repository', async () => {
    const { db, create } = setup();
    expect(await create(1, 'Night')).toBe(true);
    expect(await create(2, 'night')).toBe(false);
    expect(await create(3, 'Day')).toBe(true);
    expect(await db.prompts.update({ id: id(3), title: 'NIGHT', titleKey: 'night', description: '', now: T1 })).toBe(
      'title_taken',
    );
    expect(await db.prompts.update({ id: id(9), title: 'X', titleKey: 'x', description: '', now: T1 })).toBe('missing');
    expect(
      await db.prompts.update({ id: id(1), title: 'Night sky', titleKey: 'night sky', description: 'd', now: T1 }),
    ).toBe('ok');

    const v = { id: id(201), content: 'Second', variables: [] };
    expect(await db.prompts.addVersion({ promptId: id(1), baseVersionId: id(101), version: v, now: T2 })).toBe('ok');
    expect(
      await db.prompts.addVersion({ promptId: id(1), baseVersionId: id(101), version: { ...v, id: id(202) }, now: T2 }),
    ).toBe('stale');
    expect(await db.prompts.addVersion({ promptId: id(9), baseVersionId: id(101), version: v, now: T2 })).toBe(
      'missing',
    );
    const detail = await db.prompts.get(id(1));
    expect(detail?.versions.map((x) => x.number)).toEqual([2, 1]);
    expect(detail?.currentVersion).toMatchObject({ id: id(201), number: 2, content: 'Second' });
    expect(detail?.updatedAt).toBe(T2);
  });

  test('list orders by updated_at desc, then id, and filters by word and tag', async () => {
    const { db, create } = setup();
    await create(2, 'Storm', T0);
    await create(1, 'Rain', T0);
    await create(3, 'Sun', T1);
    await db.prompts.addTag({
      promptId: id(2),
      name: 'weather',
      displayName: 'Weather',
      newId: id(500),
      now: T0,
      max: 50,
    });
    const all = await db.prompts.list({ words: [], tagNames: [], offset: 0, limit: 10 });
    expect(all.items.map((p) => p.id)).toEqual([id(3), id(1), id(2)]);
    expect(all.total).toBe(3);
    expect(
      (await db.prompts.list({ words: ['weath'], tagNames: [], offset: 0, limit: 10 })).items.map((p) => p.id),
    ).toEqual([id(2)]);
    await create(4, 'Über Kopf', T0);
    expect(
      (await db.prompts.list({ words: ['uber'], tagNames: [], offset: 0, limit: 10 })).items.map((p) => p.id),
    ).toEqual([id(4)]);
    expect(
      (await db.prompts.list({ words: [], tagNames: ['weather'], offset: 0, limit: 10 })).items.map((p) => p.id),
    ).toEqual([id(2)]);
    expect(await db.tags.usage('weather')).toMatchObject({ prompts: 1 });
  });

  test('a generation reads the prompt id through the version until the prompt is removed', async () => {
    const { db, create } = setup();
    await create(1, 'Night');
    db.generations.rows.push({
      id: id(700),
      kind: 'edit',
      providerId: id(800),
      providerName: 'Venice',
      providerKind: 'venice',
      model: 'm',
      prompt: 'Night oak',
      parameters: { v: 1, aspectRatio: null, resolution: null, safeMode: true },
      promptRef: { versionId: id(101), title: 'Night', versionNumber: 1, variables: { Subject: 'oak' } },
      createdAt: T0,
      status: 'succeeded',
      errorCode: null,
      jobId: null,
      finishedAt: T0,
      inputs: [],
      outputs: [],
    });
    expect(await db.generations.get(id(700))).toMatchObject({
      promptId: id(1),
      promptVersionId: id(101),
      promptTitle: 'Night',
    });
    await db.prompts.remove(id(1));
    expect(await db.generations.get(id(700))).toMatchObject({
      promptId: null,
      promptVersionId: null,
      promptTitle: 'Night',
      promptVersionNumber: 1,
      promptVariables: { Subject: 'oak' },
    });
  });
});
