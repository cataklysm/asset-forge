import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isAbsolute } from 'node:path';
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
}

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
  const verified = await verify(deps).catch(() => false);
  if (verified) return deps.packagePath;
  try {
    deps.warn(FFMPEG_UNAVAILABLE_WARNING);
  } catch {
    // A broken log must not break the start.
  }
  return null;
}

async function verify(deps: FfmpegBinaryDeps): Promise<boolean> {
  const { packagePath } = deps;
  if (typeof packagePath !== 'string' || !isAbsolute(packagePath)) return false;
  const checksums = deps.checksums ?? FFMPEG_CHECKSUMS;
  const key = `${deps.platform}-${deps.arch}`;
  if (!Object.hasOwn(checksums, key)) return false;
  const expected = checksums[key]!.toLowerCase();
  const actual = await (deps.hash ?? hashFile)(packagePath);
  return actual === expected;
}
