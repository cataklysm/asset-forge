import { VIDEO_MAX_PIXELS } from './video-frame-arguments.js';

/** Displayed size (after rotation) and duration of a video. */
export interface VideoInfo {
  width: number;
  height: number;
  /** Positive whole milliseconds, or null when the container does not say. */
  durationMs: number | null;
}

/** Diagnostic lines are read one by one; a longer line is cut to this many characters. */
export const MAX_LINE = 4096;

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

export interface Size {
  width: number;
  height: number;
}

/**
 * The displayed size of the first frame `showinfo` reports (the stored width times the sample
 * aspect ratio); null for such a line with an unusable size (beyond VIDEO_MAX_PIXELS, stored or
 * displayed), undefined for any other line.
 */
function sizeFromLine(line: string): Size | null | undefined {
  const match = /^\[Parsed_showinfo_0 @ [0-9a-fA-Fx]+\] n: +0 .* sar:(\d+)\/(\d+) s:(\d+)x(\d+) /.exec(line);
  if (!match) return undefined;
  const num = Number(match[1]);
  const den = Number(match[2]);
  const stored = Number(match[3]);
  const height = Number(match[4]);
  const width = num > 0 && den > 0 ? Math.round((stored * num) / den) : stored;
  for (const value of [width, stored, height]) {
    if (!Number.isSafeInteger(value) || value < 1) return null;
  }
  if (stored * height > VIDEO_MAX_PIXELS || width * height > VIDEO_MAX_PIXELS) return null;
  return { width, height };
}

/** Reads the diagnostics line by line; keeps only what the result needs. */
export function createDiagnosticsReader(): { line(text: string): void; result(): VideoInfo | null } {
  /** The first duration after the latest input header. */
  let inputDuration: number | null = null;
  let durationSeen = true;
  let mapped = false;
  let durationMs: number | null = null;
  let size: Size | null | undefined;
  return {
    line(text) {
      // The file can make ffmpeg print lines of its choosing (a CodecID with newlines, for one),
      // but only while the input is opened, before ffmpeg prints the input header itself. The
      // duration is the first one after the last input header, and the size the first frame
      // after the last stream mapping, which ffmpeg prints after the header and before any frame.
      if (text.startsWith('Input #0, ')) {
        inputDuration = null;
        durationSeen = false;
        return;
      }
      if (text === 'Stream mapping:') {
        mapped = true;
        durationMs = inputDuration;
        durationSeen = true;
        size = undefined;
        return;
      }
      const duration = durationFromLine(text);
      if (duration !== undefined) {
        if (!durationSeen) inputDuration = duration;
        durationSeen = true;
        return;
      }
      if (mapped && size === undefined) size = sizeFromLine(text);
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
