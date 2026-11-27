# Video playback — design

Date: 2026-11-27. Status: approved. Size: a project across contracts, core, persistence, media, main and
renderer, with one new binary dependency.

## Intent

The owner collects MP4 files beside images. Today such a file has the kind `other`: a tile with the text
`MP4`, no picture, no way to look at it inside the app, and "Open externally" is not offered. The owner wants
to see what a video is and play it where they already look at images.

## Goals

- `mp4`, `m4v` and `webm` files are files of a new kind `video`, also the ones imported before this change.
- A video plays in the file detail dialog, in the place of the image, with seeking, without the file ever
  being loaded whole.
- A video has a picture: one frame of it is the tile, the film strip entry, the start image of the player and
  can be the asset cover.
- The details show duration and dimensions.
- The app keeps working when the frame tool is missing or fails: no picture, everything else as designed.

## Non-goals

- `mov`, `mkv`, `avi` and audio files.
- Converting a video the built-in player cannot decode.
- Analysis, Image to prompt and the generation studio for videos.
- Choosing the frame, a preview on hover, scrubbing over a tile, chapters, subtitles, a loop or speed control
  of our own, picture-in-picture.
- A packaged build that ships the tool (no packager exists yet).

## Anti-goals

- A video must never reach Sharp, the vision provider or the image provider.
- The frame tool must never open a network address or any file other than the one video it was given.
- The image paths (preview, original, viewer) must not change behaviour.

## Approaches

**The picture.**

1. **ffmpeg as a bundled program, run as a bounded child process (chosen, owner's decision).** Works for
   every codec, testable without the app, isolated in its own process. Costs a binary of about 80 MB fetched
   at install (a GPL build: fine for own use, to be dealt with before the app is distributed).
2. A hidden browser window that loads the video and captures a frame. No dependency, but only for codecs
   Chromium decodes, and not testable without launching the app. Rejected.
3. ffmpeg compiled to WebAssembly. Reads the whole file into memory. Rejected.

**Playback.**

1. **The existing `assetforge-media://` protocol with byte ranges (chosen).** One controlled way for media
   into the renderer, as the architecture rules demand.
2. A local HTTP server. Opens a port on the machine. Rejected.
3. `file://`. Forbidden by the architecture rules.

## Design

### Kind and MIME type (contracts, core)

- `FileKindSchema` gets `video`. `FILE_KIND_EXTENSIONS.video = ['mp4', 'm4v', 'webm']`; `fileKind` knows the
  kind.
- `MIME_BY_EXTENSION`: `mp4` and `m4v` → `video/mp4`, `webm` → `video/webm`.
- `VIDEO_MIME_TYPES = ['video/mp4', 'video/webm']` and `isVideo(mimeType)` in `media-types.ts`.
- `PREVIEWABLE_MIME_TYPES` and `isPreviewable` are unchanged and keep meaning "a raster image Sharp reads".
  Everything that asks them (analysis targets and their SQL, studio input, `files:measure` through Sharp, the
  image viewer) therefore stays image-only without a change.
- A second predicate `hasThumbnail(mimeType)` = previewable or video. `FileRecord` gets
  `thumbnail: boolean` (from it) and `durationMs: number | null` (positive integer).
- Cover: a video can be chosen as the cover (`setAssetCover` asks `hasThumbnail`). The automatic cover
  prefers images: the earliest complete previewable image as today, and only when the asset has none the
  earliest complete video (same order rule: `importedAt`, then `id`). So no existing asset with an image
  changes its cover. `automaticCover` (core) and `automaticCovers` (SQL in the asset repository) implement
  the same rule and a test holds them together. Whether a frame can actually be made is not part of the rule
  (a pure MIME rule, as for images); a video without a frame shows the placeholder.
- "Open externally" follows from the kind (`isOpenable`), so videos get it. Analysis and the studio do not
  get them.
- URL import: `download-name.ts` maps the content types `video/mp4` → `mp4` and `video/webm` → `webm`.

### Persistence

- Migration `0016`: `file.duration_ms` nullable integer. No CHECK, no table rebuild.
- `FileRepository.setDimensions` (or a sibling) also stores the duration.
- `DERIVED_DATA_VERSION` becomes 2. For every row whose kind is `video` afterwards the step additionally
  sets `mime_type` from the same name and the same extension rule that gave the kind (`originalName`), so
  kind and MIME type cannot disagree (the MIME type was stored once at import and is
  `application/octet-stream` on existing videos). Other rows keep their stored MIME type. The import derives
  kind and MIME type of a video from one name as well.

### Frame tool (`packages/media`)

A new unit beside the worker pool, `createVideoFrames(options)`:

```ts
interface VideoFrames {
  /** Extracts one frame as an image file at `targetPath`; null when the tool is missing, fails or times out. */
  extract(sourcePath: string, format: 'mp4' | 'webm', targetPath: string): Promise<VideoInfo | null>;
  close(): void; // kills running processes, refuses new ones
}
interface VideoInfo { width: number; height: number; durationMs: number | null }
```

- `options.binaryPath: string | null` (null: every call answers null), `concurrency` (default 2),
  `timeoutMs` (default 20 000).
- One ffmpeg process per call, started without a shell, with an argument array, hidden window, no stdin, a
  capped diagnostic buffer. On timeout or `close()` the process is killed and the partial target removed.
- Hardening, all required: `-nostdin`; `-protocol_whitelist file`; the demuxer forced from the kind
  (`mov,mp4,m4a,3gp,3g2,mj2` or `matroska,webm`), never guessed from the content; no external references
  followed (ffmpeg's default for the MP4 demuxer; do not enable it); a decoder pixel limit of 100 000 000
  (`-max_pixels`, the same limit as images); exactly one frame; the frame scaled to at most 1024 on the
  longer edge, never enlarged. A decoder allow-list is added when the bundled build supports it (builder's
  call).
- The frame is taken at 1 s; when that gives no frame (a shorter video) once more at 0 s.
- Width and height are the displayed size after rotation, and the duration, both read from ffmpeg's
  diagnostic output of the same run. How (the `showinfo` filter and the `Duration:` line are the obvious
  source) is the builder's call; the tests pin it against the bundled binary. A size that cannot be read
  means the whole call answers null; an unknown duration is `null`.
- Nothing is logged that names a path.

`PreviewService.get` takes an optional `video: 'mp4' | 'webm'` on its request. For a video and the sizes
`thumb` and `detail` it first makes sure the frame exists in the cache (`cache/frames/ab/<sha256>-v1.jpg`,
own constant `FRAME_FORMAT_VERSION`, in-flight calls deduplicated, the directory under the same LRU cleanup
as the others) and then renders the requested size from the frame through the unchanged worker pool job.
`full` for a video answers null. The session-long `failed` memory applies as for images. The frame directory
has the same budget (`CACHE_LIMIT_BYTES`, trimmed to the same ratio) and the same cleanup trigger as the
thumbnails.

The binary comes from the npm package `ffmpeg-static` (downloads the platform build at install): a dependency
of `apps/desktop`, `ffmpeg-static: true` under `allowBuilds`, externalised in `electron.vite.config.ts`.
`packages/media` takes the package as a dev dependency for its tests only. The lockfile fixes the package but
not the downloaded binary, so the repository records the expected SHA-256 of the binary per platform
(`win32-x64` at first) and the main process hashes the file once at start, as a stream, before the tool is
enabled. A missing file, a platform without a recorded checksum or a mismatch means `binaryPath: null` and
one fixed warning without the path; previews requested before the check has finished wait for it. The
builder records the ffmpeg version of the build in the backlog entry.

### Measuring (core)

- Port `VideoProbe { measure(absolutePath: string, format: 'mp4' | 'webm'): Promise<VideoInfo | null> }`,
  wired to the frame tool (extracting into a temporary file in the cache directory that is removed, or
  straight into the frame cache — builder's call).
- The import does not measure a video (a measurement can take up to the time limit and would stall a large
  import). Dimensions and duration are filled on demand only.
- `files:measure` accepts a complete video without stored dimensions and stores width, height and duration.
  Contract unchanged (answers the `FileRecord`); a failed measurement leaves the row as it is.

### Media protocol (main)

- A third URL form `assetforge-media://video/<uuid>`, canonical spelling as the others.
- Lookup `resolveVideoSource` in core: complete, has a checksum, MIME type in `VIDEO_MIME_TYPES`; answers
  path and MIME type. Like the other two lookups it also serves a file in the trash.
- `handleMediaRequest` receives the request headers. For this route only:
  - no `Range` header: status 200, the whole file as a stream;
  - one range (`bytes=a-b`, `bytes=a-`, `bytes=-n`): status 206 with `Content-Range` and the stream of
    exactly these bytes;
  - a range outside the file or a malformed one: status 416 with `Content-Range: bytes */<size>`;
  - several ranges: answered as if there were none (200).
  - Headers on 200 and 206: `Content-Type` (from the allow-list, checked again), `Content-Length`,
    `Accept-Ranges: bytes`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.
  - The read stream is closed when the consumer cancels.
- `preview/<uuid>` accepts videos through `resolvePreviewSource` (which answers the format with the source);
  `original/<uuid>` is unchanged and never serves a video.
- The scheme is registered with `stream: true` in addition. The CSP gets `media-src assetforge-media:`. A new
  test reads `index.html` and pins the whole policy.

### Renderer

- `VideoStage` (new, keyed by file id) in the file detail dialog where `ImageStage` is, for a complete file
  of kind `video`: a `<video>` with the browser's own controls (play/pause, seek, volume),
  `preload="metadata"`, the `detail` preview as poster, no autoplay, no loop; the element's own fullscreen
  button, picture-in-picture, download and remote playback are switched off. Fullscreen has one path: the
  stage, as for images, so Previous/Next keep working in fullscreen. Leaving the file or closing the dialog
  ends playback.
- Volume and mute are kept for the app session (not stored).
- When the element reports an error the stage shows `This video cannot be played here` and the shared button
  `Open externally` (disabled as elsewhere when the file is not openable, e.g. in the trash).
- The toolbar shows only the fullscreen button for a video (no zoom, rotate, fit). Previous/Next, the film
  strip and the arrow keys work as for images; the arrow keys keep meaning Previous/Next also while the
  video has focus (the element's own arrow-key handling is suppressed), `Shift`+Left/Right seek 5 s back or
  forward, `Space` toggles playback, `F` toggles fullscreen of the stage. The image-only keys do nothing.
- Details column: `Dimensions` as for images and `Duration` (`m:ss`, `h:mm:ss` from one hour) when known.
  The measure-on-demand effect also runs for a video without dimensions.
- Tiles, table thumbnails, the film strip and "Use as cover" ask `file.thumbnail` instead of
  `file.previewable`. A video tile and film strip entry carry a small film icon in a corner (with or without
  a picture); without a picture the existing extension label stays.
- Kind filter: the entry `Video` in both lists (asset gallery, file browser).
- Labels in `labels.ts`; tokens only; no explanatory text.

## Left to the builder

The exact ffmpeg arguments within the hardening rules; how the diagnostic output is parsed; the queue
discipline of the frame tool; whether measuring fills the frame cache; file layout inside the packages.

## Tests

- Core: kind and MIME for the three extensions; `hasThumbnail`; the cover rule with a video in all three
  places (the SQL list against `automaticCover`); `isAnalysable` and `isUsableInput` refuse a video;
  `resolveVideoSource` (complete, trashed, wrong type); an asset with an earlier video and a later image
  keeps the image as automatic cover; no measuring at import, measuring on demand; the download name.
- Persistence: migration `0016`; the derived-data step turns an existing `.mp4` row into kind `video` with
  `video/mp4` and leaves other rows' MIME types alone.
- Media (under Electron's Node, with the bundled binary; fixtures are generated by the test with ffmpeg
  itself, none committed): a frame and correct size and duration for H.264 MP4 and VP9 WebM; a rotated
  video reports the displayed size; a video shorter than 1 s; a file that is not a video, a truncated file,
  a text file named `.mp4` and a playlist-like file that names a network address all answer null and open no
  connection; timeout kills the process and leaves no file; `binaryPath: null`; concurrency limit; thumb and
  detail through the preview service, `full` null.
- Main: the range cases above with exact headers and bytes; the image routes' pinned headers unchanged; the
  CSP test.
- Renderer (jsdom): the video stage instead of the image stage; the error state with `Open externally`; no
  image toolbar; duration format; the film icon; `Video` in both filters; menu items for analysis and studio
  absent for a video; "Use as cover" present.

Playback itself (decoding, seeking through the protocol, the arrow keys against the element's own key
handling) cannot be tested without the running app and is checked by the owner.

## Documentation

`ReadMe.md` (file kinds, "Open externally", previews, media protocol, the ffmpeg dependency and its licence);
`docs/backlog.md` section "Video playback": the non-goals, packaging of the binary (outside the archive,
licence notice), the session-long failed memory, the ffmpeg version.
