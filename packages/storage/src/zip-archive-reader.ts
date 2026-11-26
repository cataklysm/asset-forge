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
    // Errors after the directory was read (for example closing the descriptor) must not crash the process.
    zipfile.on('error', () => undefined);
    // The descriptor reader reports the end of `fs.close` as 'close' or 'error'. The ZipFile forwards
    // only its first error, so listen on the reader itself: `close()` must settle either way.
    const descriptor = (zipfile as unknown as { reader: EventEmitter }).reader;
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

    let raw: yauzl.Entry[];
    try {
      if (zipfile.entryCount > limits.maxEntries) throw new ArchiveTooLargeError();
      raw = await readDirectory(zipfile);
    } catch (error) {
      await close();
      throw error;
    }

    return {
      entries: raw.map(toArchiveEntry),
      openEntry: async (index) => {
        const entry = raw[index];
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

function readDirectory(zipfile: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    const onEntry = (entry: yauzl.Entry) => {
      entries.push(entry);
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
