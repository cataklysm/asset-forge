import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PathEscapeError } from '@assetforge/core';
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
