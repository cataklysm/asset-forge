import { describe, expect, it, vi } from 'vitest';
import type { FileRecord, FileTarget } from '@assetforge/contracts';
import * as core from '../src/index.js';
import type { WorkspaceSession } from '../src/session.js';

const TARGET: FileTarget = { assetId: '11111111-1111-4111-8111-111111111111', role: 'reference' };
const SOURCE = 'https://example.com/gallery';

function fixture(rows: Array<Partial<FileRecord>>) {
  const records = rows.map((row, i) => ({
    id: String(i),
    originalName: 'photo.jpg',
    status: 'complete',
    deletedAt: null,
    assetId: TARGET.assetId,
    ...row,
  })) as FileRecord[];
  const list = vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => ({
    items: records.slice(offset, offset + limit),
    total: records.length,
  }));
  const session = { database: { files: { list } } } as unknown as WorkspaceSession;
  return { session, list };
}

describe('asset-scoped site filename filtering', () => {
  it('matches the original full name, decoding URLs and ignoring query tokens', async () => {
    const { session, list } = fixture([{ originalName: 'Photo One.JPG' }]);
    const url = 'https://cdn.example/Photo%20One.jpg?token=123';
    const answer = await core.buildSiteCandidates(session, [url], TARGET, SOURCE);
    expect(answer).toEqual([{ url, sourcePageUrl: SOURCE, expectedName: 'Photo One.jpg', alreadyPresent: true }]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'asset', assetId: TARGET.assetId } }));
  });

  it('does not match pending, trashed, failed or other-asset files', async () => {
    const { session } = fixture([
      { originalName: 'pending.jpg', status: 'pending' },
      { originalName: 'trashed.jpg', deletedAt: '2026-11-28T00:00:00.000Z' },
      { originalName: 'failed.jpg', status: 'failed' },
      { originalName: 'other.jpg', assetId: 'other' },
    ]);
    const urls = ['pending.jpg', 'trashed.jpg', 'failed.jpg', 'other.jpg'].map((name) => `https://cdn.example/${name}`);
    expect((await core.buildSiteCandidates(session, urls, TARGET, SOURCE)).every((row) => !row.alreadyPresent)).toBe(
      true,
    );
  });

  it('reads beyond the first backend page without UI filters', async () => {
    const { session, list } = fixture(Array.from({ length: 1001 }, (_, i) => ({ originalName: `photo-${i}.jpg` })));
    const [candidate] = await core.buildSiteCandidates(session, ['https://cdn.example/photo-1000.jpg'], TARGET, SOURCE);
    expect(candidate?.alreadyPresent).toBe(true);
    expect(list.mock.calls.length).toBeGreaterThan(1);
    expect(list.mock.calls.every(([query]) => !('query' in query) && !('role' in query) && !('kind' in query))).toBe(
      true,
    );
  });

  it('leaves download endpoints and ambiguous path segments unknown', async () => {
    const { session } = fixture([{ originalName: 'download.php' }]);
    const urls = [
      'https://cdn.example/download?id=53',
      'https://cdn.example/download.php?id=53',
      'https://cdn.example/a%2Fb.jpg',
    ];
    expect(
      (await core.buildSiteCandidates(session, urls, TARGET, SOURCE)).map((row) => [
        row.expectedName,
        row.alreadyPresent,
      ]),
    ).toEqual([
      [null, false],
      [null, false],
      [null, false],
    ]);
  });

  it('does not inspect asset filenames for an inbox import', async () => {
    const { session, list } = fixture([{ originalName: 'photo.jpg' }]);
    const [candidate] = await core.buildSiteCandidates(session, ['https://cdn.example/photo.jpg'], null, SOURCE);
    expect(candidate?.alreadyPresent).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it('retains unknown names and permits explicit per-candidate overrides', async () => {
    const { session } = fixture([{ originalName: 'photo.jpg' }]);
    const urls = ['https://cdn.example/photo.jpg', 'https://cdn.example/download?id=53'];
    const candidates = await core.buildSiteCandidates(session, urls, TARGET, SOURCE);
    expect(core.selectedSiteUrls(candidates, { skipExistingNames: true })).toEqual([urls[1]]);
    expect(core.selectedSiteUrls(candidates, { skipExistingNames: true, includeExistingUrls: [urls[0]!] })).toEqual(
      urls,
    );
    expect(core.selectedSiteUrls(candidates, { skipExistingNames: false })).toEqual(urls);
    expect(core.selectedSiteUrls(candidates, { selectedUrls: [urls[0]!], skipExistingNames: true })).toEqual([]);
    expect(
      core.selectedSiteUrls(candidates, {
        selectedUrls: ['https://unreviewed.example/x.jpg'],
        skipExistingNames: false,
      }),
    ).toEqual([]);
  });

  it('reflects a file added after the earlier review', async () => {
    const before = fixture([]);
    const after = fixture([{ originalName: 'photo.jpg' }]);
    const url = 'https://cdn.example/photo.jpg';
    expect(
      core.selectedSiteUrls(await core.buildSiteCandidates(before.session, [url], TARGET, SOURCE), {
        skipExistingNames: true,
      }),
    ).toEqual([url]);
    expect(
      core.selectedSiteUrls(await core.buildSiteCandidates(after.session, [url], TARGET, SOURCE), {
        skipExistingNames: true,
      }),
    ).toEqual([]);
  });
});
