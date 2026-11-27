import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * Expected SHA-256 of the ffmpeg binary that `ffmpeg-static@5.3.0` downloads, per `<platform>-<arch>`.
 * The lockfile pins the package but not the downloaded file, so the file is checked against this table
 * before the frame tool may run it. A platform without an entry gets no frame tool.
 */
export const FFMPEG_CHECKSUMS: Readonly<Record<string, string>> = Object.freeze({
  'win32-x64': '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
});

/** The one line logged when the binary cannot be used; never names a path or a cause. */
export const FFMPEG_UNAVAILABLE_WARNING = 'The video frame tool is not available; videos get no picture';

export interface FfmpegBinaryDeps {
  /** What the `ffmpeg-static` package answers: an absolute path, or null without a build for this platform. */
  packagePath: string | null;
  platform: string;
  arch: string;
  /** Defaults to `FFMPEG_CHECKSUMS`. */
  checksums?: Readonly<Record<string, string>>;
  warn(line: string): void;
  /** Defaults to `hashFile`. */
  hash?: (path: string) => Promise<string>;
  /**
   * When given, the binary runs from a verified copy named `FFMPEG_RUN_NAME` in this directory, so its
   * process carries the app's own name. Without it, or when the copy cannot be made, the package file runs.
   */
  runDir?: string;
}

/**
 * File name (without extension) of the copy the frame tool runs. Other programs judge a process by
 * its name, and this one only reads single frames from local files.
 */
export const FFMPEG_RUN_NAME = 'assetforge-frames';

/** SHA-256 of a file as lower-case hex, read as a stream. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * The verified path of the ffmpeg binary, or null (with `FFMPEG_UNAVAILABLE_WARNING` logged once) when the
 * package has no build here, the platform has no recorded checksum, the file cannot be read or does not
 * match. Never rejects.
 */
export async function resolveFfmpegBinary(deps: FfmpegBinaryDeps): Promise<string | null> {
  const path = await verify(deps).catch(() => null);
  if (path !== null) return path;
  try {
    deps.warn(FFMPEG_UNAVAILABLE_WARNING);
  } catch {
    // A broken log must not break the start.
  }
  return null;
}

async function verify(deps: FfmpegBinaryDeps): Promise<string | null> {
  const { packagePath } = deps;
  if (typeof packagePath !== 'string' || !isAbsolute(packagePath)) return null;
  const checksums = deps.checksums ?? FFMPEG_CHECKSUMS;
  const key = `${deps.platform}-${deps.arch}`;
  if (!Object.hasOwn(checksums, key)) return null;
  const expected = checksums[key]!.toLowerCase();
  const hash = deps.hash ?? hashFile;
  const matches = async (path: string): Promise<boolean> => (await hash(path)) === expected;

  if (deps.runDir === undefined) return (await matches(packagePath)) ? packagePath : null;

  const copy = join(deps.runDir, `${FFMPEG_RUN_NAME}${extname(packagePath)}`);
  if (await matches(copy).catch(() => false)) return copy;
  if (!(await matches(packagePath))) return null;
  try {
    const staged = `${copy}.${process.pid}.tmp`;
    await mkdir(deps.runDir, { recursive: true });
    await copyFile(packagePath, staged);
    try {
      await chmod(staged, 0o755);
      await rename(staged, copy);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
    if (await matches(copy)) return copy;
  } catch {
    // Without the copy the verified package file runs under its own name.
  }
  return packagePath;
}
