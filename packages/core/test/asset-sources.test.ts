import { describe, expect, it } from 'vitest';
import {
  addAssetSource,
  createAsset,
  getAssetDetail,
  InvalidOperationError,
  MAX_ASSET_SOURCES,
  MAX_SOURCE_URL_LENGTH,
  normalizeSourceUrl,
  NotFoundError,
  removeAssetSource,
  resolveAssetSourceUrl,
  ValidationFailedError,
  WorkspaceManager,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

async function setup() {
  const fake = createFakeHost();
  let tick = 0;
  fake.host.now = () => new Date(Date.UTC(2026, 0, 1, 0, tick++, 0));
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const db = fake.databases.get(summary.id)!;
  const session: WorkspaceSession = await manager.read(async (s) => s);
  const typeId = (await db.assetTypes.list())[0]!.id;
  const asset = await createAsset(session, { name: 'Door', typeId });
  const other = await createAsset(session, { name: 'Window', typeId });
  return { fake, db, session, asset, other };
}

function expectNotAddress(input: string) {
  let error: unknown;
  try {
    normalizeSourceUrl(input);
  } catch (e) {
    error = e;
  }
  expect(error, input).toBeInstanceOf(ValidationFailedError);
  expect((error as Error).message).toBe('This is not a web address');
}

describe('normalizeSourceUrl', () => {
  it('checks the length again after normalisation', () => {
    const typed = 'https://example.org/' + ' a'.repeat(700);
    expect(typed.length).toBeLessThan(MAX_SOURCE_URL_LENGTH);
    expectNotAddress(typed);
  });

  it('exposes its limits', () => {
    expect(MAX_ASSET_SOURCES).toBe(50);
    expect(MAX_SOURCE_URL_LENGTH).toBe(2000);
  });

  it('trims and returns the parsed href', () => {
    expect(normalizeSourceUrl('  https://Example.org/a?b=1#c  ')).toBe('https://example.org/a?b=1#c');
    expect(normalizeSourceUrl('http://example.org')).toBe('http://example.org/');
  });

  it('refuses everything that is not an http or https address without credentials', () => {
    for (const input of [
      '',
      '   ',
      'example.org',
      'ftp://example.org/x',
      'file:///C:/x',
      'javascript:alert(1)',
      'mailto:a@example.org',
      'https://user:pw@example.org/',
      'https://user@example.org/',
      'https://',
      'https://example.org/' + 'a'.repeat(2000),
    ]) {
      expectNotAddress(input);
    }
  });
});

describe('addAssetSource', () => {
  it('stores the normalised address and moves updatedAt', async () => {
    const ctx = await setup();
    const now = new Date('2026-05-01T12:00:00.000Z');
    const session: WorkspaceSession = { ...ctx.session, now: () => now };
    const detail = await addAssetSource(session, { assetId: ctx.asset.id, url: 'https://Example.org/a' });
    expect(detail.sources).toEqual([{ id: expect.any(String), url: 'https://example.org/a', createdAt: now.toISOString() }]);
    expect(detail.updatedAt).toBe(now.toISOString());
    expect((await ctx.db.assets.get(ctx.asset.id))!.updatedAt).toBe(now.toISOString());
  });

  it('answers not_found for an unknown asset', async () => {
    const ctx = await setup();
    await expect(addAssetSource(ctx.session, { assetId: UNKNOWN_ID, url: 'https://example.org/' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('refuses an address the asset already has in its normalised form', async () => {
    const ctx = await setup();
    await addAssetSource(ctx.session, { assetId: ctx.asset.id, url: 'http://example.org/' });
    const attempt = addAssetSource(ctx.session, { assetId: ctx.asset.id, url: 'HTTP://Example.org' });
    await expect(attempt).rejects.toBeInstanceOf(InvalidOperationError);
    await expect(attempt).rejects.toThrow('This source already exists');
    expect((await getAssetDetail(ctx.session, ctx.asset.id)).sources).toHaveLength(1);
    const other = await addAssetSource(ctx.session, { assetId: ctx.other.id, url: 'http://example.org/' });
    expect(other.sources.map((x) => x.url)).toEqual(['http://example.org/']);
  });

  it('refuses the 51st source and inserts nothing', async () => {
    const ctx = await setup();
    for (let i = 0; i < MAX_ASSET_SOURCES; i++) {
      await addAssetSource(ctx.session, { assetId: ctx.asset.id, url: `https://example.org/${i}` });
    }
    const attempt = addAssetSource(ctx.session, { assetId: ctx.asset.id, url: 'https://example.org/last' });
    await expect(attempt).rejects.toBeInstanceOf(InvalidOperationError);
    await expect(attempt).rejects.toThrow('This asset cannot take more sources');
    expect(await ctx.db.assetSources.countByAsset(ctx.asset.id)).toBe(MAX_ASSET_SOURCES);
  });

  it('lists sources in the order they were added', async () => {
    const ctx = await setup();
    for (const path of ['c', 'a', 'b']) {
      await addAssetSource(ctx.session, { assetId: ctx.asset.id, url: `https://example.org/${path}` });
    }
    const detail = await getAssetDetail(ctx.session, ctx.asset.id);
    expect(detail.sources.map((x) => x.url)).toEqual([
      'https://example.org/c',
      'https://example.org/a',
      'https://example.org/b',
    ]);
  });
});

describe('removeAssetSource', () => {
  it('removes the source and moves updatedAt', async () => {
    const ctx = await setup();
    const added = await addAssetSource(ctx.session, { assetId: ctx.asset.id, url: 'https://example.org/' });
    const now = new Date('2026-06-01T12:00:00.000Z');
    const session: WorkspaceSession = { ...ctx.session, now: () => now };
    const detail = await removeAssetSource(session, { assetId: ctx.asset.id, sourceId: added.sources[0]!.id });
    expect(detail.sources).toEqual([]);
    expect(detail.updatedAt).toBe(now.toISOString());
  });

  it('answers not_found for an unknown source and for a source of another asset', async () => {
    const ctx = await setup();
    await expect(removeAssetSource(ctx.session, { assetId: ctx.asset.id, sourceId: UNKNOWN_ID })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const foreign = await addAssetSource(ctx.session, { assetId: ctx.other.id, url: 'https://example.org/' });
    await expect(
      removeAssetSource(ctx.session, { assetId: ctx.asset.id, sourceId: foreign.sources[0]!.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await getAssetDetail(ctx.session, ctx.other.id)).sources).toHaveLength(1);
  });
});

describe('resolveAssetSourceUrl', () => {
  it('returns the stored address', async () => {
    const ctx = await setup();
    const added = await addAssetSource(ctx.session, { assetId: ctx.asset.id, url: 'https://example.org/x' });
    await expect(
      resolveAssetSourceUrl(ctx.session, { assetId: ctx.asset.id, sourceId: added.sources[0]!.id }),
    ).resolves.toBe('https://example.org/x');
  });

  it('answers not_found for a source of another asset', async () => {
    const ctx = await setup();
    const foreign = await addAssetSource(ctx.session, { assetId: ctx.other.id, url: 'https://example.org/' });
    await expect(
      resolveAssetSourceUrl(ctx.session, { assetId: ctx.asset.id, sourceId: foreign.sources[0]!.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('checks a stored address again before handing it out', async () => {
    const ctx = await setup();
    const id = '11111111-1111-4111-8111-111111111111';
    await ctx.db.assetSources.insert({ id, assetId: ctx.asset.id, url: 'file:///x', createdAt: '2026-01-01T00:00:00.000Z' });
    await expect(resolveAssetSourceUrl(ctx.session, { assetId: ctx.asset.id, sourceId: id })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });
});

describe('getAssetDetail', () => {
  it('has no sources for a new asset', async () => {
    const ctx = await setup();
    expect((await getAssetDetail(ctx.session, ctx.asset.id)).sources).toEqual([]);
  });
});
