/** Container of a video; picks the demuxer, which is never guessed from the content. */
export type VideoFormat = 'mp4' | 'webm';

/** Longer edge of an extracted frame; smaller frames are never enlarged. */
export const FRAME_EDGE = 1024;
/** The frame is taken at this second, and at 0 s when the video is shorter. */
export const FRAME_AT_SECONDS = 1;
/** The same decoder pixel limit as for images. */
export const VIDEO_MAX_PIXELS = 100_000_000;

export const DEMUXERS: Record<VideoFormat, string> = { mp4: 'mov,mp4,m4a,3gp,3g2,mj2', webm: 'matroska,webm' };
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
const SCALE =
  `scale=w='max(1,trunc(iw*sar*${FACTOR}+0.5))'` + `:h='max(1,trunc(ih*${FACTOR}+0.5))',setsar=1`;

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
