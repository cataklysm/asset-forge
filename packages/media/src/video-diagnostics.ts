import type { ImageSize } from './messages.js';
import { VIDEO_MAX_PIXELS } from './video-frame-arguments.js';

/** Displayed size (after rotation) and duration of a video. */
export interface VideoInfo {
  /** Displayed width in square pixels. */
  width: number;
  /** Displayed height. */
  height: number;
  /** Positive whole milliseconds, or null when the container does not say. */
  durationMs: number | null;
}

/** Diagnostic lines are read one by one; a longer line is cut to this many characters. */
const MAX_LINE = 4096;

/**
 * The duration of an input header line (`  Duration: 00:00:03.00, …`): milliseconds, null for
 * `N/A` or zero, undefined for any other line. Metadata values are indented further and never match.
 *
 * @param line one diagnostic line
 * @returns the duration in milliseconds, null for an unusable duration, undefined for another line
 */
export function durationFromLine(line: string): number | null | undefined {
  const match = /^ {2}Duration: (?:(N\/A)|(\d+):(\d{2}):(\d{2}(?:\.\d+)?)),/.exec(line);
  if (!match) return undefined;
  if (match[1]) return null;
  const durationMs = Math.round(
    (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4])) * 1000,
  );
  return Number.isSafeInteger(durationMs) && durationMs > 0 ? durationMs : null;
}

/**
 * The displayed size of the first frame `showinfo` reports (the stored width times the sample
 * aspect ratio); null for such a line with an unusable size (beyond VIDEO_MAX_PIXELS, stored or
 * displayed), undefined for any other line.
 *
 * @param line one diagnostic line
 * @returns the displayed size, null for an unusable size, undefined for another line
 */
function sizeFromLine(line: string): ImageSize | null | undefined {
  const match = /^\[Parsed_showinfo_0 @ [0-9a-fA-Fx]+\] n: +0 .* sar:(\d+)\/(\d+) s:(\d+)x(\d+) /.exec(line);
  if (!match) return undefined;
  const aspectNumerator = Number(match[1]);
  const aspectDenominator = Number(match[2]);
  const stored = Number(match[3]);
  const height = Number(match[4]);
  const width =
    aspectNumerator > 0 && aspectDenominator > 0 ? Math.round((stored * aspectNumerator) / aspectDenominator) : stored;
  for (const value of [width, stored, height]) {
    if (!Number.isSafeInteger(value) || value < 1) return null;
  }
  if (stored * height > VIDEO_MAX_PIXELS || width * height > VIDEO_MAX_PIXELS) return null;
  return { width, height };
}

/** Reads the diagnostics line by line; keeps only what the result needs. */
export class DiagnosticsReader {
  /** The first duration after the latest input header. */
  private inputDuration: number | null = null;
  /** A duration line was seen since the latest input header (or none was opened yet). */
  private isDurationSeen = true;
  /** A stream mapping was printed. */
  private isMapped = false;
  /** The duration of the input header before the latest stream mapping. */
  private durationMs: number | null = null;
  /** The size of the first frame after the latest stream mapping; undefined until a frame line was seen. */
  private size: ImageSize | null | undefined;

  /**
   * Takes one diagnostic line.
   *
   * @param text the line without its line break
   */
  line(text: string): void {
    // The file can make ffmpeg print lines of its choosing (a CodecID with newlines, for one),
    // but only while the input is opened, before ffmpeg prints the input header itself. The
    // duration is the first one after the last input header, and the size the first frame
    // after the last stream mapping, which ffmpeg prints after the header and before any frame.
    if (text.startsWith('Input #0, ')) {
      this.inputDuration = null;
      this.isDurationSeen = false;
      return;
    }
    if (text === 'Stream mapping:') {
      this.isMapped = true;
      this.durationMs = this.inputDuration;
      this.isDurationSeen = true;
      this.size = undefined;
      return;
    }
    const duration = durationFromLine(text);
    if (duration !== undefined) {
      if (!this.isDurationSeen) this.inputDuration = duration;
      this.isDurationSeen = true;
      return;
    }
    if (this.isMapped && this.size === undefined) this.size = sizeFromLine(text);
  }

  /**
   * The video info of the lines read so far.
   *
   * @returns the size of the first mapped frame and the duration; null without a mapped frame
   */
  result(): VideoInfo | null {
    return this.isMapped && this.size
      ? { width: this.size.width, height: this.size.height, durationMs: this.durationMs }
      : null;
  }
}

/**
 * Cuts the stderr stream of a process into lines and hands each one on. Only the unfinished last piece of a chunk
 * is kept between chunks; when it grows beyond `MAX_LINE`, that line is dropped, never kept.
 */
export class DiagnosticLines {
  /** The unfinished last piece of the chunks so far. */
  private pending = '';
  /** The current line grew beyond the cap and is dropped. */
  private isCut = false;

  /** @param onLine receives every complete line that was not dropped */
  constructor(private readonly onLine: (line: string) => void) {}

  /**
   * Takes one chunk of the stream.
   *
   * @param chunk the text as decoded
   */
  push(chunk: string): void {
    const lines = chunk.split(/\r?\n|\r/);
    for (let i = 0; i < lines.length; i++) {
      const piece = lines[i] as string;
      if (i < lines.length - 1) {
        if (!this.isCut) this.onLine(this.pending + piece);
        this.pending = '';
        this.isCut = false;
        continue;
      }
      // The unfinished last piece; a line beyond the cap is dropped, not kept.
      if (this.isCut || this.pending.length + piece.length > MAX_LINE) {
        this.pending = '';
        this.isCut = true;
      } else {
        this.pending += piece;
      }
    }
  }

  /** Ends the stream: an unfinished last line that was not dropped is handed on. */
  end(): void {
    if (!this.isCut && this.pending) this.onLine(this.pending);
  }
}

/**
 * The video info a complete diagnostic transcript gives.
 *
 * @param lines the diagnostic lines in order
 * @returns the info; null without a mapped frame
 */
export function readDiagnostics(lines: Iterable<string>): VideoInfo | null {
  const reader = new DiagnosticsReader();
  for (const line of lines) reader.line(line);
  return reader.result();
}
