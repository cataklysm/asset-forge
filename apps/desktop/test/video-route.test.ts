import { mkdir, mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `open` is wrapped (not replaced) so a test can see the handle `openFile` used, its reads and whether it closed.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
import {
  StorageUnreachableError,
  trashFiles,
  type PreviewSource,
  type VideoSource,
  type WorkspaceManager,
} from '@assetforge/core';
import type { PreviewRequest } from '@assetforge/media';
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
import { MEDIA_SCHEME, parseVideoUrl } from '../src/main/media-routes.js';

const ID = '0b6c2f0e-3f7a-4c1d-9e2b-5a8d7c6b4e3f';
const SHA = 'a'.repeat(64);
const SIZE = 1000;
const VIDEO = new Uint8Array(SIZE).map((_, i) => (i * 37 + 11) % 256);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

let base: string;
let root: string;
let videoPath: string;
let cachedPath: string;
let manager: WorkspaceManager;
const get = vi.fn<(request: PreviewRequest) => Promise<string | null>>();

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-video-'));
  root = join(base, 'workspace');
  videoPath = join(base, 'clip.mp4');
  await writeFile(videoPath, VIDEO);
  cachedPath = join(base, 'thumb.webp');
  await writeFile(cachedPath, WEBP);
  get.mockReset().mockResolvedValue(cachedPath);
  manager = createWorkspaceManager({ userDataPath: join(base, 'userData'), migrationsFolder: MIGRATIONS_FOLDER });
});
afterEach(async () => {
  await manager.close();
  await rm(base, { recursive: true, force: true });
});

function videoUrl(fileId: string): string {
  return `${MEDIA_SCHEME}://video/${fileId}`;
}

function fakeDeps(overrides: Partial<MediaProtocolDependencies> = {}): MediaProtocolDependencies {
  return {
    findSource: async (): Promise<PreviewSource> => ({ sha256: SHA, absolutePath: videoPath, video: 'mp4' }),
    findOriginal: async () => null,
    findVideo: async (): Promise<VideoSource> => ({ absolutePath: videoPath, mimeType: 'video/mp4' }),
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

function request(range?: string, url = videoUrl(ID), method = 'GET') {
  return { url, method, headers: new Headers(range === undefined ? {} : { Range: range }) };
}

async function inspect(response: Response) {
  const body = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, headers: [...response.headers.entries()], body };
}

async function expectBare404(response: Response) {
  const seen = await inspect(response);
  expect(seen.status).toBe(404);
  expect(seen.body.byteLength).toBe(0);
  expect(seen.headers.filter(([name]) => name !== 'content-length')).toEqual([]);
  return seen;
}

function okHeaders(length: number, mimeType = 'video/mp4'): [string, string][] {
  return [
    ['accept-ranges', 'bytes'],
    ['cache-control', 'no-store'],
    ['content-length', String(length)],
    ['content-type', mimeType],
    ['x-content-type-options', 'nosniff'],
  ];
}

/** The handle `openFile` opened last; its `fd` is -1 once it is closed. */
async function lastHandle(): Promise<FileHandle> {
  return vi.mocked(open).mock.results.at(-1)!.value as Promise<FileHandle>;
}

async function settled(handle: FileHandle): Promise<number> {
  for (let i = 0; i < 100 && handle.fd !== -1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  return handle.fd;
}

/** Makes the next `open` record every read of its handle as [position, bytesRead]. */
function recordReads(): [number, number][] {
  const reads: [number, number][] = [];
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const handle = await actual.open(...args);
    const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
    (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
      const result = await read(...a);
      const position = typeof a[3] === 'number' || typeof a[3] === 'bigint' ? Number(a[3]) : -1;
      reads.push([position, result.bytesRead]);
      return result;
    };
    return handle;
  });
  return reads;
}

describe('parseVideoUrl', () => {
  it('reads the file id from a video URL', () => {
    expect(parseVideoUrl(videoUrl(ID))).toEqual({ fileId: ID });
  });

  it.each([
    ['a query', `${MEDIA_SCHEME}://video/${ID}?size=full`],
    ['an empty query', `${MEDIA_SCHEME}://video/${ID}?`],
    ['an empty fragment', `${MEDIA_SCHEME}://video/${ID}#`],
    ['a trailing slash', `${MEDIA_SCHEME}://video/${ID}/`],
    ['a second segment', `${MEDIA_SCHEME}://video/${ID}/x`],
    ['a dot-dot segment', `${MEDIA_SCHEME}://video/x/../${ID}`],
    ['an encoded traversal', `${MEDIA_SCHEME}://video/..%2F..%2Fsecret`],
    ['an upper-case host', `${MEDIA_SCHEME}://VIDEO/${ID}`],
    ['credentials', `${MEDIA_SCHEME}://user:pw@video/${ID}`],
    ['a port', `${MEDIA_SCHEME}://video:8080/${ID}`],
    ['a non-UUID id', `${MEDIA_SCHEME}://video/not-a-uuid`],
    ['the original host', `${MEDIA_SCHEME}://original/${ID}`],
    ['another scheme', `file://video/${ID}`],
  ])('rejects %s', async (_, url) => {
    expect(parseVideoUrl(url)).toBeNull();
    const findVideo = vi.fn(fakeDeps().findVideo);
    const findOriginal = vi.fn(fakeDeps().findOriginal);
    await expectBare404(await handleMediaRequest(request(undefined, url), fakeDeps({ findVideo, findOriginal })));
    expect(findVideo).not.toHaveBeenCalled();
  });
});

describe('video route without a range', () => {
  it.each(['video/mp4', 'video/webm'])('serves the whole %s file as a stream', async (mimeType) => {
    const readSpy = vi.fn((path: string): Promise<Uint8Array> => readFile(path));
    const response = await handleMediaRequest(
      request(),
      fakeDeps({ findVideo: async () => ({ absolutePath: videoPath, mimeType }), readFile: readSpy }),
    );
    expect(response.body).toBeInstanceOf(ReadableStream);
    const seen = await inspect(response);
    expect(seen.status).toBe(200);
    expect(seen.headers).toEqual(okHeaders(SIZE, mimeType));
    expect(seen.body).toEqual(VIDEO);
    expect(readSpy).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('works without any headers object', async () => {
    const seen = await inspect(await handleMediaRequest({ url: videoUrl(ID), method: 'GET' }, fakeDeps()));
    expect(seen.status).toBe(200);
    expect(seen.body).toEqual(VIDEO);
  });

  it.each(['bytes=0-1,5-6', 'bytes=0-1, 5-6', 'bytes=-5,0-1', 'bytes=0-1,x'])(
    'answers several ranges (%s) as if there were none',
    async (range) => {
      const seen = await inspect(await handleMediaRequest(request(range), fakeDeps()));
      expect(seen.status).toBe(200);
      expect(seen.headers).toEqual(okHeaders(SIZE));
      expect(seen.body).toEqual(VIDEO);
    },
  );

  it('serves an empty file', async () => {
    await writeFile(videoPath, new Uint8Array(0));
    const seen = await inspect(await handleMediaRequest(request(), fakeDeps()));
    expect(seen.status).toBe(200);
    expect(seen.headers).toEqual(okHeaders(0));
    expect(seen.body.byteLength).toBe(0);
  });
});

describe('video route with one range', () => {
  it.each([
    ['bytes=0-99', 0, 99],
    ['bytes=0-0', 0, 0],
    ['bytes=999-999', 999, 999],
    ['bytes=900-', 900, 999],
    ['bytes=0-', 0, 999],
    ['bytes=-100', 900, 999],
    ['bytes=-1', 999, 999],
    ['bytes=-5000', 0, 999],
    ['bytes=990-5000', 990, 999],
    ['bytes=250-749', 250, 749],
    ['BYTES=10-19', 10, 19],
  ])('%s answers 206 with exactly the bytes %i to %i', async (range, start, end) => {
    const reads = recordReads();
    const response = await handleMediaRequest(request(range), fakeDeps());
    expect(response.body).toBeInstanceOf(ReadableStream);
    const seen = await inspect(response);
    expect(seen.status).toBe(206);
    expect(seen.headers).toEqual([
      ['accept-ranges', 'bytes'],
      ['cache-control', 'no-store'],
      ['content-length', String(end - start + 1)],
      ['content-range', `bytes ${start}-${end}/${SIZE}`],
      ['content-type', 'video/mp4'],
      ['x-content-type-options', 'nosniff'],
    ]);
    expect(seen.body).toEqual(VIDEO.slice(start, end + 1));
    expect(reads.length).toBeGreaterThan(0);
    for (const [position, bytesRead] of reads) {
      expect(position).toBeGreaterThanOrEqual(start);
      expect(position + bytesRead).toBeLessThanOrEqual(end + 1);
    }
    expect(await settled(await lastHandle())).toBe(-1);
  });
});

describe('video route with an unsatisfiable or malformed range', () => {
  it.each([
    'bytes=1000-',
    'bytes=1000-1000',
    'bytes=5000-6000',
    'bytes=-0',
    'bytes=5-4',
    'bytes=',
    'bytes=-',
    'bytes=abc',
    'bytes=0-1-2',
    'bytes= 0-1',
    'bytes=0 -1',
    'bytes=+1-2',
    'bytes=1.5-2',
    'bytes=0x10-20',
    'bytes=99999999999999999999-',
    'bytes=-99999999999999999999',
    'items=0-1',
    '0-1',
    '',
  ])('%j answers 416 with the size and no body', async (range) => {
    const response = await handleMediaRequest(request(range), fakeDeps());
    const seen = await inspect(response);
    expect(seen.status).toBe(416);
    expect(seen.body.byteLength).toBe(0);
    expect(seen.headers.filter(([name]) => name !== 'content-length')).toEqual([['content-range', `bytes */${SIZE}`]]);
    expect(await settled(await lastHandle())).toBe(-1);
  });

  it('answers 416 for any range on an empty file', async () => {
    await writeFile(videoPath, new Uint8Array(0));
    for (const range of ['bytes=0-', 'bytes=0-0', 'bytes=-1']) {
      const seen = await inspect(await handleMediaRequest(request(range), fakeDeps()));
      expect(seen.status).toBe(416);
      expect(seen.headers.filter(([name]) => name !== 'content-length')).toEqual([['content-range', 'bytes */0']]);
    }
  });
});

describe('video route on a file of several GiB', () => {
  const LARGE = 3 * 1024 ** 3 + 123;
  let largeDir: string;
  let largePath: string;

  // Only the size is set, nothing is written: the file system answers zeros without filling the disk.
  beforeAll(async () => {
    largeDir = await mkdtemp(join(tmpdir(), 'af-video-large-'));
    largePath = join(largeDir, 'large.mp4');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const handle = await actual.open(largePath, 'w');
    try {
      await handle.truncate(LARGE);
    } finally {
      await handle.close();
    }
  });
  afterAll(async () => {
    await rm(largeDir, { recursive: true, force: true });
  });

  function largeDeps(): MediaProtocolDependencies {
    return fakeDeps({ findVideo: async () => ({ absolutePath: largePath, mimeType: 'video/mp4' }) });
  }

  it('bytes=0- answers 206 at once, reads only what is consumed and closes the handle on cancel', async () => {
    const reads = recordReads();
    const response = await handleMediaRequest(request('bytes=0-'), largeDeps());
    expect(response.status).toBe(206);
    expect(response.headers.get('content-length')).toBe(String(LARGE));
    expect(response.headers.get('content-range')).toBe(`bytes 0-${LARGE - 1}/${LARGE}`);
    const handle = await lastHandle();
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    expect(await settled(handle)).toBe(-1);
    const total = reads.reduce((sum, [, bytesRead]) => sum + bytesRead, 0);
    expect(total).toBeLessThan(16 * 1024 * 1024);
  });

  it('a range beyond 2 GiB reads only the asked bytes', async () => {
    const reads = recordReads();
    const start = 2 ** 31;
    const seen = await inspect(await handleMediaRequest(request(`bytes=${start}-${start + 3}`), largeDeps()));
    expect(seen.status).toBe(206);
    expect(seen.headers).toContainEqual(['content-range', `bytes ${start}-${start + 3}/${LARGE}`]);
    expect(seen.body).toEqual(new Uint8Array(4));
    for (const [position, bytesRead] of reads) {
      expect(position).toBeGreaterThanOrEqual(start);
      expect(position + bytesRead).toBeLessThanOrEqual(start + 4);
    }
  });

  it('a suffix range serves the end of the file', async () => {
    const seen = await inspect(await handleMediaRequest(request('bytes=-4'), largeDeps()));
    expect(seen.status).toBe(206);
    expect(seen.headers).toContainEqual(['content-range', `bytes ${LARGE - 4}-${LARGE - 1}/${LARGE}`]);
    expect(seen.body).toEqual(new Uint8Array(4));
  });
});

describe('video route failures', () => {
  it('a type outside the allow-list answers 404 without opening anything', async () => {
    const opener = vi.fn(openFile);
    for (const mimeType of ['image/png', 'text/html', 'video/quicktime']) {
      await expectBare404(
        await handleMediaRequest(
          request(),
          fakeDeps({ findVideo: async () => ({ absolutePath: videoPath, mimeType }), openFile: opener }),
        ),
      );
    }
    expect(opener).not.toHaveBeenCalled();
  });

  it('no video answers 404 without opening anything', async () => {
    const opener = vi.fn(openFile);
    await expectBare404(
      await handleMediaRequest(request('bytes=0-'), fakeDeps({ findVideo: async () => null, openFile: opener })),
    );
    expect(opener).not.toHaveBeenCalled();
  });

  it('non-GET requests answer 404', async () => {
    const findVideo = vi.fn(fakeDeps().findVideo);
    for (const method of ['POST', 'HEAD', 'PUT']) {
      await expectBare404(await handleMediaRequest(request(undefined, videoUrl(ID), method), fakeDeps({ findVideo })));
    }
    expect(findVideo).not.toHaveBeenCalled();
  });

  it('a failing lookup, a missing file or a directory answer 404 without a path', async () => {
    const unreachable = async (): Promise<never> => {
      throw new StorageUnreachableError('The storage of this workspace is not reachable');
    };
    const directory = join(base, 'folder.mp4');
    await mkdir(directory);
    const cases: MediaProtocolDependencies[] = [
      fakeDeps({ findVideo: unreachable }),
      fakeDeps({ findVideo: async () => ({ absolutePath: join(base, 'missing.mp4'), mimeType: 'video/mp4' }) }),
      fakeDeps({ findVideo: async () => ({ absolutePath: directory, mimeType: 'video/mp4' }) }),
    ];
    for (const deps of cases) {
      for (const range of [undefined, 'bytes=0-1', 'bytes=x']) {
        const seen = await expectBare404(await handleMediaRequest(request(range), deps));
        expect(Buffer.from(seen.body).toString()).not.toContain(base);
      }
    }
  });
});

describe('video route against a workspace', () => {
  async function importFile(name: string, content: Uint8Array | string) {
    await manager.create({ name: 'Test', rootPath: root });
    const source = join(base, name);
    await writeFile(source, content);
    const [result] = await manager.importFiles([source]);
    return result!.file!;
  }

  it('serves an imported mp4 with ranges, also from the trash', async () => {
    const file = await importFile('walk.mp4', VIDEO);
    expect(file.mimeType).toBe('video/mp4');
    const whole = await inspect(await handleMediaRequest(request(undefined, videoUrl(file.id)), realDeps()));
    expect(whole.status).toBe(200);
    expect(whole.headers).toEqual(okHeaders(SIZE));
    expect(whole.body).toEqual(VIDEO);

    await manager.exclusive((s) =>
      trashFiles(s, { wake: () => {}, cancel: async () => {}, cancelAll: async () => 0 }, [file.id]),
    );
    const part = await inspect(await handleMediaRequest(request('bytes=10-19', videoUrl(file.id)), realDeps()));
    expect(part.status).toBe(206);
    expect(part.body).toEqual(VIDEO.slice(10, 20));
  });

  it('serves a webm with its type', async () => {
    const file = await importFile('walk.webm', VIDEO);
    const seen = await inspect(await handleMediaRequest(request(undefined, videoUrl(file.id)), realDeps()));
    expect(seen.headers).toContainEqual(['content-type', 'video/webm']);
  });

  it('never serves an image or a document through the video route', async () => {
    const image = await importFile('pump.png', 'png bytes');
    await expectBare404(await handleMediaRequest(request(undefined, videoUrl(image.id)), realDeps()));
    const source = join(base, 'notes.pdf');
    await writeFile(source, 'pdf');
    const [document] = await manager.importFiles([source]);
    await expectBare404(await handleMediaRequest(request(undefined, videoUrl(document!.file!.id)), realDeps()));
  });

  it('never serves a video through the original route, even with dimensions', async () => {
    const file = await importFile('walk.mp4', VIDEO);
    await manager.exclusive((s) => s.database.files.setDimensions(file.id, { width: 4, height: 3 }));
    await expectBare404(
      await handleMediaRequest(request(undefined, `${MEDIA_SCHEME}://original/${file.id}`), realDeps()),
    );
  });

  it('hands a video to the preview service with its format, never as an image', async () => {
    const file = await importFile('walk.mp4', VIDEO);
    const seen = await inspect(
      await handleMediaRequest(request(undefined, `${MEDIA_SCHEME}://preview/${file.id}?size=thumb`), realDeps()),
    );
    expect(seen.status).toBe(200);
    expect(seen.headers).toEqual([
      ['cache-control', 'private, max-age=31536000'],
      ['content-type', 'image/webp'],
    ]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![0]).toMatchObject({ sha256: file.sha256, size: 'thumb', video: 'mp4' });
  });

  it('a video without a full rendition answers 404 on the full preview', async () => {
    get.mockResolvedValue(null);
    const file = await importFile('walk.webm', VIDEO);
    await expectBare404(
      await handleMediaRequest(request(undefined, `${MEDIA_SCHEME}://preview/${file.id}?size=full`), realDeps()),
    );
    expect(get.mock.calls[0]![0]).toMatchObject({ size: 'full', video: 'webm' });
  });

  it('an image preview request carries no video field', async () => {
    const file = await importFile('pump.png', 'png bytes');
    await handleMediaRequest(request(undefined, `${MEDIA_SCHEME}://preview/${file.id}?size=detail`), realDeps());
    expect(get.mock.calls[0]![0]).not.toHaveProperty('video');
  });

  it('no open workspace answers 404', async () => {
    await expectBare404(await handleMediaRequest(request(), realDeps()));
  });
});
