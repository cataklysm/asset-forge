import { execFile, type ChildProcess } from 'node:child_process';
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
  ffmpegArguments,
  FRAME_EDGE,
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
}, 120_000);

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
    const args = ffmpegArguments('C:\\v\\a.mp4', 'mp4', 1, 'C:\\c\\f.tmp');
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe('-nostdin');
    expect(value('-protocol_whitelist')).toBe('file');
    expect(value('-max_pixels')).toBe('100000000');
    expect(value('-frames:v')).toBe('1');
    expect(value('-f')).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    expect(value('-i')).toBe('file:C:\\v\\a.mp4');
    expect(args.at(-1)).toBe('file:C:\\c\\f.tmp');
    expect(args).not.toContain('-enable_drefs');
    // The demuxer and the whitelists come before the input.
    for (const flag of ['-protocol_whitelist', '-max_pixels', '-f', '-codec_whitelist']) {
      expect(args.indexOf(flag)).toBeLessThan(args.indexOf('-i'));
    }
    expect(ffmpegArguments('a', 'webm', 0, 'b')[ffmpegArguments('a', 'webm', 0, 'b').indexOf('-f') + 1]).toBe(
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

  it('a timeout while starting answers null and leaves no file', async () => {
    const spawned: ChildProcess[] = [];
    const tool = frames({ timeoutMs: 1, onProcess: (child) => spawned.push(child) });
    const out = join(dir, 'out');
    expect(await tool.extract(fixture('large.mp4'), 'mp4', join(out, 'frame.jpg'))).toBeNull();
    expect(spawned.length).toBeLessThanOrEqual(1);
    for (const child of spawned) expect(isRunning(child.pid)).toBe(false);
    expect(await readdir(out).catch(() => [])).toEqual([]);
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
