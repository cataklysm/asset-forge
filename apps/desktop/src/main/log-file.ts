import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logLine } from '@assetforge/core';

// The bounded log file of the main process: every line of the main log is appended to `assetforge.log` in the
// directory the host passes, with a UTC timestamp. The file is rotated at `LOG_FILE_MAX_BYTES` and at most
// `LOG_FILE_KEEP` older files are kept. Writes run one at a time, in order, on async file operations, and a failure
// is swallowed: the log must never fail or slow down what it reports on. The app never reads the file. Kept free of
// Electron imports; the directory is resolved by the host.

/** The directory of the log files under `userData`. */
export const LOG_DIRECTORY = 'logs';
/** The name of the current log file. */
export const LOG_FILE_NAME = 'assetforge.log';
/** The size a log file may reach before it is rotated. */
export const LOG_FILE_MAX_BYTES = 1024 * 1024;
/** How many rotated files are kept beside the current one. */
export const LOG_FILE_KEEP = 2;
/** How many lines wait at most; beyond it the oldest is dropped and counted. */
export const LOG_FILE_MAX_PENDING = 1000;
/** How many characters of a line are written at most. */
export const LOG_LINE_MAX_CHARACTERS = 2000;
/** How long `flush` waits at most. */
export const LOG_FLUSH_DEADLINE_MS = 1000;
/** The event of the line written once writing works again after lines were dropped. */
export const LINES_DROPPED_EVENT = 'Log lines dropped';

/** The file operations the log file uses; Node's `fs/promises` by default. */
export interface LogFileSystem {
  /**
   * Appends text to a file, creating it.
   *
   * @param path the file
   * @param text the text, as UTF-8
   * @returns resolves when it was written
   */
  appendFile(path: string, text: string): Promise<void>;
  /**
   * Answers the size of a file.
   *
   * @param path the file
   * @returns its size
   */
  stat(path: string): Promise<{ size: number }>;
  /**
   * Renames a file, replacing the target.
   *
   * @param from the file
   * @param to its new path
   * @returns resolves when it was renamed
   */
  rename(from: string, to: string): Promise<void>;
  /**
   * Removes a file.
   *
   * @param path the file
   * @returns resolves when it was removed
   */
  unlink(path: string): Promise<void>;
  /**
   * Creates a directory and its parents.
   *
   * @param path the directory
   * @param options always recursive
   * @returns resolves when it exists
   */
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
}

/** What `createLogFile` is wired with. */
export interface LogFileDependencies {
  /** The directory of the log files; created on the first write. */
  directory: string;
  /** The file operations; Node's by default. */
  fileSystem?: LogFileSystem;
  /** The clock of the timestamps. */
  now?: () => Date;
  /** How long `flush` waits at most; `LOG_FLUSH_DEADLINE_MS` by default. */
  flushDeadlineMs?: number;
}

/** The log file as the main log uses it. */
export interface LogFile {
  /**
   * Queues one line. Never throws and never waits.
   *
   * @param line the line, without its timestamp
   */
  write(line: string): void;
  /**
   * Waits for the queued lines to be written, at most for the flush deadline.
   *
   * @returns resolves when the queue is empty or the deadline passed; never rejects
   */
  flush(): Promise<void>;
}

/** The Node file operations behind the log file. */
const NODE_FILE_SYSTEM: LogFileSystem = {
  appendFile: (path, text) => appendFile(path, text, 'utf8'),
  stat: (path) => stat(path),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  mkdir: (path, options) => mkdir(path, options),
};

/**
 * Creates the log file. Nothing touches the disk before the first line.
 *
 * @param dependencies the directory and, for tests, the file operations, the clock and the flush deadline
 * @returns the log file
 */
export function createLogFile(dependencies: LogFileDependencies): LogFile {
  const writer = new LogFileWriter(dependencies);
  return { write: (line) => writer.write(line), flush: () => writer.flush() };
}

/**
 * A line as it is written: line breaks replaced by a space, cut at `LOG_LINE_MAX_CHARACTERS`. The lines are built
 * safely already; this keeps one entry on one line whatever reaches the file.
 *
 * @param line the line
 * @returns the cleaned line
 */
export function cleanLogLine(line: string): string {
  return line.replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, LOG_LINE_MAX_CHARACTERS);
}

/**
 * The path of a log file.
 *
 * @param directory the log directory
 * @param generation 0 for the current file, 1 to `LOG_FILE_KEEP` for the rotated ones
 * @returns the path
 */
function logFilePath(directory: string, generation: number): string {
  return join(directory, generation === 0 ? LOG_FILE_NAME : `assetforge.${generation}.log`);
}

/**
 * Runs a file operation whose missing target is fine.
 *
 * @param operation the operation
 * @returns resolves when it succeeded or its target did not exist
 * @throws what the operation threw for any other reason
 */
async function ignoringMissing(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'ENOENT') throw error;
  }
}

/** The queue and the write loop behind `createLogFile`. */
class LogFileWriter {
  private readonly directory: string;
  private readonly fileSystem: LogFileSystem;
  private readonly now: () => Date;
  private readonly flushDeadlineMs: number;
  /** The lines waiting, oldest first, already cleaned and stamped. */
  private readonly pending: string[] = [];
  /** Lines dropped by the queue cap or a failed write since the last line that was written. */
  private droppedCount = 0;
  /** The size of the current file; null until it was read once. */
  private size: number | null = null;
  /** Whether the directory must be created before the next append: at first and after every failure. */
  private needsDirectory = true;
  /** Whether the write loop runs. */
  private isWriting = false;
  /** Resolve the flushes waiting for the queue to empty. */
  private idleWaiters: (() => void)[] = [];

  /**
   * @param dependencies the directory, the file operations, the clock and the flush deadline
   */
  constructor(dependencies: LogFileDependencies) {
    this.directory = dependencies.directory;
    this.fileSystem = dependencies.fileSystem ?? NODE_FILE_SYSTEM;
    this.now = dependencies.now ?? (() => new Date());
    this.flushDeadlineMs = dependencies.flushDeadlineMs ?? LOG_FLUSH_DEADLINE_MS;
  }

  /**
   * Queues one line and starts the write loop when it is idle.
   *
   * @param line the line
   */
  write(line: string): void {
    try {
      this.pending.push(this.stamped(line));
      while (this.pending.length > LOG_FILE_MAX_PENDING) {
        this.pending.shift();
        this.droppedCount++;
      }
      if (!this.isWriting) this.startLoop();
    } catch {
      // A broken clock or an odd value must never fail the caller.
    }
  }

  /**
   * Waits for the queue to empty, at most for the deadline.
   *
   * @returns resolves when the queue is empty or the deadline passed
   */
  flush(): Promise<void> {
    if (!this.isWriting) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.flushDeadlineMs);
      timer.unref?.();
      this.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * A line with its timestamp and newline.
   *
   * @param line the line
   * @returns the entry as it is appended
   */
  private stamped(line: string): string {
    return `${this.now().toISOString()} ${cleanLogLine(line)}\n`;
  }

  /** Starts the write loop; it never rejects. */
  private startLoop(): void {
    this.isWriting = true;
    void this.drain()
      .catch(() => {})
      .finally(() => this.loopEnded());
  }

  /** Marks the loop idle and releases the waiting flushes; a line queued meanwhile restarts it. */
  private loopEnded(): void {
    this.isWriting = false;
    if (this.pending.length > 0) {
      this.startLoop();
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Writes the queued lines in order, as many per append as fit in the current file, until the queue is empty.
   *
   * @returns resolves when the queue is empty
   */
  private async drain(): Promise<void> {
    for (let first = this.pending.shift(); first !== undefined; first = this.pending.shift()) {
      if (this.droppedCount > 0) await this.writeDroppedLine();
      // Read after the await: lines dropped meanwhile were counted on the field.
      const lost = await this.tryAppendBatch(first);
      this.droppedCount += lost;
    }
  }

  /**
   * Puts entries back at the front of the queue, dropping and counting the oldest of them beyond the cap.
   *
   * @param entries the entries, oldest first
   */
  private giveBack(entries: string[]): void {
    this.pending.unshift(...entries);
    while (this.pending.length > LOG_FILE_MAX_PENDING) {
      this.pending.shift();
      this.droppedCount++;
    }
  }

  /** Writes the count of the dropped lines; on success the count starts again. */
  private async writeDroppedLine(): Promise<void> {
    const count = this.droppedCount;
    const entry = this.stamped(logLine(LINES_DROPPED_EVENT, { count }));
    if ((await this.tryAppendBatch(entry, false)) === 0) this.droppedCount -= count;
  }

  /**
   * Appends one entry together with the queued entries that follow it and still fit, rotating first when the
   * entry would make the file too large.
   *
   * @param first the stamped entry taken from the queue
   * @param takesMore whether queued entries may join it
   * @returns the number of entries lost: 1 on a failure, which is swallowed and gives the following entries back
   */
  private async tryAppendBatch(first: string, takesMore = true): Promise<number> {
    let following: string[] = [];
    try {
      const size = await this.roomFor(first);
      if (takesMore) following = this.takeFollowing(size + Buffer.byteLength(first, 'utf8'));
      const text = first + following.join('');
      await this.fileSystem.appendFile(logFilePath(this.directory, 0), text);
      this.size = size + Buffer.byteLength(text, 'utf8');
      return 0;
    } catch {
      this.needsDirectory = true;
      this.giveBack(following);
      return 1;
    }
  }

  /**
   * Prepares the current file for an entry, rotating when the entry would pass the limit.
   *
   * @param entry the entry that comes next
   * @returns the size of the current file the entry goes into
   */
  private async roomFor(entry: string): Promise<number> {
    const size = await this.prepare();
    if (size === 0 || size + Buffer.byteLength(entry, 'utf8') <= LOG_FILE_MAX_BYTES) return size;
    await this.rotate();
    return 0;
  }

  /**
   * Takes the queued entries that fit behind the given size, stopping at lines dropped meanwhile so their count
   * is written in its place.
   *
   * @param size the size of the current file with the entries already taken
   * @returns the entries taken, oldest first
   */
  private takeFollowing(size: number): string[] {
    const taken: string[] = [];
    let total = size;
    while (this.droppedCount === 0 && this.pending.length > 0) {
      const bytes = Buffer.byteLength(this.pending[0]!, 'utf8');
      if (total + bytes > LOG_FILE_MAX_BYTES) break;
      taken.push(this.pending.shift()!);
      total += bytes;
    }
    return taken;
  }

  /**
   * Creates the directory when needed and reads the size of an existing file once.
   *
   * @returns the size of the current file
   */
  private async prepare(): Promise<number> {
    if (this.needsDirectory) {
      await this.fileSystem.mkdir(this.directory, { recursive: true });
      this.needsDirectory = false;
    }
    if (this.size === null) this.size = await this.currentSize();
    return this.size;
  }

  /**
   * The size of the current file.
   *
   * @returns its size; 0 when it does not exist
   */
  private async currentSize(): Promise<number> {
    try {
      return (await this.fileSystem.stat(logFilePath(this.directory, 0))).size;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return 0;
      throw error;
    }
  }

  /** Removes the oldest file, moves every other one up by one and starts an empty current file. */
  private async rotate(): Promise<void> {
    await ignoringMissing(this.fileSystem.unlink(logFilePath(this.directory, LOG_FILE_KEEP)));
    for (let generation = LOG_FILE_KEEP - 1; generation >= 0; generation--) {
      const from = logFilePath(this.directory, generation);
      await ignoringMissing(this.fileSystem.rename(from, logFilePath(this.directory, generation + 1)));
    }
    this.size = 0;
  }
}
