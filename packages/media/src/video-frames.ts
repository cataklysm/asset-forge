import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { jpegDimensions } from './jpeg-dimensions.js';
import { DiagnosticLines, DiagnosticsReader, type VideoInfo } from './video-diagnostics.js';
import {
  FRAME_AT_SECONDS,
  frameArguments,
  frameMatches,
  isVideoFormat,
  type VideoFormat,
} from './video-frame-arguments.js';

/** The frame tool: one ffmpeg process per call, bounded in number and time. */
export interface VideoFrames {
  /**
   * Extracts one frame as a JPEG at `targetPath`. Never rejects and never leaves a partial target.
   *
   * @param sourcePath the video
   * @param format its container
   * @param targetPath where the JPEG ends up
   * @returns the video's displayed size and duration; null when the tool is missing, fails, times out or was closed
   */
  extract(sourcePath: string, format: VideoFormat, targetPath: string): Promise<VideoInfo | null>;
  /** Kills running processes, answers queued calls with null and refuses new ones. */
  close(): void;
}

/** What `createVideoFrames` is configured with. */
export interface VideoFramesOptions {
  /** Absolute path of the ffmpeg binary; null (or a promise of null) answers every call with null. */
  binaryPath: string | null | Promise<string | null>;
  /** Processes at a time; a positive integer. */
  concurrency?: number;
  /** Time limit of one call, both attempts together. */
  timeoutMs?: number;
  /** Test hook: receives every started process. */
  onProcess?: (child: ChildProcess) => void;
  /** Test hook: starts the process instead of `child_process.spawn`. */
  spawnProcess?: (command: string, commandArguments: string[], options: SpawnOptions) => ChildProcess;
  /** Test hook: replaces KILL_GRACE_MS. */
  killGraceMs?: number;
}

/** Processes at a time by default. */
export const VIDEO_FRAME_CONCURRENCY = 2;
/** Time limit of one call by default, both attempts together. */
export const VIDEO_FRAME_TIMEOUT_MS = 20_000;

/** A grace period after kill(): the attempt is given up when the process has not exited by then. */
export const KILL_GRACE_MS = 2000;
/** A written frame larger than this is not read back. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** How one process ended. */
interface Attempt {
  /** The info its diagnostics gave; null when it failed or was killed. */
  info: VideoInfo | null;
  /** True when the process was killed (timeout or close); no further attempt is made. */
  isKilled: boolean;
}

/** A call waiting for a process slot; resolves false when the tool was closed meanwhile. */
type Waiter = (granted: boolean) => void;

/** The options with their defaults, as the extractor and its attempts use them. */
interface FrameToolConfig {
  /** Where the binary is, once known. */
  binaryPath: string | null | Promise<string | null>;
  /** Processes at a time. */
  concurrency: number;
  /** Time limit of one call. */
  timeoutMs: number;
  /** The grace period after a kill. */
  killGraceMs: number;
  /** Starts a process. */
  startProcess: (command: string, commandArguments: string[], options: SpawnOptions) => ChildProcess;
  /** Receives every started process. */
  onProcess: ((child: ChildProcess) => void) | undefined;
}

/**
 * Runs ffmpeg as a bounded child process, one per call: no shell, an argument array, no window,
 * no stdin, the diagnostics read line by line and never kept whole. Calls beyond `concurrency`
 * wait and are served newest first, like the preview worker pool. Nothing is logged.
 *
 * @param options the binary, the limits and the test hooks
 * @returns the frame tool
 * @throws RangeError when `concurrency` is not a positive integer
 */
export function createVideoFrames(options: VideoFramesOptions): VideoFrames {
  const config: FrameToolConfig = {
    binaryPath: options.binaryPath,
    concurrency: options.concurrency ?? VIDEO_FRAME_CONCURRENCY,
    timeoutMs: options.timeoutMs ?? VIDEO_FRAME_TIMEOUT_MS,
    killGraceMs: options.killGraceMs ?? KILL_GRACE_MS,
    startProcess: options.spawnProcess ?? spawn,
    onProcess: options.onProcess,
  };
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    throw new RangeError('The video frame concurrency must be a positive integer');
  }
  const extractor = new FrameExtractor(config);
  return {
    extract: (sourcePath, format, targetPath) => extractor.extract(sourcePath, format, targetPath),
    close: () => extractor.close(),
  };
}

/**
 * True when a frame was written and has the size the reported video size scales to; a log line
 * alone is never trusted.
 *
 * @param path the written JPEG
 * @param info the info the diagnostics gave
 * @returns whether the file is a JPEG of the expected size, at most `MAX_FRAME_BYTES`
 */
async function frameWritten(path: string, info: VideoInfo): Promise<boolean> {
  try {
    const file = await stat(path);
    if (!file.isFile() || file.size === 0 || file.size > MAX_FRAME_BYTES) return false;
    const size = jpegDimensions(await readFile(path));
    return size !== null && frameMatches(info, size);
  } catch {
    return false;
  }
}

/** The process slots, the running processes and the calls of one frame tool. */
class FrameExtractor {
  /** Calls waiting for a slot; the newest is served first. */
  private readonly queue: Waiter[] = [];
  /** Running processes with the function that kills them. */
  private readonly running = new Map<ChildProcess, () => void>();
  /** Slots in use. */
  private active = 0;
  /** `close` was called. */
  private isClosed = false;

  /** @param config the options with their defaults */
  constructor(private readonly config: FrameToolConfig) {}

  /**
   * See `VideoFrames.extract`.
   *
   * @param sourcePath the video
   * @param format its container
   * @param targetPath where the JPEG ends up
   * @returns the video's info, or null
   */
  extract(sourcePath: string, format: VideoFormat, targetPath: string): Promise<VideoInfo | null> {
    if (this.isClosed || !isVideoFormat(format)) return Promise.resolve(null);
    return this.run(sourcePath, format, targetPath).catch(() => null);
  }

  /** See `VideoFrames.close`. */
  close(): void {
    this.isClosed = true;
    for (const waiter of this.queue.splice(0)) waiter(false);
    for (const kill of this.running.values()) kill();
  }

  /**
   * One call: waits for a slot, then tries the frame at `FRAME_AT_SECONDS` and at 0 s within one deadline. The
   * temporary file is always removed and the slot always freed.
   *
   * @param sourcePath the video
   * @param format its container
   * @param targetPath where the JPEG ends up
   * @returns the video's info once the frame is at `targetPath`; null otherwise
   */
  private async run(sourcePath: string, format: VideoFormat, targetPath: string): Promise<VideoInfo | null> {
    const binary = await this.config.binaryPath;
    if (!binary || this.isClosed) return null;
    if (!(await this.slot())) return null;
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      const deadline = Date.now() + this.config.timeoutMs;
      await mkdir(dirname(targetPath), { recursive: true });
      for (const atSeconds of [FRAME_AT_SECONDS, 0]) {
        const attempt = new FrameAttempt(this.config, this.running, () => this.isClosed);
        const result = await attempt.run(binary, frameArguments(sourcePath, format, atSeconds, temporaryPath), deadline);
        if (result.isKilled) return null;
        if (result.info && (await frameWritten(temporaryPath, result.info))) {
          if (this.isClosed) return null;
          await rename(temporaryPath, targetPath);
          return result.info;
        }
        await rm(temporaryPath, { force: true });
      }
      return null;
    } catch {
      return null;
    } finally {
      await rm(temporaryPath, { force: true, maxRetries: 3 }).catch(() => undefined);
      this.release();
    }
  }

  /** Hands free slots to the newest waiting calls. */
  private pump(): void {
    while (!this.isClosed && this.active < this.config.concurrency && this.queue.length > 0) {
      this.active++;
      (this.queue.pop() as Waiter)(true);
    }
  }

  /**
   * Waits for a free slot.
   *
   * @returns true once a slot is taken; false when the tool was closed meanwhile
   */
  private slot(): Promise<boolean> {
    if (this.isClosed) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  /** Frees a slot and hands it on. */
  private release(): void {
    this.active--;
    this.pump();
  }
}

/** One ffmpeg process: started, watched against the deadline, killed if need be, ended once. */
class FrameAttempt {
  /** The process, once started. */
  private child: ChildProcess | undefined;
  /** The process was killed (deadline or close). */
  private isKilled = false;
  /** The attempt has ended. */
  private isSettled = false;
  /** The deadline timer. */
  private timer: NodeJS.Timeout | undefined;
  /** The grace timer started by a kill. */
  private grace: NodeJS.Timeout | undefined;
  /** Keeps what the result needs from the diagnostics. */
  private readonly reader = new DiagnosticsReader();
  /** Cuts stderr into lines for the reader. */
  private readonly lines = new DiagnosticLines((line) => this.reader.line(line));
  /** Ends the attempt's promise. */
  private resolve: (result: Attempt) => void = () => undefined;

  /**
   * @param config the options with their defaults
   * @param running the tool's running processes; the attempt adds its process and removes it on its end
   * @param isClosed whether the tool was closed
   */
  constructor(
    private readonly config: FrameToolConfig,
    private readonly running: Map<ChildProcess, () => void>,
    private readonly isClosed: () => boolean,
  ) {}

  /**
   * Starts the process and waits for its end.
   *
   * @param binary the ffmpeg binary
   * @param commandArguments the arguments of the process
   * @param deadline the call's deadline in milliseconds since the epoch
   * @returns how the process ended; a closed tool or a passed deadline ends it as killed without a start
   */
  run(binary: string, commandArguments: string[], deadline: number): Promise<Attempt> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.start(binary, commandArguments, deadline);
    });
  }

  /**
   * The executor of `run`: starts the process, the deadline timer and the listeners.
   *
   * @param binary the ffmpeg binary
   * @param commandArguments the arguments of the process
   * @param deadline the call's deadline
   */
  private start(binary: string, commandArguments: string[], deadline: number): void {
    const remaining = deadline - Date.now();
    if (this.isClosed() || remaining <= 0) {
      this.resolve({ info: null, isKilled: true });
      return;
    }
    let child: ChildProcess;
    try {
      child = this.config.startProcess(binary, commandArguments, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      this.resolve({ info: null, isKilled: false });
      return;
    }
    this.child = child;
    this.timer = setTimeout(() => this.kill(), remaining);
    this.running.set(child, () => this.kill());
    this.config.onProcess?.(child);
    this.listen(child);
  }

  /**
   * Reads stderr and ends the attempt on the process's error or close.
   *
   * @param child the started process
   */
  private listen(child: ChildProcess): void {
    child.stderr?.setEncoding('latin1');
    child.stderr?.on('data', (chunk: string) => this.lines.push(chunk));
    child.stderr?.on('error', () => undefined);
    // A failed start (EMFILE, for one) may never be followed by a close.
    child.on('error', () => this.settle({ info: null, isKilled: this.isKilled }));
    child.once('close', (code) => {
      this.lines.end();
      this.settle({ info: this.isKilled || code !== 0 ? null : this.reader.result(), isKilled: this.isKilled });
    });
  }

  /**
   * Ends the attempt once, from whichever comes first: close, error or the grace period.
   *
   * @param result how the attempt ended
   */
  private settle(result: Attempt): void {
    if (this.isSettled) return;
    this.isSettled = true;
    clearTimeout(this.timer);
    clearTimeout(this.grace);
    this.running.delete(this.child as ChildProcess);
    this.resolve(result);
  }

  /** Kills the process once and starts the grace period. */
  private kill(): void {
    if (this.isKilled) return;
    this.isKilled = true;
    // A process that does not exit is given up: the slot is freed and the caller cleans up.
    // Set before kill(), so an error emitted from inside it clears the timer.
    this.grace = setTimeout(() => this.settle({ info: null, isKilled: true }), this.config.killGraceMs);
    try {
      this.child?.kill();
    } catch {
      // Settled by the grace timer all the same.
    }
  }
}
