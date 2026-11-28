import { mkdir, mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `open` is wrapped (not replaced) so a test can see whether `openFile` closed its handle.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { ORIGINAL_MAX_EDGE, ORIGINAL_MIME_TYPES } from '@assetforge/contracts';
import {
  StorageUnreachableError,
  trashFiles,
  trashPath,
  type OriginalSource,
  type PreviewSource,
  type WorkspaceManager,
} from '@assetforge/core';
import { PREVIEW_EDGE, type PreviewRequest } from '@assetforge/media';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceManager } from '../src/main/composition.js';
import {
  findOriginalIn,
  findSourceIn,
  findVideoIn,
  handleMediaRequest,
  type MediaProtocolDependencies,
} from '../src/main/media-protocol.js';
import { openFile } from '../src/main/media-file.js';
import { MEDIA_SCHEME, parseOriginalUrl, parsePreviewUrl } from '../src/main/media-routes.js';

const ID = '0b6c2f0e-3f7a-4c1d-9e2b-5a8d7c6b4e3f';
const SHA = 'a'.repeat(64);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5]);
const ORIGINAL = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);

let base: string;
let root: string;
let cacheDir: string;
let cachedPath: string;
let fullPath: string;
let originalPath: string;
let manager: WorkspaceManager;
const get = vi.fn<(request: PreviewRequest) => Promise<string | null>>();

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-media-'));
  root = join(base, 'workspace');
  cacheDir = join(base, 'userData', 'cache');
  cachedPath = join(cacheDir, 'thumbnails', 'aa', `${SHA}-256-v1.webp`);
  await mkdir(join(cacheDir, 'thumbnails', 'aa'), { recursive: true });
  await writeFile(cachedPath, WEBP);
  fullPath = join(cacheDir, 'full', 'aa', `${SHA}-8192-v1.png`);
  await mkdir(join(cacheDir, 'full', 'aa'), { recursive: true });
  await writeFile(fullPath, PNG);
  originalPath = join(base, 'original.bin');
  await writeFile(originalPath, ORIGINAL);
  get.mockReset().mockImplementation(async (request) => (request.size === 'full' ? fullPath : cachedPath));
  manager = createWorkspaceManager({ userDataPath: join(base, 'userData'), migrationsFolder: MIGRATIONS_FOLDER });
});
afterEach(async () => {
  await manager.close();
  await rm(base, { recursive: true, force: true });
});

function url(fileId: string, size = 'thumb'): string {
  return `${MEDIA_SCHEME}://preview/${fileId}?size=${size}`;
}

function originalUrl(fileId: string): string {
  return `${MEDIA_SCHEME}://original/${fileId}`;
}

function fakeDeps(overrides: Partial<MediaProtocolDependencies> = {}): MediaProtocolDependencies {
  return {
    findSource: async (): Promise<PreviewSource> => ({ sha256: SHA, absolutePath: join(root, 'x.png'), video: null }),
    findOriginal: async (): Promise<OriginalSource> => ({ absolutePath: originalPath, mimeType: 'image/png' }),
    findVideo: async () => null,
    previews: { get },
    readFile,
    openFile,
    ...overrides,
  };
}

function realDeps(): MediaProtocolDependencies {
  return {
    findSource: findSourceIn(manager),
    findOriginal: findOriginalIn(manager),
    findVideo: findVideoIn(manager),
    previews: { get },
    readFile,
    openFile,
  };
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
    expect(parsePreviewUrl(url(ID, 'full'))).toEqual({ fileId: ID, size: 'full' });
  });

  it.each(['original', 'FULL', 'Full', 'full%20'])('rejects size=%s', (size) => {
    expect(parsePreviewUrl(url(ID, size))).toBeNull();
  });
});

describe('parseOriginalUrl', () => {
  it('reads the file id from an original URL', () => {
    expect(parseOriginalUrl(originalUrl(ID))).toEqual({ fileId: ID });
  });

  it.each([
    ['a query', `${MEDIA_SCHEME}://original/${ID}?size=full`],
    ['an empty query', `${MEDIA_SCHEME}://original/${ID}?`],
    ['an empty fragment', `${MEDIA_SCHEME}://original/${ID}#`],
    ['a fragment', `${MEDIA_SCHEME}://original/${ID}#x`],
    ['a trailing slash', `${MEDIA_SCHEME}://original/${ID}/`],
    ['a second path segment', `${MEDIA_SCHEME}://original/${ID}/x`],
    ['a leading second segment', `${MEDIA_SCHEME}://original/x/${ID}`],
    ['a dot segment', `${MEDIA_SCHEME}://original/./${ID}`],
    ['a dot-dot segment', `${MEDIA_SCHEME}://original/../${ID}`],
    ['a dot-dot segment after a name', `${MEDIA_SCHEME}://original/x/../${ID}`],
    ['an encoded dot-dot segment', `${MEDIA_SCHEME}://original/%2E%2E/${ID}`],
    ['an encoded traversal', `${MEDIA_SCHEME}://original/..%2F..%2Fsecret`],
    ['an upper-case host', `${MEDIA_SCHEME}://ORIGINAL/${ID}`],
    ['credentials', `${MEDIA_SCHEME}://user:pw@original/${ID}`],
    ['a port', `${MEDIA_SCHEME}://original:8080/${ID}`],
    ['a non-UUID id', `${MEDIA_SCHEME}://original/not-a-uuid`],
    ['no id', `${MEDIA_SCHEME}://original/`],
    ['no path', `${MEDIA_SCHEME}://original`],
    ['host preview without query', `${MEDIA_SCHEME}://preview/${ID}`],
    ['host preview with a size', url(ID, 'full')],
    ['another scheme', `file://original/${ID}`],
    ['a file URL', 'file:///C:/x.png'],
    ['an empty string', ''],
  ])('rejects %s', (_, requestUrl) => {
    expect(parseOriginalUrl(requestUrl)).toBeNull();
  });

  it('treats the case of the id exactly like the preview parser', () => {
    const upper = ID.toUpperCase();
    expect(parseOriginalUrl(originalUrl(upper)) === null).toBe(parsePreviewUrl(url(upper)) === null);
  });
});

describe('PREVIEW_EDGE', () => {
  it('renders full at the edge up to which originals are served', () => {
    expect(PREVIEW_EDGE.full).toBe(ORIGINAL_MAX_EDGE);
  });
});

describe('openFile', () => {
  it('streams the whole file and reports its size', async () => {
    const opened = await openFile(originalPath);
    expect(opened.size).toBe(ORIGINAL.byteLength);
    expect(new Uint8Array(await new Response(opened.stream).arrayBuffer())).toEqual(ORIGINAL);
  });

  it('rejects for a missing file', async () => {
    await expect(openFile(join(base, 'missing.png'))).rejects.toThrow();
  });

  /** The handle `openFile` opened last; its `fd` is -1 once it is closed. */
  async function lastHandle(): Promise<FileHandle> {
    return vi.mocked(open).mock.results.at(-1)!.value as Promise<FileHandle>;
  }

  async function settled(handle: FileHandle): Promise<number> {
    for (let i = 0; i < 50 && handle.fd !== -1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    return handle.fd;
  }

  it('closes the handle when the stream ends', async () => {
    const opened = await openFile(originalPath);
    const handle = await lastHandle();
    expect(handle.fd).not.toBe(-1);
    await new Response(opened.stream).arrayBuffer();
    expect(await settled(handle)).toBe(-1);
  });

  it('closes the handle when the stream is cancelled', async () => {
    const opened = await openFile(originalPath);
    const handle = await lastHandle();
    const reader = opened.stream!.getReader();
    await reader.read();
    await reader.cancel();
    expect(await settled(handle)).toBe(-1);
  });

  it('rejects for a directory and leaves no handle open', async () => {
    const directory = join(base, 'folder');
    await mkdir(directory);
    const before = vi.mocked(open).mock.results.length;
    await expect(openFile(directory)).rejects.toThrow();
    // On Windows `open` may already refuse a directory; where it succeeds, the handle is closed again.
    const results = vi.mocked(open).mock.results.slice(before);
    expect(results).toHaveLength(1);
    const handle = await (results[0]!.value as Promise<FileHandle>).catch(() => null);
    if (handle !== null) expect(await settled(handle)).toBe(-1);
  });
});

describe('original route', () => {
  it.each(ORIGINAL_MIME_TYPES)('serves %s with the stored type, streamed', async (mimeType) => {
    const readSpy = vi.fn((path: string): Promise<Uint8Array> => readFile(path));
    const response = await handleMediaRequest(
      { url: originalUrl(ID), method: 'GET' },
      fakeDeps({ findOriginal: async () => ({ absolutePath: originalPath, mimeType }), readFile: readSpy }),
    );
    expect(response.body).toBeInstanceOf(ReadableStream);
    const seen = await inspect(response);
    expect(seen.status).toBe(200);
    expect(seen.headers).toEqual([
      ['cache-control', 'no-store'],
      ['content-length', String(ORIGINAL.byteLength)],
      ['content-type', mimeType],
      ['x-content-type-options', 'nosniff'],
    ]);
    expect(seen.body).toEqual(ORIGINAL);
    expect(readSpy).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('a type outside the allow-list answers 404 even when a lookup returns it', async () => {
    const findOriginal = async () =>
      ({ absolutePath: originalPath, mimeType: 'text/html' }) as unknown as OriginalSource;
    const open = vi.fn(openFile);
    await expectBare404(
      await handleMediaRequest({ url: originalUrl(ID), method: 'GET' }, fakeDeps({ findOriginal, openFile: open })),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('non-GET requests answer 404', async () => {
    const findOriginal = vi.fn(fakeDeps().findOriginal);
    for (const method of ['POST', 'HEAD', 'PUT']) {
      await expectBare404(await handleMediaRequest({ url: originalUrl(ID), method }, fakeDeps({ findOriginal })));
    }
    expect(findOriginal).not.toHaveBeenCalled();
  });

  it('no original answers 404 without opening anything', async () => {
    const open = vi.fn(openFile);
    await expectBare404(
      await handleMediaRequest(
        { url: originalUrl(ID), method: 'GET' },
        fakeDeps({ findOriginal: async () => null, openFile: open }),
      ),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('a failing lookup answers 404', async () => {
    const findOriginal = async (): Promise<OriginalSource> => {
      throw new StorageUnreachableError('The storage of this workspace is not reachable');
    };
    const seen = await expectBare404(
      await handleMediaRequest({ url: originalUrl(ID), method: 'GET' }, fakeDeps({ findOriginal })),
    );
    expect(seen.headers).toEqual([]);
  });

  it('a file that cannot be opened answers 404', async () => {
    await rm(originalPath);
    const seen = await expectBare404(await handleMediaRequest({ url: originalUrl(ID), method: 'GET' }, fakeDeps()));
    expect(seen.headers).toEqual([]);
    expect(plainText(seen)).not.toContain(base);
  });

  it('a directory in place of the file answers 404', async () => {
    await rm(originalPath);
    await mkdir(originalPath);
    const seen = await expectBare404(await handleMediaRequest({ url: originalUrl(ID), method: 'GET' }, fakeDeps()));
    expect(seen.headers).toEqual([]);
  });

  it('an unreachable storage while opening answers 404', async () => {
    const failingOpen = async (): Promise<never> => {
      throw new StorageUnreachableError('The storage of this workspace is not reachable');
    };
    const seen = await expectBare404(
      await handleMediaRequest({ url: originalUrl(ID), method: 'GET' }, fakeDeps({ openFile: failingOpen })),
    );
    expect(seen.headers).toEqual([]);
  });

  it('serves an imported png with stored dimensions, and refuses it above the edge limit', async () => {
    const file = await importFile('pump.png', 'png bytes');
    expect(file.width).toBeNull();
    await expectBare404(await handleMediaRequest({ url: originalUrl(file.id), method: 'GET' }, realDeps()));
    await manager.exclusive((s) => s.database.files.setDimensions(file.id, { width: 4, height: 3 }));
    const seen = await inspect(await handleMediaRequest({ url: originalUrl(file.id), method: 'GET' }, realDeps()));
    expect(seen.status).toBe(200);
    expect(seen.headers).toContainEqual(['content-type', 'image/png']);
    expect(Buffer.from(seen.body).toString()).toBe('png bytes');
    await manager.exclusive((s) => s.database.files.setDimensions(file.id, { width: 9000, height: 10 }));
    await expectBare404(await handleMediaRequest({ url: originalUrl(file.id), method: 'GET' }, realDeps()));
  });

  it('no open workspace answers 404', async () => {
    await expectBare404(await handleMediaRequest({ url: originalUrl(ID), method: 'GET' }, realDeps()));
  });
});

describe('full route', () => {
  it('serves the lossless rendition as png without caching, streamed', async () => {
    const readSpy = vi.fn((path: string): Promise<Uint8Array> => readFile(path));
    const response = await handleMediaRequest({ url: url(ID, 'full'), method: 'GET' }, fakeDeps({ readFile: readSpy }));
    expect(response.body).toBeInstanceOf(ReadableStream);
    const seen = await inspect(response);
    expect(seen.status).toBe(200);
    expect(seen.headers).toEqual([
      ['cache-control', 'no-store'],
      ['content-length', String(PNG.byteLength)],
      ['content-type', 'image/png'],
    ]);
    expect(seen.body).toEqual(PNG);
    expect(get).toHaveBeenCalledWith({ sha256: SHA, sourcePath: join(root, 'x.png'), size: 'full' });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('no rendition answers 404', async () => {
    get.mockResolvedValue(null);
    await expectBare404(await handleMediaRequest({ url: url(ID, 'full'), method: 'GET' }, fakeDeps()));
  });

  it('a rendition removed before it is opened answers 404', async () => {
    await rm(fullPath);
    const seen = await expectBare404(await handleMediaRequest({ url: url(ID, 'full'), method: 'GET' }, fakeDeps()));
    expect(seen.headers).toEqual([]);
    expect(plainText(seen)).not.toContain(cacheDir);
  });

  it('thumb is still read whole and cached long', async () => {
    const open = vi.fn(openFile);
    const seen = await inspect(await handleMediaRequest({ url: url(ID), method: 'GET' }, fakeDeps({ openFile: open })));
    expect(seen.headers).toEqual([
      ['cache-control', 'private, max-age=31536000'],
      ['content-type', 'image/webp'],
    ]);
    expect(seen.body).toEqual(WEBP);
    expect(open).not.toHaveBeenCalled();
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

  it('serves the preview and the original of a trashed file', async () => {
    const file = await importFile('pump.png', 'png bytes');
    await manager.exclusive((s) => s.database.files.setDimensions(file.id, { width: 4, height: 3 }));
    const [item] = await manager.exclusive((s) =>
      trashFiles(s, { wake: () => {}, cancel: async () => {}, cancelAll: async () => 0 }, [file.id]),
    );
    expect(item!.error).toBeNull();

    const seen = await inspect(await handleMediaRequest({ url: url(file.id), method: 'GET' }, realDeps()));
    expect(seen.status).toBe(200);
    expect(seen.body).toEqual(WEBP);
    expect(get.mock.calls[0]![0].sourcePath).toBe(join(root, trashPath(file.id, 'pump.png')));

    const original = await inspect(await handleMediaRequest({ url: originalUrl(file.id), method: 'GET' }, realDeps()));
    expect(original.status).toBe(200);
    expect(Buffer.from(original.body).toString()).toBe('png bytes');
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
    const unreachable = async (): Promise<never> => {
      throw new StorageUnreachableError('The storage of this workspace is not reachable');
    };
    const failingRead = async (path: string): Promise<Uint8Array> => {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
    };
    const failingOpen = async (path: string): Promise<never> => {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
    };
    const cases: [{ url: string; method: string }, MediaProtocolDependencies][] = [
      [{ url: url(file.id), method: 'GET' }, realDeps()],
      [{ url: url(ID), method: 'GET' }, realDeps()],
      [{ url: url(file.id), method: 'POST' }, realDeps()],
      [{ url: `${MEDIA_SCHEME}://preview/${ID}?size=thumb&path=${root}`, method: 'GET' }, realDeps()],
      [{ url: url(ID), method: 'GET' }, fakeDeps({ findSource: unreachable })],
      [{ url: url(ID), method: 'GET' }, fakeDeps({ previews: { get: async () => null } })],
      [{ url: url(ID), method: 'GET' }, fakeDeps({ readFile: failingRead })],
      [{ url: `${MEDIA_SCHEME}://original/${file.id}`, method: 'GET' }, realDeps()],
      [{ url: `${MEDIA_SCHEME}://original/${ID}`, method: 'GET' }, fakeDeps({ findOriginal: unreachable })],
      [{ url: `${MEDIA_SCHEME}://original/${ID}`, method: 'GET' }, fakeDeps({ openFile: failingOpen })],
      [{ url: url(ID, 'full'), method: 'GET' }, fakeDeps({ openFile: failingOpen })],
    ];
    const roots = [root, cacheDir, root.replaceAll('\\', '/'), cacheDir.replaceAll('\\', '/')];
    for (const [request, deps] of cases) {
      const seen = await inspect(await handleMediaRequest(request, deps));
      const text = plainText(seen);
      for (const path of roots) expect(text).not.toContain(path);
    }
  });
});
