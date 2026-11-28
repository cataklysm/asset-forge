import type { ImageSize } from './messages.js';

/** Container of a video; picks the demuxer, which is never guessed from the content. */
export type VideoFormat = 'mp4' | 'webm';

/** Longer edge of an extracted frame; smaller frames are never enlarged. */
export const FRAME_EDGE = 1024;
/** The frame is taken at this second, and at 0 s when the video is shorter. */
export const FRAME_AT_SECONDS = 1;
/** The same decoder pixel limit as for images. */
export const VIDEO_MAX_PIXELS = 100_000_000;

/** The demuxers ffmpeg may use per container; the `-f` and `-format_whitelist` values. */
const DEMUXERS: Record<VideoFormat, string> = { mp4: 'mov,mp4,m4a,3gp,3g2,mj2', webm: 'matroska,webm' };
/** Video decoders the formats can carry; audio and anything else are never opened. */
const DECODERS: Record<VideoFormat, string> = {
  mp4: 'h264,hevc,mpeg4,av1,libdav1d,vp9',
  webm: 'vp8,vp9,av1,libdav1d',
};

/** Scale factor to the displayed size (square pixels), never above 1. */
const FACTOR = `min(1,${FRAME_EDGE}/max(iw*sar,ih))`;
/**
 * Scales to the displayed size with square pixels, longer edge at most FRAME_EDGE, never enlarged.
 * `sar` is 1 when the video does not say.
 */
const SCALE = `scale=w='max(1,trunc(iw*sar*${FACTOR}+0.5))'` + `:h='max(1,trunc(ih*${FACTOR}+0.5))',setsar=1`;

/**
 * Whether `frame` is the size the scale filter `SCALE` gives for a video of displayed size `video`, give or take
 * one pixel per edge.
 *
 * @param video the displayed size the diagnostics reported
 * @param frame the size of the written JPEG
 * @returns true when the two agree
 */
export function frameMatches(video: ImageSize, frame: ImageSize): boolean {
  const factor = Math.min(1, FRAME_EDGE / Math.max(video.width, video.height));
  return (
    Math.abs(Math.max(1, Math.round(video.width * factor)) - frame.width) <= 1 &&
    Math.abs(Math.max(1, Math.round(video.height * factor)) - frame.height) <= 1
  );
}

/**
 * Whether `format` is a container the frame tool knows. Checked at run time, because the caller's type is not
 * trusted to hold.
 *
 * @param format the format the caller passed
 * @returns true for `mp4` and `webm`
 */
export function isVideoFormat(format: string): format is VideoFormat {
  return Object.hasOwn(DEMUXERS, format);
}

/**
 * The argument list of one attempt. `showinfo` stands after the automatic rotation and before the
 * scale, so it prints the stored size and sample aspect ratio of the rotated frame. Both paths
 * carry the `file:` prefix, so nothing in a name can select another protocol.
 *
 * @param sourcePath the video
 * @param format the container, which picks the demuxer and the decoders
 * @param atSeconds the second the frame is taken at
 * @param temporaryPath where the JPEG is written
 * @returns the arguments of the ffmpeg process, without the binary
 */
export function frameArguments(
  sourcePath: string,
  format: VideoFormat,
  atSeconds: number,
  temporaryPath: string,
): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'info',
    '-protocol_whitelist',
    'file',
    '-format_whitelist',
    DEMUXERS[format],
    '-codec_whitelist',
    DECODERS[format],
    '-max_pixels',
    String(VIDEO_MAX_PIXELS),
    '-threads',
    '2',
    '-f',
    DEMUXERS[format],
    '-ss',
    String(atSeconds),
    '-i',
    `file:${sourcePath}`,
    '-map',
    '0:V:0',
    '-an',
    '-sn',
    '-dn',
    '-frames:v',
    '1',
    '-vf',
    `showinfo,${SCALE}`,
    '-c:v',
    'mjpeg',
    '-q:v',
    '3',
    '-f',
    'image2',
    '-update',
    '1',
    '-y',
    `file:${temporaryPath}`,
  ];
}
