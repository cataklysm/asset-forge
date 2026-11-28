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

/** `fs.open` as a promise. */
const openFd = promisify(fs.open);
/** `fs.fstat` as a promise. */
const fstat = promisify(fs.fstat);
/** `fs.close` as a promise. */
const closeFd = promisify(fs.close);
/** `yauzl.fromFd` as a promise. */
const fromFd = promisify<number, yauzl.Options, yauzl.ZipFile>(yauzl.fromFd);

/** The file type bits of a Unix mode. */
const S_IFMT = 0o170000;
/** The file type of a symbolic link. */
const S_IFLNK = 0o120000;
/** The compression method of a stored entry. */
const STORED = 0;
/** The compression method of a deflated entry. */
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
  /**
   * Opens an archive and reads its central directory.
   *
   * @param absolutePath the archive on disk
   * @param limits the most entries accepted
   * @returns the entries and the means to open each one and to close the archive
   * @throws SourceNotReadableError when the file cannot be opened as a regular file
   * @throws ArchiveNotReadableError when it is not a readable ZIP archive
   * @throws ArchiveTooLargeError when it holds more than `maxEntries` entries
   */
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
    const archive = new OpenZip(zipfile, descriptor);

    let directory: DirectoryEntry[];
    try {
      if (zipfile.entryCount > limits.maxEntries) throw new ArchiveTooLargeError();
      directory = await readDirectory(zipfile);
    } catch (error) {
      await archive.close();
      throw error;
    }

    return {
      entries: directory.map((listed) => listed.entry),
      openEntry: (index) => archive.openEntry(directory[index]?.location),
      close: () => archive.close(),
    };
  }
}

/** The ZipFile of an open archive, its live entry streams and its one close. */
class OpenZip {
  /** Settles once the descriptor reader reported the end of `fs.close`. */
  private readonly closed: Promise<void>;
  /** The entry streams not yet closed. */
  private readonly streams = new Set<Readable>();
  /** The close in progress or done; set by the first `close()`. */
  private closing: Promise<void> | undefined;

  /**
   * Starts listening for the end of the descriptor.
   *
   * @param zipfile the ZipFile that owns the descriptor
   * @param descriptor the ZipFile's descriptor reader
   */
  constructor(
    private readonly zipfile: yauzl.ZipFile,
    descriptor: EventEmitter,
  ) {
    this.closed = new Promise<void>((resolve) => {
      descriptor.once('close', () => resolve());
      descriptor.once('error', () => resolve());
    });
  }

  /**
   * Opens one entry as a stream.
   *
   * @param entry the entry's location; undefined for an index outside the directory
   * @returns the entry's bytes
   * @throws ArchiveNotReadableError when the archive is closing, the entry is unknown or cannot be opened
   */
  async openEntry(entry: yauzl.Entry | undefined): Promise<Readable> {
    if (this.closing !== undefined || entry === undefined) throw new ArchiveNotReadableError();
    let stream: Readable;
    try {
      stream = await this.zipfile.openReadStreamPromise(entry);
    } catch (cause) {
      throw new ArchiveNotReadableError({ cause });
    }
    if (this.closing !== undefined) {
      // `close()` ran while the stream was being opened; its reference would keep the file open.
      stream.destroy();
      throw new ArchiveNotReadableError();
    }
    this.streams.add(stream);
    stream.once('close', () => this.streams.delete(stream));
    return stream;
  }

  /**
   * Closes the archive once; every later call answers the same promise.
   *
   * @returns settles once the descriptor is released
   */
  close(): Promise<void> {
    this.closing ??= this.release();
    return this.closing;
  }

  /**
   * The body of the one close.
   *
   * @returns settles once the descriptor is released
   */
  private async release(): Promise<void> {
    // Every live entry stream holds a reference on the descriptor; it is released only when they are gone.
    for (const stream of this.streams) stream.destroy();
    this.zipfile.close();
    await this.closed;
  }
}

/**
 * Whether a value can be listened on.
 *
 * @param value any value
 * @returns true when it has a `once` method
 */
function isEmitter(value: unknown): value is EventEmitter {
  return typeof (value as { once?: unknown } | null | undefined)?.once === 'function';
}

/**
 * The same check and the same failure as a plain import source (`NodeSourceFiles`).
 *
 * @param absolutePath the archive on disk
 * @returns the open descriptor of a regular file
 * @throws SourceNotReadableError when it cannot be opened or is not a regular file
 */
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
    throw new SourceNotReadableError({ cause });
  }
}

/** One entry of the central directory. */
interface DirectoryEntry {
  /** What the import sees of the entry. */
  entry: ArchiveEntry;
  /** What `openReadStream` needs of the entry, without its name, extra field and comment buffers. */
  location: yauzl.Entry;
}

/**
 * A public `yauzl.Entry` carrying only the fields `ZipFile.openReadStream` (yauzl 3.4.0) reads:
 * sizes, compression method, the flags behind `isEncrypted()` and the local header offset.
 * A full entry keeps up to ~196 KB of name, extra field and comment buffers alive.
 *
 * @param entry the full entry
 * @returns the slim entry
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

/**
 * Reads the whole central directory, one lazy entry after the other.
 *
 * @param zipfile the opened ZipFile
 * @returns the entries in directory order
 * @throws ArchiveNotReadableError when the directory or an entry cannot be read
 */
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

/**
 * What the import sees of an entry: its decoded name, its size and what it is.
 *
 * @param entry the yauzl entry
 * @returns the archive entry
 */
function toArchiveEntry(entry: yauzl.Entry): ArchiveEntry {
  // With `decodeStrings: false` yauzl leaves the name undecoded; this is its own decoding, minus the path validation.
  const name = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, false);
  return {
    name,
    uncompressedSize: entry.uncompressedSize,
    isDirectory: name.endsWith('/'),
    isSymlink: ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK,
    isUnsupported: entry.isEncrypted() || (entry.compressionMethod !== STORED && entry.compressionMethod !== DEFLATED),
  };
}
