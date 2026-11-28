import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDiagnosticsReader, MAX_LINE, type VideoInfo } from './video-diagnostics.js';
import { frameMatches, jpegDimensions } from './jpeg-dimensions.js';
import { DEMUXERS, FRAME_AT_SECONDS, frameArguments, type VideoFormat } from './video-frame-arguments.js';

export interface VideoFrames {
  /**
   * Extracts one frame as a JPEG at `targetPath`; null when the tool is missing, fails, times out
   * or was closed. Never rejects and never leaves a partial target.
   */
  extract(sourcePath: string, format: VideoFormat, targetPath: string): Promise<VideoInfo | null>;
  /** Kills running processes, answers queued calls with null and refuses new ones. */
  close(): void;
}

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
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Test hook: replaces KILL_GRACE_MS. */
  killGraceMs?: number;
}

export const VIDEO_FRAME_CONCURRENCY = 2;
export const VIDEO_FRAME_TIMEOUT_MS = 20_000;

/** A grace period after kill(): the attempt is given up when the process has not exited by then. */
export const KILL_GRACE_MS = 2000;
/** A written frame larger than this is not read back. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

interface Attempt {
  info: VideoInfo | null;
  /** True when the process was killed (timeout or close); no further attempt is made. */
  killed: boolean;
}

/** A call waiting for a process slot; resolves false when the tool was closed meanwhile. */
type Waiter = (granted: boolean) => void;

/**
 * Runs ffmpeg as a bounded child process, one per call: no shell, an argument array, no window,
 * no stdin, the diagnostics read line by line and never kept whole. Calls beyond `concurrency`
 * wait and are served newest first, like the preview worker pool. Nothing is logged.
 */
export function createVideoFrames(options: VideoFramesOptions): VideoFrames {
  const concurrency = options.concurrency ?? VIDEO_FRAME_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? VIDEO_FRAME_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const startProcess = options.spawnProcess ?? spawn;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('The video frame concurrency must be a positive integer');
  }
  const queue: Waiter[] = [];
  /** Running processes with the function that kills them. */
  const running = new Map<ChildProcess, () => void>();
  let active = 0;
  let closed = false;

  function pump(): void {
    while (!closed && active < concurrency && queue.length > 0) {
      active++;
      (queue.pop() as Waiter)(true);
    }
  }

  /** Waits for a free slot; false when the tool was closed meanwhile. */
  function slot(): Promise<boolean> {
    if (closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      queue.push(resolve);
      pump();
    });
  }

  function release(): void {
    active--;
    pump();
  }

  function attempt(
    binary: string,
    sourcePath: string,
    format: VideoFormat,
    atSeconds: number,
    tmpPath: string,
    deadline: number,
  ): Promise<Attempt> {
    return new Promise((resolve) => {
      const remaining = deadline - Date.now();
      if (closed || remaining <= 0) {
        resolve({ info: null, killed: true });
        return;
      }
      let child: ChildProcess;
      try {
        child = startProcess(binary, frameArguments(sourcePath, format, atSeconds, tmpPath), {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch {
        resolve({ info: null, killed: false });
        return;
      }
      let killed = false;
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const reader = createDiagnosticsReader();
      let pending = '';
      let cut = false;

      /** Ends the attempt once, from whichever comes first: close, error or the grace period. */
      const settle = (result: Attempt) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        running.delete(child);
        resolve(result);
      };
      const kill = () => {
        if (killed) return;
        killed = true;
        // A process that does not exit is given up: the slot is freed and the caller cleans up.
        // Set before kill(), so an error emitted from inside it clears the timer.
        grace = setTimeout(() => settle({ info: null, killed: true }), killGraceMs);
        try {
          child.kill();
        } catch {
          // Settled by the grace timer all the same.
        }
      };
      const timer = setTimeout(kill, remaining);
      running.set(child, kill);
      options.onProcess?.(child);

      const readLine = (line: string) => reader.line(line);

      child.stderr?.setEncoding('latin1');
      child.stderr?.on('data', (chunk: string) => {
        const lines = chunk.split(/\r?\n|\r/);
        for (let i = 0; i < lines.length; i++) {
          const piece = lines[i] as string;
          if (i < lines.length - 1) {
            if (!cut) readLine(pending + piece);
            pending = '';
            cut = false;
            continue;
          }
          // The unfinished last piece; a line beyond the cap is dropped, not kept.
          if (cut || pending.length + piece.length > MAX_LINE) {
            pending = '';
            cut = true;
          } else {
            pending += piece;
          }
        }
      });
      child.stderr?.on('error', () => undefined);
      // A failed start (EMFILE, for one) may never be followed by a close.
      child.on('error', () => settle({ info: null, killed }));
      child.once('close', (code) => {
        if (!cut && pending) readLine(pending);
        settle({ info: killed || code !== 0 ? null : reader.result(), killed });
      });
    });
  }

  /**
   * True when a frame was written and has the size the reported video size scales to; a log line
   * alone is never trusted.
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

  async function run(sourcePath: string, format: VideoFormat, targetPath: string): Promise<VideoInfo | null> {
    const binary = await options.binaryPath;
    if (!binary || closed) return null;
    if (!(await slot())) return null;
    const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      const deadline = Date.now() + timeoutMs;
      await mkdir(dirname(targetPath), { recursive: true });
      for (const atSeconds of [FRAME_AT_SECONDS, 0]) {
        const result = await attempt(binary, sourcePath, format, atSeconds, tmpPath, deadline);
        if (result.killed) return null;
        if (result.info && (await frameWritten(tmpPath, result.info))) {
          if (closed) return null;
          await rename(tmpPath, targetPath);
          return result.info;
        }
        await rm(tmpPath, { force: true });
      }
      return null;
    } catch {
      return null;
    } finally {
      await rm(tmpPath, { force: true, maxRetries: 3 }).catch(() => undefined);
      release();
    }
  }

  return {
    extract(sourcePath, format, targetPath) {
      if (closed || !Object.hasOwn(DEMUXERS, format)) return Promise.resolve(null);
      return run(sourcePath, format, targetPath).catch(() => null);
    },
    close() {
      closed = true;
      for (const waiter of queue.splice(0)) waiter(false);
      for (const kill of running.values()) kill();
    },
  };
}
