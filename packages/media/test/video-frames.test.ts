import { execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createVideoFrames,
  durationFromLine,
  frameArguments,
  frameMatches,
  FRAME_EDGE,
  jpegDimensions,
  KILL_GRACE_MS,
  readDiagnostics,
  VIDEO_FRAME_CONCURRENCY,
  VIDEO_FRAME_TIMEOUT_MS,
  type VideoFrames,
} from '../src/video-frames.js';

const FFMPEG = ffmpegPath as string;

let fixtures: string;
let dir: string;
const tools: VideoFrames[] = [];

/** Runs the bundled ffmpeg to build a fixture; only lavfi sources and local files. */
function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function fixture(name: string): string {
  return join(fixtures, name);
}

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'assetforge-video-'));
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'sine=duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture('h264.mp4'),
  ]);
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture('large.mp4'),
  ]);
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', fixture('vp9.webm'),
  ]);
  await ffmpeg(['-display_rotation', '90', '-i', fixture('h264.mp4'), '-c', 'copy', fixture('rotated.mp4')]);
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=0.4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture('short.mp4'),
  ]);
  const whole = await readFile(fixture('h264.mp4'));
  await writeFile(fixture('truncated.mp4'), whole.subarray(0, Math.floor(whole.length / 2)));
  await writeFile(
    fixture('image.mp4'),
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#38a' } }).png().toBuffer(),
  );
  await writeFile(fixture('text.mp4'), 'This is not a video.\n');
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2',
    '-vf', 'setsar=16/15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture('anamorphic.mp4'),
  ]);
  await writeFile(fixture('forged.webm'), withForgedTrack(await webmToBuffer(), FORGED_CODEC_ID));
}, 120_000);

/** A log line as `showinfo` prints it, but with a size the video does not have. */
const FORGED_SHOWINFO =
  '[Parsed_showinfo_0 @ 0000000000000000] n:   0 pts:      0 pts_time:0       duration:     40 ' +
  'fmt:yuv420p cl:left sar:1/1 s:99999x1 i:P iskey:1 type:I';
/**
 * The CodecID of an extra track: matroskadec logs an unknown one at info level, newlines included,
 * so these lines show up in the diagnostics as if ffmpeg had written them.
 */
const FORGED_CODEC_ID = `S_FORGED\nStream mapping:\n${FORGED_SHOWINFO}\n  Duration: 09:00:00.00, start: 0.000000, bitrate: N/A\nStream mapping:\n${FORGED_SHOWINFO}\n`;

/** A 2 s VP9 WebM written to a pipe, so the segment has an unknown size and can grow. */
function webmToBuffer(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG,
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2',
        '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-f', 'webm', 'pipe:1'],
      { windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** EBML element size as an 8-byte vint. */
function size8(length: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(length));
  bytes[0] = 0x01;
  return bytes;
}

function element(id: number[], content: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), size8(content.length), content]);
}

/** Length of the vint at `offset`, from its leading zero bits. */
function vintLength(byte: number): number {
  let length = 1;
  while (length <= 8 && !(byte & (0x80 >> (length - 1)))) length++;
  return length;
}

function readSize(bytes: Buffer, offset: number): { length: number; value: number } {
  const length = vintLength(bytes[offset] as number);
  let value = (bytes[offset] as number) & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + (bytes[offset + i] as number);
  return { length, value };
}

/** Appends a subtitle track with the given CodecID to the Tracks element of a WebM. */
function withForgedTrack(webm: Buffer, codecId: string): Buffer {
  const header = readSize(webm, 4);
  let offset = 4 + header.length + header.value;
  // Segment: ID of four bytes, then its (unknown) size.
  const segmentSize = readSize(webm, offset + 4);
  offset += 4 + segmentSize.length;
  while (offset < webm.length) {
    const idLength = vintLength(webm[offset] as number);
    const id = webm.readUIntBE(offset, idLength);
    const size = readSize(webm, offset + idLength);
    const contentStart = offset + idLength + size.length;
    if (id === 0x1654ae6b) {
      const entry = element(
        [0xae],
        Buffer.concat([
          Buffer.from([0xd7, 0x81, 0x02, 0x73, 0xc5, 0x81, 0x02, 0x83, 0x81, 0x11]),
          element([0x86], Buffer.from(codecId, 'latin1')),
        ]),
      );
      const tracks = element([0x16, 0x54, 0xae, 0x6b], Buffer.concat([webm.subarray(contentStart, contentStart + size.value), entry]));
      return Buffer.concat([webm.subarray(0, offset), tracks, webm.subarray(contentStart + size.value)]);
    }
    offset = contentStart + size.value;
  }
  throw new Error('No Tracks element');
}

afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'assetforge-frames-'));
});

afterEach(async () => {
  for (const tool of tools.splice(0)) tool.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

function frames(options: Partial<Parameters<typeof createVideoFrames>[0]> = {}): VideoFrames {
  const created = createVideoFrames({ binaryPath: FFMPEG, ...options });
  tools.push(created);
  return created;
}

async function jpegSize(path: string): Promise<{ width: number; height: number; format: string }> {
  const meta = await sharp(await readFile(path)).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0, format: meta.format ?? '' };
}

function isRunning(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('video frames', () => {
  it('the bundled binary exists', () => {
    expect(typeof ffmpegPath).toBe('string');
  });

  it('defaults are 2 processes, 20 s and a longer edge of 1024', () => {
    expect(VIDEO_FRAME_CONCURRENCY).toBe(2);
    expect(VIDEO_FRAME_TIMEOUT_MS).toBe(20_000);
    expect(FRAME_EDGE).toBe(1024);
  });

  it('the arguments carry every hardening option', () => {
    const args = frameArguments('C:\\v\\a.mp4', 'mp4', 1, 'C:\\c\\f.tmp');
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe('-nostdin');
    expect(value('-protocol_whitelist')).toBe('file');
    expect(value('-max_pixels')).toBe('100000000');
    expect(value('-frames:v')).toBe('1');
    expect(value('-f')).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    expect(value('-i')).toBe('file:C:\\v\\a.mp4');
    expect(args.at(-1)).toBe('file:C:\\c\\f.tmp');
    expect(args).not.toContain('-enable_drefs');
    // The only protocol option, given once, before the input.
    expect(args.filter((arg) => arg.includes('protocol'))).toEqual(['-protocol_whitelist']);
    expect(value('-format_whitelist')).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    // The demuxer and the whitelists come before the input.
    for (const flag of ['-protocol_whitelist', '-max_pixels', '-f', '-codec_whitelist']) {
      expect(args.indexOf(flag)).toBeLessThan(args.indexOf('-i'));
    }
    expect(frameArguments('a', 'webm', 0, 'b')[frameArguments('a', 'webm', 0, 'b').indexOf('-f') + 1]).toBe(
      'matroska,webm',
    );
  });

  it('reads the duration line and treats N/A as unknown', () => {
    expect(durationFromLine('  Duration: 00:00:03.00, start: 0.000000, bitrate: 45 kb/s')).toBe(3000);
    expect(durationFromLine('  Duration: 01:02:03.45, start: 0.000000')).toBe(3_723_450);
    expect(durationFromLine('  Duration: N/A, start: 0.000000, bitrate: N/A')).toBeNull();
    expect(durationFromLine('  Duration: 00:00:00.00, start: 0.000000')).toBeNull();
    // Metadata values are indented further and never count.
    expect(durationFromLine('    title           : Duration: 00:00:09.00')).toBeUndefined();
    expect(durationFromLine('Stream #0:0')).toBeUndefined();
  });

  it('extracts a frame and reads size and duration of an H.264 MP4', async () => {
    const target = join(dir, 'ab', 'frame.jpg');
    const info = await frames().extract(fixture('h264.mp4'), 'mp4', target);
    expect(info).toEqual({ width: 320, height: 240, durationMs: 3000 });
    expect(await jpegSize(target)).toEqual({ width: 320, height: 240, format: 'jpeg' });
    expect(await readdir(join(dir, 'ab'))).toEqual(['frame.jpg']);
  });

  it('extracts a frame of a VP9 WebM', async () => {
    const target = join(dir, 'frame.jpg');
    const info = await frames().extract(fixture('vp9.webm'), 'webm', target);
    expect(info).toMatchObject({ width: 320, height: 240 });
    expect(info?.durationMs).toBeGreaterThanOrEqual(1900);
    expect(info?.durationMs).toBeLessThanOrEqual(2100);
    expect((await jpegSize(target)).format).toBe('jpeg');
  });

  it('scales the frame down to 1024 on the longer edge and reports the video size', async () => {
    const target = join(dir, 'frame.jpg');
    expect(await frames().extract(fixture('large.mp4'), 'mp4', target)).toEqual({
      width: 1280,
      height: 720,
      durationMs: 2000,
    });
    expect(await jpegSize(target)).toMatchObject({ width: 1024, height: 576 });
  });

  it('a rotated video reports the displayed size', async () => {
    const target = join(dir, 'frame.jpg');
    expect(await frames().extract(fixture('rotated.mp4'), 'mp4', target)).toMatchObject({ width: 240, height: 320 });
    expect(await jpegSize(target)).toMatchObject({ width: 240, height: 320 });
  });

  it('an anamorphic video reports and shows its displayed size', async () => {
    const target = join(dir, 'frame.jpg');
    expect(await frames().extract(fixture('anamorphic.mp4'), 'mp4', target)).toMatchObject({ width: 341, height: 240 });
    expect(await jpegSize(target)).toMatchObject({ width: 341, height: 240 });
  });

  it('log lines forged by the file do not set the size or the duration', async () => {
    // Control: ffmpeg does print the forged lines at the start of a line.
    const stderr = await new Promise<string>((resolve) => {
      execFile(FFMPEG, ['-nostdin', '-hide_banner', '-i', fixture('forged.webm')], { windowsHide: true }, (_e, _o, err) =>
        resolve(String(err)),
      );
    });
    expect(stderr.split(/\r?\n/), stderr).toContain(FORGED_SHOWINFO);
    const target = join(dir, 'frame.jpg');
    const info = await frames().extract(fixture('forged.webm'), 'webm', target);
    expect(info).toMatchObject({ width: 320, height: 240 });
    // Written to a pipe, the WebM has no duration; the forged 9 h must not stand in for it.
    expect(info?.durationMs).toBeNull();
    expect(await jpegSize(target)).toMatchObject({ width: 320, height: 240 });
  });

  it('a video shorter than one second gives its first frame', async () => {
    const target = join(dir, 'frame.jpg');
    const info = await frames().extract(fixture('short.mp4'), 'mp4', target);
    expect(info).toMatchObject({ width: 320, height: 240 });
    expect(info?.durationMs).toBeGreaterThan(0);
    expect(info?.durationMs).toBeLessThan(1000);
    expect((await jpegSize(target)).format).toBe('jpeg');
  });

  it.each([
    ['image.mp4', 'mp4'],
    ['truncated.mp4', 'mp4'],
    ['text.mp4', 'mp4'],
    ['text.mp4', 'webm'],
    // The demuxer comes from the format, never from the content.
    ['vp9.webm', 'mp4'],
    ['h264.mp4', 'webm'],
    ['missing.mp4', 'mp4'],
  ] as const)('%s as %s answers null and leaves nothing', async (name, format) => {
    const target = join(dir, 'out', 'frame.jpg');
    expect(await frames().extract(fixture(name), format, target)).toBeNull();
    expect(await readdir(join(dir, 'out')).catch(() => [])).toEqual([]);
  });

  it('an unknown format answers null without a process', async () => {
    const spawned: ChildProcess[] = [];
    const tool = frames({ onProcess: (child) => spawned.push(child) });
    expect(await tool.extract(fixture('h264.mp4'), 'mkv' as 'mp4', join(dir, 'frame.jpg'))).toBeNull();
    expect(spawned).toHaveLength(0);
  });

  it('a null binary path answers null', async () => {
    expect(await frames({ binaryPath: null }).extract(fixture('h264.mp4'), 'mp4', join(dir, 'f.jpg'))).toBeNull();
    expect(
      await frames({ binaryPath: Promise.resolve(null) }).extract(fixture('h264.mp4'), 'mp4', join(dir, 'f.jpg')),
    ).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it('a binary path given as a promise is awaited', async () => {
    const target = join(dir, 'frame.jpg');
    const tool = frames({ binaryPath: Promise.resolve(FFMPEG) });
    expect(await tool.extract(fixture('h264.mp4'), 'mp4', target)).toMatchObject({ width: 320 });
  });

  it('a binary that does not exist answers null', async () => {
    const tool = frames({ binaryPath: join(dir, 'no-ffmpeg.exe') });
    expect(await tool.extract(fixture('h264.mp4'), 'mp4', join(dir, 'out', 'frame.jpg'))).toBeNull();
    expect(await readdir(join(dir, 'out')).catch(() => [])).toEqual([]);
  });

  describe.runIf(process.platform === 'win32')('a process that hangs', () => {
    let pipe: string;
    let server: Server;

    // A local named pipe that accepts and never sends a byte: ffmpeg blocks on its first read.
    beforeEach(async () => {
      pipe = String.raw`\\.\pipe\assetforge-hang-` + `${process.pid}-${Date.now()}`;
      server = createServer(() => undefined);
      await new Promise<void>((resolve) => server.listen(pipe, resolve));
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('a timeout kills the process and leaves no file', async () => {
      const spawned: ChildProcess[] = [];
      const tool = frames({ timeoutMs: 800, onProcess: (child) => spawned.push(child) });
      const out = join(dir, 'out');
      const started = Date.now();
      expect(await tool.extract(pipe, 'mp4', join(out, 'frame.jpg'))).toBeNull();
      expect(Date.now() - started).toBeGreaterThanOrEqual(750);
      // A timeout is final: no second attempt at 0 s.
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.killed).toBe(true);
      expect(isRunning(spawned[0]?.pid)).toBe(false);
      expect(await readdir(out).catch(() => [])).toEqual([]);
    });

    it('close kills running processes, answers queued calls and refuses new ones', async () => {
      const spawned: ChildProcess[] = [];
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const tool = frames({
        concurrency: 1,
        onProcess: (child) => {
          spawned.push(child);
          child.once('spawn', () => started());
        },
      });
      const out = join(dir, 'out');
      const first = tool.extract(pipe, 'mp4', join(out, 'a.jpg'));
      const queued = tool.extract(fixture('h264.mp4'), 'mp4', join(out, 'b.jpg'));
      await running;
      // Let ffmpeg reach its blocking read.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(isRunning(spawned[0]?.pid)).toBe(true);
      tool.close();
      expect(await first).toBeNull();
      expect(await queued).toBeNull();
      expect(await tool.extract(fixture('h264.mp4'), 'mp4', join(out, 'c.jpg'))).toBeNull();
      expect(spawned).toHaveLength(1);
      expect(isRunning(spawned[0]?.pid)).toBe(false);
      expect(await readdir(out).catch(() => [])).toEqual([]);
    });
  });

  describe('a process that misbehaves', () => {
    /** A child that never exits by itself and, unless told otherwise, ignores kill(). */
    function fakeChild(): ChildProcess & { kills: number } {
      const child = new EventEmitter() as ChildProcess & { kills: number };
      Object.assign(child, { stderr: new PassThrough(), pid: undefined, kills: 0 });
      child.kill = () => {
        child.kills++;
        return true;
      };
      return child;
    }

    it('a spawn that throws answers null and frees the slot', async () => {
      let calls = 0;
      const tool = frames({
        concurrency: 1,
        spawnProcess: () => {
          calls++;
          throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
        },
      });
      const out = join(dir, 'out');
      expect(await tool.extract(fixture('h264.mp4'), 'mp4', join(out, 'a.jpg'))).toBeNull();
      expect(await tool.extract(fixture('h264.mp4'), 'mp4', join(out, 'b.jpg'))).toBeNull();
      // Two attempts per call (1 s, then 0 s), each refused at once.
      expect(calls).toBe(4);
      expect(await readdir(out).catch(() => [])).toEqual([]);
    });

    it('an error event without a close settles the call', async () => {
      const children: ReturnType<typeof fakeChild>[] = [];
      const tool = frames({
        concurrency: 1,
        timeoutMs: 60_000,
        spawnProcess: () => {
          const child = fakeChild();
          children.push(child);
          queueMicrotask(() => child.emit('error', Object.assign(new Error('EMFILE'), { code: 'EMFILE' })));
          return child;
        },
      });
      const started = Date.now();
      const results = await Promise.all([
        tool.extract(fixture('h264.mp4'), 'mp4', join(dir, 'a.jpg')),
        tool.extract(fixture('h264.mp4'), 'mp4', join(dir, 'b.jpg')),
      ]);
      expect(results).toEqual([null, null]);
      expect(Date.now() - started).toBeLessThan(5000);
      // A late close after the error changes nothing.
      for (const child of children) child.emit('close', 0);
      expect(await readdir(dir)).toEqual([]);
    });

    it('a process that ignores the kill is given up after the grace period', async () => {
      const children: ReturnType<typeof fakeChild>[] = [];
      const tool = frames({
        concurrency: 1,
        timeoutMs: 200,
        killGraceMs: 300,
        spawnProcess: () => {
          const child = fakeChild();
          children.push(child);
          return child;
        },
      });
      const started = Date.now();
      expect(await tool.extract(fixture('h264.mp4'), 'mp4', join(dir, 'a.jpg'))).toBeNull();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(5000);
      expect(children[0]?.kills).toBe(1);
      // The slot is free again: the next call starts its own process.
      expect(await tool.extract(fixture('h264.mp4'), 'mp4', join(dir, 'b.jpg'))).toBeNull();
      expect(children).toHaveLength(2);
      expect(await readdir(dir)).toEqual([]);
    });

    it('a kill that errors at once, and a second error, settle the call once', async () => {
      const tool = frames({
        timeoutMs: 100,
        killGraceMs: 60_000,
        spawnProcess: () => {
          const child = fakeChild();
          child.kill = () => {
            child.emit('error', new Error('kill failed'));
            // A later error without a listener would be thrown as an uncaught exception.
            setTimeout(() => child.emit('error', new Error('again')), 0);
            return false;
          };
          return child;
        },
      });
      const started = Date.now();
      expect(await tool.extract(fixture('h264.mp4'), 'mp4', join(dir, 'a.jpg'))).toBeNull();
      // Settled by the error, not after the grace period.
      expect(Date.now() - started).toBeLessThan(5000);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    it('the grace period is 2 s by default', () => {
      expect(KILL_GRACE_MS).toBe(2000);
    });
  });

  describe('reading the diagnostics', () => {
    const mapping = 'Stream mapping:';
    const info = (s: string, sar = '1/1') =>
      `[Parsed_showinfo_0 @ 000001d2c3f0] n:   0 pts:      0 pts_time:0 duration: 1 fmt:yuv420p cl:left sar:${sar} s:${s} i:P iskey:1`;

    it('takes the size of the first frame after the last stream mapping', () => {
      expect(
        readDiagnostics([
          '  Duration: 09:00:00.00, start: 0.000000',
          mapping,
          info('99999x1'),
          'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from real',
          '  Duration: 00:00:02.00, start: 0.000000',
          mapping,
          info('320x240'),
          info('640x480'),
        ]),
      ).toEqual({ width: 320, height: 240, durationMs: 2000 });
    });

    it('a duration line after the mapping does not count', () => {
      expect(
        readDiagnostics([
          'Input #0, mov',
          '  Duration: 00:00:02.00, start: 0',
          mapping,
          '  Duration: 09:00:00.00, start: 0',
          info('320x240'),
        ]),
      ).toEqual({ width: 320, height: 240, durationMs: 2000 });
    });

    it('no size before a mapping and none without a frame', () => {
      expect(readDiagnostics([info('320x240')])).toBeNull();
      expect(readDiagnostics(['  Duration: 00:00:02.00, start: 0', mapping])).toBeNull();
    });

    it('applies the sample aspect ratio to the width', () => {
      expect(readDiagnostics([mapping, info('320x240', '16/15')])).toMatchObject({ width: 341, height: 240 });
      expect(readDiagnostics([mapping, info('320x240', '0/1')])).toMatchObject({ width: 320, height: 240 });
    });

    it('a size beyond the pixel limit answers null', () => {
      expect(readDiagnostics([mapping, info('10000x10000')])).toMatchObject({ width: 10000, height: 10000 });
      expect(readDiagnostics([mapping, info('10001x10000')])).toBeNull();
      // The sample aspect ratio counts: a stored 320x240 at 100000:1 is far too wide.
      expect(readDiagnostics([mapping, info('320x240', '100000/1')])).toBeNull();
    });

    it('a forged size before the mapping does not count even when it scales to the same frame', () => {
      expect(readDiagnostics(['Input #0, mov', '  Duration: 00:00:02.00, start: 0', info('8000x4000'), mapping, info('4000x2000')]))
        .toEqual({ width: 4000, height: 2000, durationMs: 2000 });
    });

    it('takes the first duration after the last input header', () => {
      expect(
        readDiagnostics([
          'Input #0, matroska,webm, from forged',
          '  Duration: 09:00:00.00, start: 0',
          'Input #0, matroska,webm, from real',
          '  Duration: 00:00:02.00, start: 0',
          '  Duration: 05:00:00.00, start: 0',
          mapping,
          info('320x240'),
        ]),
      ).toEqual({ width: 320, height: 240, durationMs: 2000 });
      expect(readDiagnostics(['  Duration: 00:00:02.00, start: 0', mapping, info('320x240')])).toMatchObject({
        durationMs: null,
      });
    });

    it('the frame must have the size the video scales to', () => {
      expect(frameMatches({ width: 320, height: 240 }, { width: 320, height: 240 })).toBe(true);
      expect(frameMatches({ width: 1280, height: 720 }, { width: 1024, height: 576 })).toBe(true);
      expect(frameMatches({ width: 1281, height: 721 }, { width: 1024, height: 577 })).toBe(true);
      expect(frameMatches({ width: 99999, height: 1 }, { width: 320, height: 240 })).toBe(false);
      expect(frameMatches({ width: 640, height: 480 }, { width: 320, height: 240 })).toBe(false);
    });

    it('reads the size of a JPEG and nothing else', async () => {
      const jpeg = await sharp({ create: { width: 33, height: 17, channels: 3, background: '#808080' } }).jpeg().toBuffer();
      expect(jpegDimensions(jpeg)).toEqual({ width: 33, height: 17 });
      const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#808080' } }).png().toBuffer();
      expect(jpegDimensions(png)).toBeNull();
      expect(jpegDimensions(jpeg.subarray(0, 10))).toBeNull();
    });
  });

  it.each([1, VIDEO_FRAME_CONCURRENCY])('runs at most %i processes at a time', async (concurrency) => {
    let active = 0;
    let peak = 0;
    const tool = frames({
      ...(concurrency === VIDEO_FRAME_CONCURRENCY ? {} : { concurrency }),
      onProcess: (child) => {
        active++;
        peak = Math.max(peak, active);
        child.once('close', () => active--);
      },
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => tool.extract(fixture('h264.mp4'), 'mp4', join(dir, `${i}.jpg`))),
    );
    expect(results.every((info) => info?.width === 320)).toBe(true);
    expect(peak).toBe(concurrency);
  });

  describe('never opens a network address', () => {
    let server: Server;
    let port: number;
    let connections: number;

    beforeAll(async () => {
      connections = 0;
      server = createServer((socket) => {
        connections++;
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as { port: number }).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    function contents(): Record<string, string> {
      const url = `http://127.0.0.1:${port}`;
      return {
        'playlist.mp4': `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${url}/segment.ts\n#EXT-X-ENDLIST\n`,
        'concat.mp4': `ffconcat version 1.0\nfile '${url}/clip.mp4'\n`,
        'url.mp4': `${url}/video.mp4\n`,
      };
    }

    it('the local server sees a connection from an ffmpeg that allows http', async () => {
      // Control: the playlist does reach the server when the protocols are not restricted.
      const playlist = join(dir, 'playlist.m3u8');
      await writeFile(playlist, contents()['playlist.mp4'] as string);
      const before = connections;
      await ffmpeg(['-protocol_whitelist', 'file,http,tcp', '-f', 'hls', '-i', playlist, '-f', 'null', '-']).catch(
        () => undefined,
      );
      expect(connections).toBeGreaterThan(before);
    });

    it.each(['playlist.mp4', 'concat.mp4', 'url.mp4'])('%s answers null with no connection', async (name) => {
      const source = join(dir, name);
      await writeFile(source, contents()[name] as string);
      const before = connections;
      const tool = frames();
      expect(await tool.extract(source, 'mp4', join(dir, 'out', 'a.jpg'))).toBeNull();
      expect(await tool.extract(source, 'webm', join(dir, 'out', 'b.jpg'))).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(connections).toBe(before);
      await mkdir(join(dir, 'out'), { recursive: true });
      expect(await readdir(join(dir, 'out'))).toEqual([]);
    });
  });
});
