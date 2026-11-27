import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Container of a video; picks the demuxer, which is never guessed from the content. */
export type VideoFormat = 'mp4' | 'webm';

/** Displayed size (after rotation) and duration of a video. */
export interface VideoInfo {
  width: number;
  height: number;
  /** Positive whole milliseconds, or null when the container does not say. */
  durationMs: number | null;
}

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
/** Longer edge of an extracted frame; smaller frames are never enlarged. */
export const FRAME_EDGE = 1024;
/** The frame is taken at this second, and at 0 s when the video is shorter. */
export const FRAME_AT_SECONDS = 1;
/** The same decoder pixel limit as for images. */
export const VIDEO_MAX_PIXELS = 100_000_000;

const DEMUXERS: Record<VideoFormat, string> = { mp4: 'mov,mp4,m4a,3gp,3g2,mj2', webm: 'matroska,webm' };
/** Video decoders the formats can carry; audio and anything else are never opened. */
const DECODERS: Record<VideoFormat, string> = {
  mp4: 'h264,hevc,mpeg4,av1,libdav1d,vp9',
  webm: 'vp8,vp9,av1,libdav1d',
};
/** Diagnostic lines are read one by one; a longer line is cut to this many characters. */
const MAX_LINE = 4096;

/** Scale factor to the displayed size (square pixels), never above 1. */
const FACTOR = `min(1,${FRAME_EDGE}/max(iw*sar,ih))`;
/**
 * Scales to the displayed size with square pixels, longer edge at most FRAME_EDGE, never enlarged.
 * `sar` is 1 when the video does not say.
 */
const SCALE =
  `scale=w='max(1,trunc(iw*sar*${FACTOR}+0.5))'` + `:h='max(1,trunc(ih*${FACTOR}+0.5))',setsar=1`;

/** A grace period after kill(): the attempt is given up when the process has not exited by then. */
export const KILL_GRACE_MS = 2000;
/** A written frame larger than this is not read back. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * The argument list of one attempt. `showinfo` stands after the automatic rotation and before the
 * scale, so it prints the stored size and sample aspect ratio of the rotated frame. Both paths
 * carry the `file:` prefix, so nothing in a name can select another protocol.
 */
export function frameArguments(sourcePath: string, format: VideoFormat, atSeconds: number, tmpPath: string): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-nostats',
    '-loglevel', 'info',
    '-protocol_whitelist', 'file',
    '-format_whitelist', DEMUXERS[format],
    '-codec_whitelist', DECODERS[format],
    '-max_pixels', String(VIDEO_MAX_PIXELS),
    '-threads', '2',
    '-f', DEMUXERS[format],
    '-ss', String(atSeconds),
    '-i', `file:${sourcePath}`,
    '-map', '0:V:0',
    '-an', '-sn', '-dn',
    '-frames:v', '1',
    '-vf', `showinfo,${SCALE}`,
    '-c:v', 'mjpeg',
    '-q:v', '3',
    '-f', 'image2',
    '-update', '1',
    '-y',
    `file:${tmpPath}`,
  ];
}

/**
 * The duration of an input header line (`  Duration: 00:00:03.00, …`): milliseconds, null for
 * `N/A` or zero, undefined for any other line. Metadata values are indented further and never match.
 */
export function durationFromLine(line: string): number | null | undefined {
  const match = /^ {2}Duration: (?:(N\/A)|(\d+):(\d{2}):(\d{2}(?:\.\d+)?)),/.exec(line);
  if (!match) return undefined;
  if (match[1]) return null;
  const ms = Math.round(
    (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4])) * 1000,
  );
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

interface Size {
  width: number;
  height: number;
}

/**
 * The displayed size of the first frame `showinfo` reports (the stored width times the sample
 * aspect ratio), or undefined for any other line.
 */
function sizeFromLine(line: string): Size | undefined {
  const match = /^\[Parsed_showinfo_0 @ [0-9a-fA-Fx]+\] n: +0 .* sar:(\d+)\/(\d+) s:(\d+)x(\d+) /.exec(line);
  if (!match) return undefined;
  const num = Number(match[1]);
  const den = Number(match[2]);
  const stored = Number(match[3]);
  const height = Number(match[4]);
  const width = num > 0 && den > 0 ? Math.round((stored * num) / den) : stored;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return undefined;
  return { width, height };
}

/** Reads the diagnostics line by line; keeps only what the result needs. */
function createDiagnosticsReader(): { line(text: string): void; result(): VideoInfo | null } {
  let lastDuration: number | null = null;
  let mapped = false;
  let durationMs: number | null = null;
  let size: Size | undefined;
  return {
    line(text) {
      // The file can make ffmpeg print lines of its choosing (a CodecID with newlines, for one),
      // but only while the input is opened. Everything is read as of the last stream mapping,
      // which ffmpeg prints itself after the input header and before the first frame.
      if (text === 'Stream mapping:') {
        mapped = true;
        durationMs = lastDuration;
        size = undefined;
        return;
      }
      const duration = durationFromLine(text);
      if (duration !== undefined) {
        lastDuration = duration;
        return;
      }
      if (mapped) size ??= sizeFromLine(text);
    },
    result() {
      return mapped && size ? { width: size.width, height: size.height, durationMs } : null;
    },
  };
}

/** The video info a complete diagnostic transcript gives; null without a mapped frame. */
export function readDiagnostics(lines: Iterable<string>): VideoInfo | null {
  const reader = createDiagnosticsReader();
  for (const line of lines) reader.line(line);
  return reader.result();
}

/** True when `frame` is the size the scale filter gives for a video of displayed size `video`. */
export function frameMatches(video: Size, frame: Size): boolean {
  const factor = Math.min(1, FRAME_EDGE / Math.max(video.width, video.height));
  return (
    Math.abs(Math.max(1, Math.round(video.width * factor)) - frame.width) <= 1 &&
    Math.abs(Math.max(1, Math.round(video.height * factor)) - frame.height) <= 1
  );
}

/** Width and height from the first start-of-frame marker of a JPEG; null for anything else. */
export function jpegDimensions(bytes: Uint8Array): Size | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > bytes.length) return null;
      const height = ((bytes[offset + 5] as number) << 8) | (bytes[offset + 6] as number);
      const width = ((bytes[offset + 7] as number) << 8) | (bytes[offset + 8] as number);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

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
        try {
          child.kill();
        } catch {
          // Settled below all the same.
        }
        // A process that does not exit is given up: the slot is freed and the caller cleans up.
        grace = setTimeout(() => settle({ info: null, killed: true }), killGraceMs);
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
      child.once('error', () => settle({ info: null, killed }));
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
