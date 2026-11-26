import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import {
  ArchiveNotReadableError,
  ArchiveTooLargeError,
  SourceNotReadableError,
  type ArchiveEntry,
  type ArchiveReader,
  type OpenArchive,
} from '@assetforge/core';

const openFd = promisify(fs.open);
const fstat = promisify(fs.fstat);
const closeFd = promisify(fs.close);
const fromFd = promisify<number, yauzl.Options, yauzl.ZipFile>(yauzl.fromFd);

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const STORED = 0;
const DEFLATED = 8;

/**
 * `decodeStrings: false` because yauzl refuses the whole directory when an entry name is
 * absolute or holds `..`; such names are the import's to judge per entry, so the adapter
 * decodes them itself (UTF-8 when the entry says so, CP437 otherwise).
 * `validateEntrySizes` makes every entry stream fail unless it yields exactly the declared size.
 */
const OPTIONS: yauzl.Options = {
  lazyEntries: true,
  autoClose: false,
  decodeStrings: false,
  validateEntrySizes: true,
  strictFileNames: false,
};

/** Reads ZIP archives for the import through yauzl: the central directory first, entries lazily as streams. */
export class ZipArchiveReader implements ArchiveReader {
  async open(absolutePath: string, limits: { maxEntries: number }): Promise<OpenArchive> {
    const fd = await openRegularFile(absolutePath);

    let zipfile: yauzl.ZipFile;
    try {
      zipfile = await fromFd(fd, OPTIONS);
    } catch (cause) {
      // yauzl takes the descriptor over only with a ZipFile; until then it is ours to close.
      await closeFd(fd).catch(() => undefined);
      throw new ArchiveNotReadableError({ cause });
    }
    // The descriptor reader reports the end of `fs.close` as 'close' or 'error'. The ZipFile forwards
    // only its first error, so listen on the reader itself: `close()` must settle either way.
    // `reader` is a yauzl internal; without it the ZipFile cannot be trusted to release the
    // descriptor, so it is closed here directly and the ZipFile is dropped.
    const descriptor: unknown = (zipfile as unknown as { reader?: unknown }).reader;
    if (!isEmitter(descriptor)) {
      await closeFd(fd).catch(() => undefined);
      throw new ArchiveNotReadableError();
    }
    // Errors after the directory was read (for example closing the descriptor) must not crash the process.
    zipfile.on('error', () => undefined);
    const closed = new Promise<void>((resolve) => {
      descriptor.once('close', () => resolve());
      descriptor.once('error', () => resolve());
    });
    const streams = new Set<Readable>();
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        // Every live entry stream holds a reference on the descriptor; it is released only when they are gone.
        for (const stream of streams) stream.destroy();
        zipfile.close();
        await closed;
      })();
      return closing;
    };

    let directory: DirectoryEntry[];
    try {
      if (zipfile.entryCount > limits.maxEntries) throw new ArchiveTooLargeError();
      directory = await readDirectory(zipfile);
    } catch (error) {
      await close();
      throw error;
    }

    return {
      entries: directory.map((d) => d.entry),
      openEntry: async (index) => {
        const entry = directory[index]?.location;
        if (closing !== undefined || entry === undefined) throw new ArchiveNotReadableError();
        let stream: Readable;
        try {
          stream = await zipfile.openReadStreamPromise(entry);
        } catch (cause) {
          throw new ArchiveNotReadableError({ cause });
        }
        if (closing !== undefined) {
          // `close()` ran while the stream was being opened; its reference would keep the file open.
          stream.destroy();
          throw new ArchiveNotReadableError();
        }
        streams.add(stream);
        stream.once('close', () => streams.delete(stream));
        return stream;
      },
      close,
    };
  }
}

function isEmitter(value: unknown): value is EventEmitter {
  return typeof (value as { once?: unknown } | null | undefined)?.once === 'function';
}

/** The same check and the same failure as a plain import source (`NodeSourceFiles`). */
async function openRegularFile(absolutePath: string): Promise<number> {
  let fd: number | undefined;
  try {
    fd = await openFd(absolutePath, 'r');
    const stat = await fstat(fd);
    if (!stat.isFile()) {
      throw new Error('not a regular file');
    }
    return fd;
  } catch (cause) {
    if (fd !== undefined) await closeFd(fd).catch(() => undefined);
    throw new SourceNotReadableError(`Cannot read source file: ${absolutePath}`, { cause });
  }
}

interface DirectoryEntry {
  entry: ArchiveEntry;
  /** What `openReadStream` needs of the entry, without its name, extra field and comment buffers. */
  location: yauzl.Entry;
}

/**
 * A public `yauzl.Entry` carrying only the fields `ZipFile.openReadStream` (yauzl 3.4.0) reads:
 * sizes, compression method, the flags behind `isEncrypted()` and the local header offset.
 * A full entry keeps up to ~196 KB of name, extra field and comment buffers alive.
 */
function slimEntry(entry: yauzl.Entry): yauzl.Entry {
  return Object.assign(new yauzl.Entry(), {
    generalPurposeBitFlag: entry.generalPurposeBitFlag,
    compressionMethod: entry.compressionMethod,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    relativeOffsetOfLocalHeader: entry.relativeOffsetOfLocalHeader,
  });
}

function readDirectory(zipfile: yauzl.ZipFile): Promise<DirectoryEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: DirectoryEntry[] = [];
    const onEntry = (entry: yauzl.Entry) => {
      try {
        entries.push({ entry: toArchiveEntry(entry), location: slimEntry(entry) });
      } catch (cause) {
        onError(cause);
        return;
      }
      zipfile.readEntry();
    };
    const onEnd = () => {
      cleanup();
      resolve(entries);
    };
    const onError = (cause: unknown) => {
      cleanup();
      reject(new ArchiveNotReadableError({ cause }));
    };
    const cleanup = () => {
      zipfile.off('entry', onEntry);
      zipfile.off('end', onEnd);
      zipfile.off('error', onError);
    };
    zipfile.on('entry', onEntry);
    zipfile.once('end', onEnd);
    zipfile.once('error', onError);
    zipfile.readEntry();
  });
}

function toArchiveEntry(entry: yauzl.Entry): ArchiveEntry {
  // With `decodeStrings: false` yauzl leaves the name undecoded; this is its own decoding, minus the path validation.
  const name = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, false);
  return {
    name,
    uncompressedSize: entry.uncompressedSize,
    isDirectory: name.endsWith('/'),
    isSymlink: ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK,
    isUnsupported:
      entry.isEncrypted() || (entry.compressionMethod !== STORED && entry.compressionMethod !== DEFLATED),
  };
}
