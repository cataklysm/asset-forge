import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PathEscapeError, StorageAccessDeniedError, StorageFullError } from '@assetforge/core';
import { LocalFileSystemStorage } from '../src/index.js';

const HELLO_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

let tmp: string;
let root: string;
let storage: LocalFileSystemStorage;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'af-storage-'));
  root = path.join(tmp, 'ws');
  storage = new LocalFileSystemStorage(root);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('layout', () => {
  it('creates the layout directories', async () => {
    expect(await storage.isEmptyOrMissing()).toBe(true);
    await storage.ensureLayout();
    for (const d of ['assets', 'inbox', 'exports', '.assetforge/staging']) {
      expect((await fs.stat(path.join(root, d))).isDirectory()).toBe(true);
    }
    expect(await storage.isEmptyOrMissing()).toBe(false);
  });

  it('reports a root below a missing parent as unreachable', async () => {
    const s = new LocalFileSystemStorage(path.join(tmp, 'missing-parent', 'ws'));
    expect(await s.isReachable()).toBe(false);
  });

  it('reports existing and creatable roots as reachable', async () => {
    expect(await storage.isReachable()).toBe(true);
    await storage.ensureLayout();
    expect(await storage.isReachable()).toBe(true);
  });
});

describe('files', () => {
  beforeEach(async () => {
    await storage.ensureLayout();
  });

  it('writes a stream and hashes it', async () => {
    const r = await storage.writeStream('inbox/a.txt', Readable.from(Buffer.from('hello')));
    expect(r).toEqual({ sizeBytes: 5, sha256: HELLO_SHA });
    expect(await storage.hashFile('inbox/a.txt')).toBe(HELLO_SHA);
  });

  it('reports the cumulative bytes written, ending at the file size', async () => {
    const reported: number[] = [];
    const source = Readable.from([Buffer.from('he'), Buffer.from('l'), Buffer.from('lo')]);
    const r = await storage.writeStream('inbox/a.txt', source, { onProgress: (bytes) => reported.push(bytes) });
    expect(r).toEqual({ sizeBytes: 5, sha256: HELLO_SHA });
    expect(reported).toEqual([2, 3, 5]);
  });

  it('writes the file with its size and hash when onProgress throws', async () => {
    const onProgress = vi.fn(() => {
      throw new Error('observer failed');
    });
    const source = Readable.from([Buffer.from('he'), Buffer.from('llo')]);
    const r = await storage.writeStream('inbox/a.txt', source, { onProgress });
    expect(r).toEqual({ sizeBytes: 5, sha256: HELLO_SHA });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(await storage.hashFile('inbox/a.txt')).toBe(HELLO_SHA);
  });

  it('writes the same file with an empty options object', async () => {
    const r = await storage.writeStream('inbox/a.txt', Readable.from(Buffer.from('hello')), {});
    expect(r).toEqual({ sizeBytes: 5, sha256: HELLO_SHA });
  });

  it('rejects writing to an existing path and keeps its content', async () => {
    await storage.writeText('inbox/a.txt', 'original');
    await expect(
      storage.writeStream('inbox/a.txt', Readable.from(Buffer.from('new'))),
    ).rejects.toThrow();
    expect(await storage.readText('inbox/a.txt')).toBe('original');
  });

  it('removes the partial file when the source errors midway', async () => {
    async function* broken() {
      yield Buffer.from('part');
      throw new Error('boom');
    }
    await expect(storage.writeStream('inbox/b.txt', Readable.from(broken()))).rejects.toThrow('boom');
    expect(await storage.exists('inbox/b.txt')).toBe(false);
  });

  it('moves files and rejects when the target exists', async () => {
    await storage.writeText('inbox/a.txt', 'A');
    await storage.writeText('inbox/b.txt', 'B');
    await expect(storage.move('inbox/a.txt', 'inbox/b.txt')).rejects.toThrow();
    expect(await storage.readText('inbox/a.txt')).toBe('A');
    expect(await storage.readText('inbox/b.txt')).toBe('B');
    await storage.move('inbox/a.txt', 'assets/sub/c.txt');
    expect(await storage.readText('assets/sub/c.txt')).toBe('A');
    expect(await storage.exists('inbox/a.txt')).toBe(false);
  });

  it('reads missing text as null and round-trips text atomically', async () => {
    expect(await storage.readText('workspace.json')).toBeNull();
    await storage.writeText('workspace.json', '{"a":1}');
    await storage.writeText('workspace.json', '{"a":2}');
    expect(await storage.readText('workspace.json')).toBe('{"a":2}');
    const names = await storage.list('.');
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('removes idempotently and lists missing dirs as empty', async () => {
    await storage.remove('inbox/missing.txt');
    expect(await storage.list('nope')).toEqual([]);
    await storage.writeText('inbox/a.txt', 'A');
    expect(await storage.list('inbox')).toEqual(['a.txt']);
    await storage.remove('inbox/a.txt');
    expect(await storage.exists('inbox/a.txt')).toBe(false);
  });
});

describe('flush before commit', () => {
  // Durability itself cannot be unit-tested; these only check that a flush is requested.
  let syncSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await storage.ensureLayout();
    const probe = await fs.open(path.join(tmp, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as fs.FileHandle;
    await probe.close();
    syncSpy = vi.spyOn(proto, 'sync');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('flushes a streamed file before writeStream resolves', async () => {
    await storage.writeStream('inbox/a.txt', Readable.from(Buffer.from('hello')));
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it('flushes the temp file of an atomic text write', async () => {
    await storage.writeText('workspace.json', '{}');
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });
});

describe('file-system error mapping', () => {
  beforeEach(async () => {
    await storage.ensureLayout();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const errno = (code: string, target: string) =>
    Object.assign(new Error(`${code}: operation failed, open '${target}'`), { code });

  it.skipIf(process.platform !== 'win32')(
    'maps a real EPERM (rename over a read-only file on Windows) to StorageAccessDeniedError',
    async () => {
      await storage.writeText('workspace.json', 'original');
      await fs.chmod(path.join(root, 'workspace.json'), 0o444);
      try {
        const error = await storage.writeText('workspace.json', 'new').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(StorageAccessDeniedError);
        expect((error as StorageAccessDeniedError).code).toBe('storage_access_denied');
        expect((error as Error).message).not.toContain(tmp);
        expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('EPERM');
        expect(await storage.readText('workspace.json')).toBe('original');
        expect((await storage.list('.')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
      } finally {
        await fs.chmod(path.join(root, 'workspace.json'), 0o666);
      }
    },
  );

  for (const code of ['EACCES', 'EPERM', 'EROFS']) {
    it(`maps ${code} to StorageAccessDeniedError without an absolute path`, async () => {
      const cause = errno(code, path.join(root, 'inbox'));
      vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(cause);
      const error = await storage.ensureLayout().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageAccessDeniedError);
      expect((error as Error).cause).toBe(cause);
      expect((error as Error).message).not.toContain(tmp);
    });
  }

  it('maps ENOSPC to StorageFullError with the relative path', async () => {
    const cause = errno('ENOSPC', path.join(root, 'inbox', 'a.txt'));
    vi.spyOn(fs, 'open').mockRejectedValueOnce(cause);
    const error = await storage
      .writeStream('inbox/a.txt', Readable.from(Buffer.from('x')))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageFullError);
    expect((error as StorageFullError).code).toBe('storage_full');
    expect((error as Error).cause).toBe(cause);
    expect((error as Error).message).toContain('inbox/a.txt');
    expect((error as Error).message).not.toContain(tmp);
  });

  it('maps ENOSPC from the atomic text write', async () => {
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(errno('ENOSPC', path.join(root, 'x')));
    await expect(storage.writeText('workspace.json', 'x')).rejects.toBeInstanceOf(StorageFullError);
  });

  it('passes other errors through unchanged', async () => {
    const cause = errno('EBUSY', path.join(root, 'inbox', 'a.txt'));
    await storage.writeText('inbox/a.txt', 'A');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(cause);
    await expect(storage.move('inbox/a.txt', 'inbox/b.txt')).rejects.toBe(cause);
  });

  it('does not attribute a failing source stream to the workspace storage', async () => {
    const cause = errno('EACCES', 'C:\\elsewhere\\source.png');
    async function* broken() {
      yield Buffer.from('part');
      throw cause;
    }
    await expect(storage.writeStream('inbox/b.txt', Readable.from(broken()))).rejects.toBe(cause);
    expect(await storage.exists('inbox/b.txt')).toBe(false);
  });

  describe('destination failing mid-stream', () => {
    let proto: fs.FileHandle;
    beforeEach(async () => {
      const probe = await fs.open(path.join(tmp, 'probe'), 'w');
      proto = Object.getPrototypeOf(probe) as fs.FileHandle;
      await probe.close();
    });

    // A plain Readable emits 'error' when the pipeline destroys it because of a destination failure.
    const pushing = (text: string) =>
      new Readable({
        read() {
          this.push(Buffer.from(text));
          this.push(null);
        },
      });

    const failDestination = (code: string) => {
      const reject = () => Promise.reject(Object.assign(new Error('x'), { code }));
      vi.spyOn(proto, 'write').mockImplementation(reject);
      vi.spyOn(proto, 'writev').mockImplementation(reject);
    };

    it('maps ENOSPC raised by the destination mid-stream to StorageFullError', async () => {
      failDestination('ENOSPC');
      const error = await storage
        .writeStream('inbox/a.txt', pushing('hello'))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageFullError);
      expect((error as Error).message).not.toContain(tmp);
      vi.restoreAllMocks();
      expect(await storage.exists('inbox/a.txt')).toBe(false);
    });

    it('maps EACCES raised by the destination mid-stream to StorageAccessDeniedError', async () => {
      failDestination('EACCES');
      const error = await storage
        .writeStream('inbox/a.txt', pushing('hello'))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageAccessDeniedError);
    });

    it("still rejects with the source's own error when the source fails", async () => {
      const cause = new Error('source broke');
      const source = new Readable({ read() {} });
      const result = storage.writeStream('inbox/a.txt', source);
      source.destroy(cause);
      await expect(result).rejects.toBe(cause);
    });

    it('destroys the source when the target cannot be opened', async () => {
      await storage.writeText('inbox/a.txt', 'original');
      const source = new Readable({ read() {} });
      await expect(storage.writeStream('inbox/a.txt', source)).rejects.toThrow();
      expect(source.destroyed).toBe(true);
    });
  });
});

describe('path escape', () => {
  beforeEach(async () => {
    await storage.ensureLayout();
  });

  const bad: Array<[string, string]> = [
    ['parent segment', '../x'],
    ['nested parent segment', 'inbox/../../x'],
    ['backslash parent segment', 'inbox\\..\\..\\x'],
    ['leading backslash parent', '..\\x'],
    ['posix absolute', '/etc/passwd'],
    ['drive letter', 'C:/Windows/x'],
    ['drive letter backslash', 'C:\\Windows\\x'],
    ['drive relative', 'C:x'],
    ['UNC', '\\\\server\\share\\x'],
    ['UNC forward', '//server/share/x'],
  ];

  for (const [label, p] of bad) {
    it(`rejects ${label}`, async () => {
      await expect(storage.readText(p)).rejects.toBeInstanceOf(PathEscapeError);
      await expect(storage.writeText(p, 'x')).rejects.toBeInstanceOf(PathEscapeError);
      await expect(storage.exists(p)).rejects.toBeInstanceOf(PathEscapeError);
    });
  }

  it('rejects an absolute path that points inside the root', async () => {
    await expect(storage.readText(path.join(root, 'workspace.json'))).rejects.toBeInstanceOf(
      PathEscapeError,
    );
  });

  it('rejects a path that reduces to the root with a fixed message', async () => {
    for (const p of ['', '.', './/.']) {
      await expect(storage.readText(p)).rejects.toThrow(new PathEscapeError('Path resolves to the workspace root'));
    }
  });

  it('rejects both arguments of move', async () => {
    await storage.writeText('inbox/a.txt', 'A');
    await expect(storage.move('inbox/a.txt', '../x')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(storage.move('../x', 'inbox/b.txt')).rejects.toBeInstanceOf(PathEscapeError);
  });

  it('rejects a path through a junction that points outside the root', async () => {
    const outside = path.join(tmp, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(root, 'inbox', 'link'), 'junction');
    await expect(storage.readText('inbox/link/secret.txt')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(storage.writeText('inbox/link/new.txt', 'x')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(storage.list('inbox/link')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(storage.remove('inbox/link/secret.txt')).rejects.toBeInstanceOf(PathEscapeError);
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret');
  });

  for (const rootish of ['', '.', './']) {
    it(`rejects root-equivalent path ${JSON.stringify(rootish)} for file operations`, async () => {
      const before = (await fs.readdir(tmp)).sort();
      await expect(storage.readText(rootish)).rejects.toBeInstanceOf(PathEscapeError);
      await expect(storage.writeText(rootish, 'x')).rejects.toBeInstanceOf(PathEscapeError);
      await expect(
        storage.writeStream(rootish, Readable.from(Buffer.from('x'))),
      ).rejects.toBeInstanceOf(PathEscapeError);
      await expect(storage.hashFile(rootish)).rejects.toBeInstanceOf(PathEscapeError);
      await expect(storage.remove(rootish)).rejects.toBeInstanceOf(PathEscapeError);
      await expect(storage.move(rootish, 'inbox/x')).rejects.toBeInstanceOf(PathEscapeError);
      await expect(storage.move('inbox/x', rootish)).rejects.toBeInstanceOf(PathEscapeError);
      expect((await fs.readdir(tmp)).sort()).toEqual(before);
      expect((await fs.stat(root)).isDirectory()).toBe(true);
    });

    it(`still allows root-equivalent path ${JSON.stringify(rootish)} for list and exists`, async () => {
      expect(await storage.exists(rootish)).toBe(true);
      expect(await storage.list(rootish)).toContain('inbox');
    });
  }

  it('allows a junction that stays inside the root', async () => {
    await storage.writeText('inbox/a.txt', 'A');
    await fs.symlink(path.join(root, 'inbox'), path.join(root, 'assets', 'alias'), 'junction');
    expect(await storage.readText('assets/alias/a.txt')).toBe('A');
  });
});

describe('absolutePath', () => {
  it('resolves inside the root and rejects escapes', async () => {
    await storage.ensureLayout();
    expect(await storage.absolutePath('inbox/a.png')).toBe(path.join(root, 'inbox', 'a.png'));
    await expect(storage.absolutePath('../x')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(storage.absolutePath('')).rejects.toBeInstanceOf(PathEscapeError);
  });

  it('rejects a path through a junction that points outside the root', async () => {
    await storage.ensureLayout();
    const outside = path.join(tmp, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, 'inbox', 'link'), 'junction');
    await expect(storage.absolutePath('inbox/link/a.png')).rejects.toBeInstanceOf(PathEscapeError);
  });

  it('uses fixed messages without the relative path', async () => {
    await storage.ensureLayout();
    await expect(storage.absolutePath('../secret-name')).rejects.toThrow(/^Path escapes the workspace$/);
    await expect(storage.absolutePath(path.resolve('secret-name'))).rejects.toThrow(/^Absolute path not allowed$/);
  });

  it('rejects a dangling link without leaking the root path', async () => {
    await storage.ensureLayout();
    await fs.symlink(path.join(tmp, 'nowhere'), path.join(root, 'inbox', 'dangling'), 'junction');
    const error = await storage.absolutePath('inbox/dangling/a.png').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PathEscapeError);
    expect((error as Error).message).not.toContain(root);
    expect((error as Error).message).not.toContain(tmp);
  });
});

describe('freeBytes', () => {
  it('reports the free space of the volume holding an existing root', async () => {
    await storage.ensureLayout();
    const free = await storage.freeBytes();
    expect(typeof free).toBe('number');
    expect(free).toBeGreaterThan(0);
  });

  it('measures through the nearest existing parent of a missing root', async () => {
    const s = new LocalFileSystemStorage(path.join(tmp, 'missing', 'deeper', 'ws'));
    const free = await s.freeBytes();
    expect(free).toBeGreaterThan(0);
  });

  it('never throws for a root that cannot be measured', async () => {
    const s = new LocalFileSystemStorage(
      process.platform === 'win32' ? 'Q:\\no\\such\\drive\\ws' : '/no/such/parent/ws',
    );
    const free = await s.freeBytes();
    expect(free === null || typeof free === 'number').toBe(true);
  });

  it('answers null when the measurement fails', async () => {
    const spy = vi.spyOn(fs, 'statfs').mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }));
    try {
      expect(await storage.freeBytes()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
