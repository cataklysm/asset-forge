import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
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

const SCALE =
  `scale=w='if(gte(iw,ih),min(${FRAME_EDGE},iw),-1)'` + `:h='if(gte(iw,ih),-1,min(${FRAME_EDGE},ih))'`;

/**
 * The argument list of one attempt. `showinfo` stands after the automatic rotation and before the
 * scale, so it prints the displayed size of the video. Both paths carry the `file:` prefix, so
 * nothing in a name can select another protocol.
 */
export function ffmpegArguments(sourcePath: string, format: VideoFormat, atSeconds: number, tmpPath: string): string[] {
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

/** The size of the first frame `showinfo` reports, or undefined for any other line. */
function sizeFromLine(line: string): { width: number; height: number } | undefined {
  const match = /^\[Parsed_showinfo_0 @ [0-9a-fA-Fx]+\] n: +0 .* s:(\d+)x(\d+) /.exec(line);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return undefined;
  return { width, height };
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
        child = spawn(binary, ffmpegArguments(sourcePath, format, atSeconds, tmpPath), {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch {
        resolve({ info: null, killed: false });
        return;
      }
      let killed = false;
      let size: { width: number; height: number } | undefined;
      let durationMs: number | null = null;
      let pending = '';
      let cut = false;

      const kill = () => {
        killed = true;
        child.kill();
      };
      const timer = setTimeout(kill, remaining);
      running.set(child, kill);
      options.onProcess?.(child);

      function readLine(line: string): void {
        const duration = durationFromLine(line);
        if (duration !== undefined) durationMs = duration;
        size ??= sizeFromLine(line);
      }

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
      child.once('error', () => undefined);
      child.once('close', (code) => {
        clearTimeout(timer);
        running.delete(child);
        if (!cut && pending) readLine(pending);
        if (killed || code !== 0 || !size) {
          resolve({ info: null, killed });
          return;
        }
        resolve({ info: { width: size.width, height: size.height, durationMs }, killed: false });
      });
    });
  }

  async function frameWritten(path: string): Promise<boolean> {
    try {
      const info = await stat(path);
      return info.isFile() && info.size > 0;
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
        if (result.info && (await frameWritten(tmpPath))) {
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
