import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FFMPEG_CHECKSUMS,
  FFMPEG_UNAVAILABLE_WARNING,
  hashFile,
  resolveFfmpegBinary,
  type FfmpegBinaryDeps,
} from '../src/main/ffmpeg-binary.js';

const CONTENT = Buffer.from('not really ffmpeg, but bytes to hash');
const SHA = createHash('sha256').update(CONTENT).digest('hex');

let base: string;
let binary: string;
const warn = vi.fn<(line: string) => void>();

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-ffmpeg-'));
  binary = join(base, 'ffmpeg.exe');
  await writeFile(binary, CONTENT);
  warn.mockReset();
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function deps(overrides: Partial<FfmpegBinaryDeps> = {}): FfmpegBinaryDeps {
  return { packagePath: binary, platform: 'test', arch: 'x1', checksums: { 'test-x1': SHA }, warn, ...overrides };
}

function expectOneFixedWarning() {
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(FFMPEG_UNAVAILABLE_WARNING);
  expect(FFMPEG_UNAVAILABLE_WARNING).not.toContain(base);
  expect(FFMPEG_UNAVAILABLE_WARNING).not.toMatch(/[\\/]/);
}

describe('resolveFfmpegBinary', () => {
  it('answers the path when the file matches the recorded checksum', async () => {
    await expect(resolveFfmpegBinary(deps())).resolves.toBe(binary);
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts an upper-case recorded checksum', async () => {
    await expect(resolveFfmpegBinary(deps({ checksums: { 'test-x1': SHA.toUpperCase() } }))).resolves.toBe(binary);
  });

  it('answers null with one fixed warning on a mismatch', async () => {
    await writeFile(binary, Buffer.concat([CONTENT, Buffer.from('x')]));
    await expect(resolveFfmpegBinary(deps())).resolves.toBeNull();
    expectOneFixedWarning();
  });

  it('answers null with one fixed warning when the file is missing', async () => {
    await rm(binary);
    await expect(resolveFfmpegBinary(deps())).resolves.toBeNull();
    expectOneFixedWarning();
  });

  it('answers null when the path is a directory', async () => {
    await rm(binary);
    await mkdir(binary);
    await expect(resolveFfmpegBinary(deps())).resolves.toBeNull();
    expectOneFixedWarning();
  });

  it('answers null when the package has no build for the platform', async () => {
    await expect(resolveFfmpegBinary(deps({ packagePath: null }))).resolves.toBeNull();
    expectOneFixedWarning();
  });

  it('answers null for a relative path without hashing it', async () => {
    const hash = vi.fn(hashFile);
    await expect(resolveFfmpegBinary(deps({ packagePath: 'ffmpeg.exe', hash }))).resolves.toBeNull();
    expect(hash).not.toHaveBeenCalled();
    expectOneFixedWarning();
  });

  it('answers null for a platform without a recorded checksum, without hashing', async () => {
    const hash = vi.fn(hashFile);
    await expect(resolveFfmpegBinary(deps({ platform: 'other', hash }))).resolves.toBeNull();
    expect(hash).not.toHaveBeenCalled();
    expectOneFixedWarning();
  });

  it('answers null when hashing fails, and never rejects', async () => {
    const hash = async (): Promise<string> => {
      throw new Error(`EBUSY: ${binary}`);
    };
    await expect(resolveFfmpegBinary(deps({ hash }))).resolves.toBeNull();
    expectOneFixedWarning();
  });

  it('answers null when the warning itself throws', async () => {
    const throwing = () => {
      throw new Error('console gone');
    };
    await expect(resolveFfmpegBinary(deps({ packagePath: null, warn: throwing }))).resolves.toBeNull();
  });
});

describe('hashFile', () => {
  it('hashes the file as SHA-256 hex', async () => {
    await expect(hashFile(binary)).resolves.toBe(SHA);
  });

  it('rejects for a missing file', async () => {
    await expect(hashFile(join(base, 'missing'))).rejects.toThrow();
  });
});

describe('the recorded checksums', () => {
  it('records the win32-x64 build', () => {
    expect(FFMPEG_CHECKSUMS).toEqual({
      'win32-x64': '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
    });
  });

  it.runIf(`${process.platform}-${process.arch}` in FFMPEG_CHECKSUMS)(
    'match the installed binary of this platform',
    async () => {
      const resolved = await resolveFfmpegBinary({
        packagePath: ffmpegPath,
        platform: process.platform,
        arch: process.arch,
        warn,
      });
      expect(resolved).toBe(ffmpegPath);
      expect(warn).not.toHaveBeenCalled();
    },
    30_000,
  );
});
