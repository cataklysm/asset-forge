import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream, fstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import {
  ArchiveNotReadableError,
  ArchiveTooLargeError,
  SourceNotReadableError,
  type OpenArchive,
} from '@assetforge/core';
import { ZipArchiveReader } from '../src/index.js';

// Windows opens files with FILE_SHARE_DELETE, so deleting a file proves nothing about its handle.
// Instead every descriptor the adapter opens is recorded and checked to be closed.
const probe = vi.hoisted(() => ({ opened: [] as number[], dropReader: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const open = (...args: unknown[]) => {
    const callback = args.pop() as (err: NodeJS.ErrnoException | null, fd?: number) => void;
    (actual.open as (...a: unknown[]) => void)(...args, (err: NodeJS.ErrnoException | null, fd?: number) => {
      if (!err && fd !== undefined) probe.opened.push(fd);
      callback(err, fd);
    });
  };
  return { ...actual, open, default: { ...actual, open } };
});

vi.mock('yauzl', async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof import('yauzl') }>()).default;
  const fromFd = (fd: number, options: import('yauzl').Options, callback: (err: Error | null, zip?: unknown) => void) =>
    actual.fromFd(fd, options, (err, zipfile) => {
      if (zipfile && probe.dropReader) delete (zipfile as unknown as { reader?: unknown }).reader;
      callback(err, zipfile);
    });
  const mocked = { ...actual, fromFd };
  return { ...mocked, default: mocked };
});

/** Asserts that every descriptor the adapter opened since the last call is closed again. */
function expectAllClosed({ requireOpened = true } = {}): void {
  if (requireOpened) expect(probe.opened.length).toBeGreaterThan(0);
  for (const fd of probe.opened.splice(0)) {
    expect(() => fstatSync(fd), `descriptor ${fd} is still open`).toThrow(expect.objectContaining({ code: 'EBADF' }));
  }
}

let tmp: string;
const reader = new ZipArchiveReader();
const LIMITS = { maxEntries: 100 };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'af-zip-'));
  probe.opened.length = 0;
  probe.dropReader = false;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

type Item =
  | { kind: 'file'; name: string; data: Buffer; compress?: boolean; mode?: number }
  | { kind: 'dir'; name: string };

async function buildZip(file: string, items: Item[], options: { forceZip64Format?: boolean } = {}): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const item of items) {
    if (item.kind === 'dir') {
      zip.addEmptyDirectory(item.name);
    } else {
      zip.addBuffer(item.data, item.name, {
        compress: item.compress ?? true,
        ...(item.mode !== undefined ? { mode: item.mode } : {}),
        ...(options.forceZip64Format ? { forceZip64Format: true } : {}),
      });
    }
  }
  zip.end({ forceZip64Format: options.forceZip64Format ?? false, comment: '' });
  await pipeline(zip.outputStream, createWriteStream(file));
}

interface Headers {
  central: number;
  local: number;
}

/** Offsets of the central and local header of every entry of a (non-ZIP64) archive. */
function headers(buf: Buffer): Headers[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  const out: Headers[] = [];
  for (let n = 0; n < count; n++) {
    out.push({ central: cursor, local: buf.readUInt32LE(cursor + 42) });
    cursor += 46 + buf.readUInt16LE(cursor + 28) + buf.readUInt16LE(cursor + 30) + buf.readUInt16LE(cursor + 32);
  }
  return out;
}

async function patch(file: string, fn: (buf: Buffer, entries: Headers[]) => void): Promise<void> {
  const buf = await fs.readFile(file);
  fn(buf, headers(buf));
  await fs.writeFile(file, buf);
}

/** Replaces every occurrence of `from` by `to` (same byte length), i.e. a name in both headers. */
function replaceBytes(buf: Buffer, from: Buffer, to: Buffer): void {
  if (from.length !== to.length) throw new Error('length differs');
  let at = buf.indexOf(from);
  if (at < 0) throw new Error('not found');
  while (at >= 0) {
    to.copy(buf, at);
    at = buf.indexOf(from, at + to.length);
  }
}

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function withArchive<T>(file: string, fn: (archive: OpenArchive) => Promise<T>): Promise<T> {
  const archive = await reader.open(file, LIMITS);
  try {
    return await fn(archive);
  } finally {
    await archive.close();
  }
}

const stored = Buffer.from('stored content');
const deflated = Buffer.from('deflated content '.repeat(200));

describe('ZipArchiveReader', () => {
  it('lists names, sizes and flags of every entry', async () => {
    const file = path.join(tmp, 'a.zip');
    await buildZip(file, [
      { kind: 'file', name: 'stored.txt', data: stored, compress: false },
      { kind: 'file', name: 'sub/deflated.txt', data: deflated },
      { kind: 'dir', name: 'folder/' },
      { kind: 'file', name: 'link', data: Buffer.from('target.png'), compress: false, mode: 0o120777 },
      { kind: 'file', name: 'secret.png', data: deflated },
    ]);
    await patch(file, (buf, entries) => {
      const secret = entries[4]!;
      buf.writeUInt16LE(buf.readUInt16LE(secret.central + 8) | 0x1, secret.central + 8);
      buf.writeUInt16LE(buf.readUInt16LE(secret.local + 6) | 0x1, secret.local + 6);
    });

    const entries = await withArchive(file, async (archive) => archive.entries);
    expect(entries).toEqual([
      { name: 'stored.txt', uncompressedSize: stored.length, isDirectory: false, isSymlink: false, isUnsupported: false },
      { name: 'sub/deflated.txt', uncompressedSize: deflated.length, isDirectory: false, isSymlink: false, isUnsupported: false },
      { name: 'folder/', uncompressedSize: 0, isDirectory: true, isSymlink: false, isUnsupported: false },
      { name: 'link', uncompressedSize: 10, isDirectory: false, isSymlink: true, isUnsupported: false },
      { name: 'secret.png', uncompressedSize: deflated.length, isDirectory: false, isSymlink: false, isUnsupported: true },
    ]);
  });

  it('marks an entry with an unsupported compression method', async () => {
    const file = path.join(tmp, 'a.zip');
    await buildZip(file, [{ kind: 'file', name: 'x.png', data: deflated }]);
    await patch(file, (buf, [entry]) => {
      buf.writeUInt16LE(14, entry!.central + 10);
      buf.writeUInt16LE(14, entry!.local + 8);
    });
    const entries = await withArchive(file, async (archive) => archive.entries);
    expect(entries[0]!.isUnsupported).toBe(true);
  });

  it('yields the exact bytes of each entry, in any order', async () => {
    const file = path.join(tmp, 'a.zip');
    await buildZip(file, [
      { kind: 'file', name: 'stored.txt', data: stored, compress: false },
      { kind: 'file', name: 'deflated.txt', data: deflated },
      { kind: 'file', name: 'empty.txt', data: Buffer.alloc(0) },
    ]);
    await withArchive(file, async (archive) => {
      expect(await read(await archive.openEntry(1))).toEqual(deflated);
      expect(await read(await archive.openEntry(0))).toEqual(stored);
      expect(await read(await archive.openEntry(1))).toEqual(deflated);
      expect(await read(await archive.openEntry(2))).toEqual(Buffer.alloc(0));
    });
  });

  it('opens and reads a ZIP64 archive', async () => {
    const file = path.join(tmp, 'a.zip');
    await buildZip(
      file,
      [
        { kind: 'file', name: 'stored.txt', data: stored, compress: false },
        { kind: 'file', name: 'deflated.txt', data: deflated },
      ],
      { forceZip64Format: true },
    );
    await withArchive(file, async (archive) => {
      expect(archive.entries.map((e) => [e.name, e.uncompressedSize])).toEqual([
        ['stored.txt', stored.length],
        ['deflated.txt', deflated.length],
      ]);
      expect(await read(await archive.openEntry(0))).toEqual(stored);
      expect(await read(await archive.openEntry(1))).toEqual(deflated);
    });
  });

  it('decodes a UTF-8 name and a CP437 name', async () => {
    const file = path.join(tmp, 'a.zip');
    await buildZip(file, [
      { kind: 'file', name: 'größe.png', data: stored },
      { kind: 'file', name: 'cp_437.png', data: stored },
    ]);
    await patch(file, (buf, entries) => {
      const cp = entries[1]!;
      buf.writeUInt16LE(buf.readUInt16LE(cp.central + 8) & ~0x800, cp.central + 8);
      buf.writeUInt16LE(buf.readUInt16LE(cp.local + 6) & ~0x800, cp.local + 6);
      // 0x84 is "ä" and 0xE1 is "ß" in CP437.
      replaceBytes(buf, Buffer.from('cp_437'), Buffer.from([0x63, 0x70, 0x84, 0x34, 0xe1, 0x37]));
    });
    const names = await withArchive(file, async (archive) => archive.entries.map((e) => e.name));
    expect(names).toEqual(['größe.png', 'cpä4ß7.png']);
  });

  it('opens an archive with a parent-relative and an absolute entry name and lists them unchanged', async () => {
    const file = path.join(tmp, 'a.zip');
    await buildZip(file, [
      { kind: 'file', name: 'xx/evil.png', data: stored },
      { kind: 'file', name: '_abs.png', data: stored },
    ]);
    await patch(file, (buf) => {
      replaceBytes(buf, Buffer.from('xx/evil.png'), Buffer.from('../evil.png'));
      replaceBytes(buf, Buffer.from('_abs.png'), Buffer.from('/abs.png'));
    });
    await withArchive(file, async (archive) => {
      expect(archive.entries.map((e) => e.name)).toEqual(['../evil.png', '/abs.png']);
      expect(await read(await archive.openEntry(0))).toEqual(stored);
    });
  });

  it('refuses a file that is not a ZIP archive', async () => {
    const file = path.join(tmp, 'text.zip');
    await fs.writeFile(file, 'just some text, not an archive');
    await expect(reader.open(file, LIMITS)).rejects.toBeInstanceOf(ArchiveNotReadableError);
  });

  it('refuses a missing path and a directory like a plain source', async () => {
    const missing = path.join(tmp, 'nope.zip');
    const err = await reader.open(missing, LIMITS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceNotReadableError);
    expect((err as Error).message).toBe('This file cannot be read');
    await expect(reader.open(tmp, LIMITS)).rejects.toBeInstanceOf(SourceNotReadableError);
  });

  it('refuses an archive with more entries than allowed', async () => {
    const file = path.join(tmp, 'a.zip');
    await buildZip(file, [
      { kind: 'file', name: 'a.txt', data: stored },
      { kind: 'file', name: 'b.txt', data: stored },
      { kind: 'file', name: 'c.txt', data: stored },
    ]);
    await expect(reader.open(file, { maxEntries: 2 })).rejects.toBeInstanceOf(ArchiveTooLargeError);
  });

  it.each([
    ['larger', 1],
    ['smaller', -1],
  ])('fails the stream when the declared size is %s than the content', async (_label, delta) => {
    const file = path.join(tmp, 'a.zip');
    await buildZip(file, [{ kind: 'file', name: 'x.txt', data: deflated }]);
    await patch(file, (buf, [entry]) => {
      buf.writeUInt32LE(deflated.length + delta, entry!.central + 24);
      buf.writeUInt32LE(deflated.length + delta, entry!.local + 22);
    });
    await withArchive(file, async (archive) => {
      expect(archive.entries[0]!.uncompressedSize).toBe(deflated.length + delta);
      await expect(read(await archive.openEntry(0))).rejects.toThrow();
    });
  });

  it('refuses the archive when a stored entry declares another size than it stores', async () => {
    const file = path.join(tmp, 'a.zip');
    await buildZip(file, [{ kind: 'file', name: 'x.txt', data: stored, compress: false }]);
    await patch(file, (buf, [entry]) => {
      buf.writeUInt32LE(stored.length + 1, entry!.central + 24);
    });
    await expect(reader.open(file, LIMITS)).rejects.toBeInstanceOf(ArchiveNotReadableError);
    expectAllClosed();
  });

  it('rejects openEntry when the entry has a corrupt local file header', async () => {
    const file = path.join(tmp, 'a.zip');
    await buildZip(file, [
      { kind: 'file', name: 'x.txt', data: deflated },
      { kind: 'file', name: 'y.txt', data: stored },
    ]);
    await patch(file, (buf, [entry]) => {
      buf.writeUInt32LE(0xdeadbeef, entry!.local);
    });
    await withArchive(file, async (archive) => {
      await expect(archive.openEntry(0)).rejects.toBeInstanceOf(ArchiveNotReadableError);
      expect(await read(await archive.openEntry(1))).toEqual(stored);
    });
    expectAllClosed();
  });

  describe('releases every descriptor it opens', () => {
    it('after open and close', async () => {
      const file = path.join(tmp, 'a.zip');
      await buildZip(file, [{ kind: 'file', name: 'x.txt', data: deflated }]);
      const archive = await reader.open(file, LIMITS);
      await read(await archive.openEntry(0));
      await archive.close();
      expectAllClosed();
    });

    it('after close with an entry stream left unread', async () => {
      const file = path.join(tmp, 'a.zip');
      // Large enough that the unread stream cannot buffer the whole entry and drop its reference by itself.
      await buildZip(file, [{ kind: 'file', name: 'x.bin', data: randomBytes(4 * 1024 * 1024) }]);
      const archive = await reader.open(file, LIMITS);
      await archive.openEntry(0);
      await archive.close();
      await archive.close();
      await expect(archive.openEntry(0)).rejects.toBeInstanceOf(ArchiveNotReadableError);
      expectAllClosed();
    });

    it('when the file is not a ZIP', async () => {
      const file = path.join(tmp, 'text.zip');
      await fs.writeFile(file, 'not an archive');
      await expect(reader.open(file, LIMITS)).rejects.toBeInstanceOf(ArchiveNotReadableError);
      expectAllClosed();
    });

    it('when the archive has too many entries', async () => {
      const file = path.join(tmp, 'a.zip');
      await buildZip(file, [
        { kind: 'file', name: 'a.txt', data: stored },
        { kind: 'file', name: 'b.txt', data: stored },
        { kind: 'file', name: 'c.txt', data: stored },
      ]);
      await expect(reader.open(file, { maxEntries: 2 })).rejects.toBeInstanceOf(ArchiveTooLargeError);
      expectAllClosed();
    });

    it('when reading the directory fails', async () => {
      const file = path.join(tmp, 'a.zip');
      await buildZip(file, [
        { kind: 'file', name: 'a.txt', data: stored },
        { kind: 'file', name: 'b.txt', data: stored },
      ]);
      await patch(file, (buf, entries) => {
        buf.writeUInt32LE(0xdeadbeef, entries[1]!.central);
      });
      await expect(reader.open(file, LIMITS)).rejects.toBeInstanceOf(ArchiveNotReadableError);
      expectAllClosed();
    });

    it('when the source is a directory', async () => {
      await expect(reader.open(tmp, LIMITS)).rejects.toBeInstanceOf(SourceNotReadableError);
      expectAllClosed({ requireOpened: false });
    });

    it('when the yauzl internal it relies on is missing', async () => {
      const file = path.join(tmp, 'a.zip');
      await buildZip(file, [{ kind: 'file', name: 'x.txt', data: stored }]);
      probe.dropReader = true;
      await expect(reader.open(file, LIMITS)).rejects.toBeInstanceOf(ArchiveNotReadableError);
      expectAllClosed();
    });
  });

  it('never puts reader error text into the message', async () => {
    const file = path.join(tmp, 'text.zip');
    await fs.writeFile(file, 'not an archive');
    const err = await reader.open(file, LIMITS).catch((e: unknown) => e);
    expect((err as Error).message).toBe(new ArchiveNotReadableError().message);
  });
});
