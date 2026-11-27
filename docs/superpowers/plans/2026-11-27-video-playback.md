# Video Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `mp4`, `m4v` and `webm` files become the kind `video`, get a picture from one extracted frame and
play in the file detail dialog.

**Architecture:** ffmpeg runs as a bounded, hardened child process in `packages/media` and writes one frame
into the preview cache; the existing Sharp worker pool renders thumbnails from that frame. The media protocol
gets a `video/<uuid>` route with byte ranges. The renderer shows a `VideoStage` in place of `ImageStage`.

**Tech Stack:** TypeScript, Zod 4, Drizzle (migration `0016`), Vitest (+ jsdom), React, `ffmpeg-static@5.3.0`
(ffmpeg 6.1.1; already installed by the setup commit, with `ffmpeg-static: true` under `allowBuilds`).

**Spec:** `docs/superpowers/specs/2026-11-27-video-playback-design.md` — binding; read it first.

## Global Constraints

- Everything in the repository is English. No attribution lines in commit messages. Commit, do not push.
- Never launch the app, a browser or a dialog; never call the network; never start Docker. Tests only. Do not
  add, remove or update dependencies (the setup commit did it).
- `core` and `contracts` do not depend on Electron, a concrete adapter or `node:child_process`.
- `PREVIEWABLE_MIME_TYPES`, `isPreviewable`, `ORIGINAL_MIME_TYPES` and the `original/` and `preview/` response
  headers for images do not change. A video never reaches Sharp, `files:measure`'s Sharp path, the analysis
  or the studio.
- ffmpeg is started without a shell, with an argument array, and only by `packages/media`. Required
  arguments: `-nostdin`, `-protocol_whitelist file`, the demuxer forced from the format
  (`mov,mp4,m4a,3gp,3g2,mj2` | `matroska,webm`), `-max_pixels 100000000`, one frame, longer edge at most 1024
  and never enlarged. `-enable_drefs` is never set. All of these options exist in the bundled build
  (`-codec_whitelist` too).
- No path, URL or cause in an error message, an IPC answer or a log line.
- Renderer: no explanatory text in the layout (tooltips through `title`), buttons only through the constants
  of `apps/desktop/src/renderer/src/ui.ts`, tokens only (no colour literals; `test/theme.test.ts` guards it),
  labels in `labels.ts`.
- Exact strings: `This video cannot be played here`, `Open externally`, `Video` (kind filter), `Duration`.
- Expected SHA-256 of the `win32-x64` binary:
  `04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00`.
- Verification per task: `pnpm typecheck` and `pnpm test` (no `--` separator with `--filter`). Known flakes:
  `inbox.test.tsx > filters and scroll offset survive navigation`,
  `venice-image.test.ts > maps a refused connection to provider_unreachable`.

## Review Focus

- A file named `.mp4` that is a playlist or text naming a network address: the frame tool answers null and
  opens no connection (Task 2).
- A timeout or `close()` while ffmpeg runs: the process is gone and no partial frame file is left (Task 2).
- `Range: bytes=0-` on a file of several GiB and a cancelled response: only the asked bytes are read and the
  file handle is closed (Task 3).
- An asset with an earlier video and a later image: the automatic cover is the image, in core and in SQL
  (Task 1).
- An existing `.mp4` row with `application/octet-stream`: after the derived-data step it has kind `video`
  and `video/mp4`, and no other row's MIME type changed (Task 1).

Each of these has a test in the task that owns the code.

---

### Task 1: Contracts, core, persistence (lane A)

**Files:** `packages/contracts/src/files.ts` (and `view-source.ts` if the lists live better there);
`packages/core/src/{media-types,file-names,file-access,asset-cover,measure-file,import-file,download-name,ports}.ts`,
`packages/core/test/fakes.ts`; `packages/persistence/src/{schema,file-repository,asset-repository,derived-data}.ts`,
migration `0016` (`pnpm --filter @assetforge/persistence db:generate`); every place the type checker names
after `FileRecord` grows (also in `apps/desktop`: only the minimum to compile, e.g. test fixtures).

**Interfaces (produces):**
- `FileKind` includes `'video'`; `FileRecord.thumbnail: boolean`, `FileRecord.durationMs: number | null`.
- `VIDEO_MIME_TYPES`, `isVideo(mimeType): boolean`, `hasThumbnail(mimeType): boolean`,
  `videoFormat(mimeType): 'mp4' | 'webm' | null` in `media-types.ts`; type `VideoFormat = 'mp4' | 'webm'`.
- `VideoInfo = { width: number; height: number; durationMs: number | null }`;
  port `VideoProbe { measure(absolutePath: string, format: VideoFormat): Promise<VideoInfo | null> }`, on the
  session/context beside `ImageProbe` (a fake that answers null is the default in test helpers).
- `resolveVideoSource(s, fileId): Promise<{ absolutePath: string; mimeType: string } | null>`.
- `PreviewSource` gets `video: VideoFormat | null`.
- `measureFile` handles a complete video without dimensions through `VideoProbe` and stores width, height
  and duration; the import does not measure a video.
- `DERIVED_DATA_VERSION = 2`.

- [ ] Write the failing tests of the spec's Tests section for core and persistence, plus Review Focus lines
      4 and 5.
- [ ] Implement per the spec's sections "Kind and MIME type", "Persistence", "Measuring" and the lookups of
      "Media protocol".
- [ ] `pnpm typecheck` and `pnpm test` green.
- [ ] Commit: `feat: video file kind, cover rule and duration in core and persistence`.

### Task 2: Frame tool and preview service (lane B, parallel to Task 1)

**Files:** create `packages/media/src/video-frames.ts`; modify `packages/media/src/preview-cache.ts`,
`src/index.ts`; tests beside the existing ones in `packages/media/test/`. This lane does not touch other
packages; it declares `VideoFormat` and `VideoInfo` locally with the shapes of Task 1 (structurally equal).

**Interfaces (produces):**
- `createVideoFrames(options: { binaryPath: string | null | Promise<string | null>; concurrency?: number; timeoutMs?: number }): VideoFrames`
  with `extract(sourcePath, format, targetPath): Promise<VideoInfo | null>` and `close(): void`
  (defaults 2 and 20 000; a promise for the path is awaited by every call).
- `PreviewRequest.video?: VideoFormat`; `createPreviewService({ cacheDir, pool, frames? })`; without `frames`
  a video request answers null. Frame path `frames/ab/<sha256>-v1.jpg`, `FRAME_FORMAT_VERSION = 1`, exported.
- `PreviewService.measureVideo(sourcePath: string, format: VideoFormat): Promise<VideoInfo | null>` (a
  temporary target in the cache directory, removed afterwards) — what the main process wires to `VideoProbe`.

- [ ] Write the failing tests of the spec's Tests section for media, plus Review Focus lines 1 and 2. Fixtures
      are generated in the test with the binary from `ffmpeg-static` (`-f lavfi -i testsrc…`), none committed.
      The "no connection" test runs a local TCP server on `127.0.0.1` and asserts it gets no connection.
- [ ] Implement per the spec's section "Frame tool".
- [ ] `pnpm typecheck` and `pnpm test` green.
- [ ] Commit: `feat(media): video frames through a hardened ffmpeg process`.

### Task 3: Main process (after Tasks 1 and 2)

**Files:** `apps/desktop/src/main/media-protocol.ts`, `index.ts`, new `ffmpeg-binary.ts`,
`apps/desktop/electron.vite.config.ts`, `apps/desktop/src/renderer/index.html` (CSP only); tests in
`apps/desktop/test/`.

**Interfaces (produces):**
- `resolveFfmpegBinary(deps): Promise<string | null>` in `ffmpeg-binary.ts`: path from `ffmpeg-static`,
  checksum table `{ 'win32-x64': '<sha>' }`, stream hash, null plus one fixed warning (no path) when missing,
  unknown platform or mismatch; injectable for tests.
- URL form `assetforge-media://video/<uuid>`; `handleMediaRequest(request: { url; method; headers }, deps)`
  with `findVideo` and an `openFile(path, range?)` that reads only the range; range rules and headers exactly
  as in the spec.
- Scheme privilege `stream: true`; CSP `media-src assetforge-media:`; `ffmpeg-static` externalised; the frame
  tool created with the binary promise, handed to the preview service, closed on quit; `VideoProbe` wired to
  `previews.measureVideo`.

- [ ] Write the failing tests of the spec's Tests section for main (ranges with exact headers and bytes,
      unchanged image headers, CSP pin, binary resolution), plus Review Focus line 3.
- [ ] Implement per the spec's sections "Media protocol" and the binary paragraph of "Frame tool".
- [ ] `pnpm typecheck` and `pnpm test` green.
- [ ] Commit: `feat(desktop): video route with byte ranges and verified ffmpeg binary`.

### Task 4: Renderer and documentation (after Task 1, parallel to Task 3)

**Files:** create `apps/desktop/src/renderer/src/components/VideoStage.tsx`; modify `FileDetailDialog.tsx`,
`hooks/useViewerKeys.ts`, `ViewerToolbar`, `FileTile.tsx`, `FilmStrip.tsx`, the file table, `FileBrowser.tsx`,
`screens/AssetsScreen.tsx`, `file-actions.ts`, `media-url.ts` (`videoUrl(fileId)`), `labels.ts`; tests in
`apps/desktop/test/renderer/`; `ReadMe.md`, `docs/backlog.md`. Does not touch `src/main` or `index.html`.

- [ ] Write the failing renderer tests of the spec's Tests section.
- [ ] Implement per the spec's section "Renderer".
- [ ] Update `ReadMe.md` and `docs/backlog.md` per the spec's section "Documentation" (backlog also: the
      bundled ffmpeg is 6.1.1 from 2023 and should be replaced by a current build; only `win32-x64` has a
      recorded checksum).
- [ ] `pnpm typecheck` and `pnpm test` green.
- [ ] Commit: `feat(desktop): play videos in the file detail dialog`.
