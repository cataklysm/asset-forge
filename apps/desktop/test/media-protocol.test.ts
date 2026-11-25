import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageUnreachableError, type PreviewSource, type WorkspaceManager } from '@assetforge/core';
import type { PreviewRequest } from '@assetforge/media';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceManager } from '../src/main/composition.js';
import {
  findSourceIn,
  handleMediaRequest,
  MEDIA_SCHEME,
  parsePreviewUrl,
  type MediaProtocolDeps,
} from '../src/main/media-protocol.js';

const ID = '0b6c2f0e-3f7a-4c1d-9e2b-5a8d7c6b4e3f';
const SHA = 'a'.repeat(64);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

let base: string;
let root: string;
let cacheDir: string;
let cachedPath: string;
let manager: WorkspaceManager;
const get = vi.fn<(request: PreviewRequest) => Promise<string | null>>();

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-media-'));
  root = join(base, 'workspace');
  cacheDir = join(base, 'userData', 'cache');
  cachedPath = join(cacheDir, 'thumbnails', 'aa', `${SHA}-256-v1.webp`);
  await mkdir(join(cacheDir, 'thumbnails', 'aa'), { recursive: true });
  await writeFile(cachedPath, WEBP);
  get.mockReset().mockResolvedValue(cachedPath);
  manager = createWorkspaceManager({ userDataPath: join(base, 'userData'), migrationsFolder: MIGRATIONS_FOLDER });
});
afterEach(async () => {
  await manager.close();
  await rm(base, { recursive: true, force: true });
});

function url(fileId: string, size = 'thumb'): string {
  return `${MEDIA_SCHEME}://preview/${fileId}?size=${size}`;
}

function fakeDeps(overrides: Partial<MediaProtocolDeps> = {}): MediaProtocolDeps {
  return {
    findSource: async (): Promise<PreviewSource> => ({ sha256: SHA, absolutePath: join(root, 'x.png') }),
    previews: { get },
    readFile,
    ...overrides,
  };
}

function realDeps(): MediaProtocolDeps {
  return { findSource: findSourceIn(manager), previews: { get }, readFile };
}

async function importFile(name: string, content = 'data') {
  await manager.create({ name: 'Test', rootPath: root });
  const source = join(base, name);
  await writeFile(source, content);
  const [result] = await manager.importFiles([source]);
  return result!.file!;
}

/** Status, headers and body of a response, with the body read exactly once. */
async function inspect(response: Response) {
  const body = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, headers: [...response.headers.entries()], body };
}

/** Headers and body as plain text, so a raw Windows path (backslashes) is found as written. */
function plainText(seen: { headers: [string, string][]; body: Uint8Array }): string {
  const headers = seen.headers.map(([name, value]) => `${name}: ${value}`).join('\n');
  return `${headers}\n${Buffer.from(seen.body).toString('latin1')}`;
}

async function expectBare404(response: Response) {
  const seen = await inspect(response);
  expect(seen.status).toBe(404);
  expect(seen.body.byteLength).toBe(0);
  expect(seen.headers.filter(([name]) => name !== 'content-length')).toEqual([]);
  return seen;
}

describe('parsePreviewUrl', () => {
  it('reads file id and size from a preview URL', () => {
    expect(parsePreviewUrl(url(ID))).toEqual({ fileId: ID, size: 'thumb' });
    expect(parsePreviewUrl(url(ID, 'detail'))).toEqual({ fileId: ID, size: 'detail' });
  });
});

describe('media protocol', () => {
  it('serves the cached webp of a known complete image', async () => {
    const file = await importFile('pump.png');
    const response = await handleMediaRequest({ url: url(file.id), method: 'GET' }, realDeps());
    const seen = await inspect(response);
    expect(seen.status).toBe(200);
    expect(seen.headers).toEqual([
      ['cache-control', 'private, max-age=31536000'],
      ['content-type', 'image/webp'],
    ]);
    expect(seen.body).toEqual(WEBP);
    expect(get).toHaveBeenCalledTimes(1);
    const request = get.mock.calls[0]![0];
    expect(request).toMatchObject({ sha256: file.sha256, size: 'thumb' });
    expect(request.sourcePath.startsWith(root)).toBe(true);
  });

  it.each([
    `${MEDIA_SCHEME}://other/${ID}?size=thumb`,
    `${MEDIA_SCHEME}://preview/${ID}?size=huge`,
    `${MEDIA_SCHEME}://preview/${ID}`,
    `${MEDIA_SCHEME}://preview/${ID}/x?size=thumb`,
    `${MEDIA_SCHEME}://preview/..%2F..%2Fsecret?size=thumb`,
    `${MEDIA_SCHEME}://preview/not-a-uuid?size=thumb`,
    `${MEDIA_SCHEME}://preview/${ID}?size=thumb&path=C:/x`,
    'file:///C:/x.png',
    `${MEDIA_SCHEME}://preview:8080/${ID}?size=thumb`,
    `${MEDIA_SCHEME}://preview/${ID}?size=thumb&size=thumb`,
    `${MEDIA_SCHEME}://preview/${ID}?size=`,
    `${MEDIA_SCHEME}://preview/${ID}/?size=thumb`,
    `${MEDIA_SCHEME}://user:pw@preview/${ID}?size=thumb`,
    `${MEDIA_SCHEME}://preview/x/../${ID}?size=thumb`,
    `${MEDIA_SCHEME}://preview/./${ID}?size=thumb`,
    `${MEDIA_SCHEME}://preview/%2E%2E/${ID}?size=thumb`,
    // Node keeps the case of a non-special scheme's host; see parsePreviewUrl.
    `${MEDIA_SCHEME}://PREVIEW/${ID}?size=thumb`,
    `${MEDIA_SCHEME}://preview/${ID}?size=thumb#frag`,
    `${MEDIA_SCHEME}://preview/${ID}?size=thumb#`,
  ])('answers %s with a bare 404', async (requestUrl) => {
    expect(parsePreviewUrl(requestUrl)).toBeNull();
    const findSource = vi.fn(fakeDeps().findSource);
    await expectBare404(await handleMediaRequest({ url: requestUrl, method: 'GET' }, fakeDeps({ findSource })));
    expect(findSource).not.toHaveBeenCalled();
  });

  it('non-GET requests answer 404', async () => {
    for (const method of ['POST', 'PUT', 'HEAD', 'DELETE']) {
      await expectBare404(await handleMediaRequest({ url: url(ID), method }, fakeDeps()));
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('unknown, incomplete and non-image files answer 404', async () => {
    const document = await importFile('notes.pdf');
    const pendingId = '7d1e9c3a-2b4f-4a6e-8c5d-1f0a9b8e7d6c';
    await manager.read(async (s) =>
      s.database.files.insertPending({
        id: pendingId,
        storageId: s.storageId,
        originalName: 'late.png',
        relativePath: `inbox/${pendingId}/late.png`,
        mimeType: 'image/png',
        importedAt: new Date().toISOString(),
        kind: 'image',
      }),
    );
    for (const fileId of [ID, pendingId, document.id]) {
      await expectBare404(await handleMediaRequest({ url: url(fileId), method: 'GET' }, realDeps()));
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('no open workspace answers 404', async () => {
    await expectBare404(await handleMediaRequest({ url: url(ID), method: 'GET' }, realDeps()));
    expect(get).not.toHaveBeenCalled();
  });

  it('storage unreachable answers 404', async () => {
    const findSource = async (): Promise<PreviewSource> => {
      throw new StorageUnreachableError('The storage of this workspace is not reachable');
    };
    await expectBare404(await handleMediaRequest({ url: url(ID), method: 'GET' }, fakeDeps({ findSource })));
    expect(get).not.toHaveBeenCalled();
  });

  it('no preview answers 404', async () => {
    get.mockResolvedValue(null);
    await expectBare404(await handleMediaRequest({ url: url(ID), method: 'GET' }, fakeDeps()));
  });

  it('a cached file removed before it is read answers 404', async () => {
    await rm(cachedPath);
    const seen = await expectBare404(await handleMediaRequest({ url: url(ID), method: 'GET' }, fakeDeps()));
    expect(plainText(seen)).not.toContain(cacheDir);
  });

  it('no response carries a path', async () => {
    const file = await importFile('pump.png');
    const unreachable = async (): Promise<PreviewSource> => {
      throw new StorageUnreachableError('The storage of this workspace is not reachable');
    };
    const failingRead = async (path: string): Promise<Uint8Array> => {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
    };
    const cases: [{ url: string; method: string }, MediaProtocolDeps][] = [
      [{ url: url(file.id), method: 'GET' }, realDeps()],
      [{ url: url(ID), method: 'GET' }, realDeps()],
      [{ url: url(file.id), method: 'POST' }, realDeps()],
      [{ url: `${MEDIA_SCHEME}://preview/${ID}?size=thumb&path=${root}`, method: 'GET' }, realDeps()],
      [{ url: url(ID), method: 'GET' }, fakeDeps({ findSource: unreachable })],
      [{ url: url(ID), method: 'GET' }, fakeDeps({ previews: { get: async () => null } })],
      [{ url: url(ID), method: 'GET' }, fakeDeps({ readFile: failingRead })],
    ];
    const roots = [root, cacheDir, root.replaceAll('\\', '/'), cacheDir.replaceAll('\\', '/')];
    for (const [request, deps] of cases) {
      const seen = await inspect(await handleMediaRequest(request, deps));
      const text = plainText(seen);
      for (const path of roots) expect(text).not.toContain(path);
    }
  });
});
