# Image Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the file detail dialog into an image viewer whose "100 %" shows the pixels of the stored original, with browsing through the list it was opened from.

**Architecture:** Image dimensions are measured by Sharp in the existing worker pool and stored on the file row. One pure rule (`viewSource`, in `packages/contracts`) decides for the main process and the renderer what may be loaded: the unchanged original through a new, narrow protocol address, a lossless PNG rendition (`size=full`, own cache directory) for TIFF and oversized images, or today's 1024 px preview. The renderer gets a zoom/pan stage, a toolbar, a film strip and keyboard control inside the existing dialog; the `FileBrowser` hands the dialog its list.

**Tech Stack:** TypeScript, Zod, Sharp (worker threads), better-sqlite3 + Drizzle, Electron protocol handler, React 19, Tailwind 4 tokens, @tanstack/react-virtual, lucide-react, Vitest (+ jsdom / Testing Library).

**Spec:** `docs/superpowers/specs/2026-11-26-image-viewer-design.md` — read it first; it is the authority. Mockup: `docs/design/mockups/04-image-viewer.png`.

## Global Constraints

- Everything in the repository is English. Commit messages carry no attribution lines. Every commit is followed by `git push` of the current branch (`image-viewer`).
- `pnpm typecheck` and `pnpm test` (repository root) are green at the end of every task. Single file: `pnpm --filter @assetforge/<package> test <file>` (no `--` separator).
- Implementers never launch the app.
- `core` and `contracts` do not depend on Electron, Sharp or a database. `packages/media` does not depend on `contracts` or `core`.
- Sharp runs only in the worker pool of `packages/media`. Nothing decodes on the main or renderer event loop except the browser's `<img>` decode of the one image on screen. Only the current file's large image is mounted.
- The renderer loads media only through `assetforge-media://`. No `file://`, no path in a URL, no image bytes over IPC.
- `ORIGINAL_MAX_EDGE = 8192`. Originals are served only for `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/avif`.
- Every protocol refusal and error is the same bare 404 (no body, no headers). No absolute paths or cause messages in errors or logs.
- "100 %" is one image pixel per **device** pixel: CSS size = pixel size / `devicePixelRatio`. Percentages always refer to the stored dimensions. Fit never exceeds 100 %.
- Zoom steps: 10, 25, 33, 50, 67, 100, 150, 200, 300, 400, 800 %.
- UI: tokens and the class constants of `apps/desktop/src/renderer/src/ui.ts` only, no colour literals (`test/theme.test.ts`), every button uses the `BUTTON` family, no explanatory text in the layout — explanations are `title` tooltips, and every viewer control's `title` names its shortcut.
- The existing dialog behaviour stays: tag row, role control, "More" menu, Asset block, Esc handling of nested popups.
- Not built: preloading of neighbouring previews, the mockup's shortcut legend, a workspace scan for dimensions.

## Review Focus

Inputs the spec implies but does not spell out; each has its test in the task named.

1. **Animated GIF / WebP / AVIF** — the measured size is one frame, not the stacked frames (Task 2).
2. **An image above the decoder limits (100 megapixels, 256 MiB)** — measurement yields `null`, the import still succeeds, the viewer shows the preview with "100 %" disabled (Tasks 2, 3, 5).
3. **A file whose content does not match its extension** (text or HTML named `.png`) — no dimensions, therefore never served as an original; a real image is always answered with its stored type and `nosniff` (Tasks 3, 4).
4. **The original is missing on disk or the storage is unreachable** — protocol: 404; `files:measure`: no crash, record unchanged or a forwarded storage error; viewer: preview stays, inline alert (Tasks 3, 4, 5).
5. **The list shrinks while the viewer is open or a step is pending** — the last file leaves (previous shown), the only file leaves (dialog closes), a step target beyond the new total is clamped (Task 6).

## File Structure

```text
packages/contracts/src/view-source.ts           viewSource, ORIGINAL_MAX_EDGE, ORIGINAL_MIME_TYPES (new)
packages/contracts/src/files.ts, ipc.ts         FileRecord width/height; files:measure
packages/persistence/src/schema.ts, file-repository.ts, migrations/0005_*   width/height columns
packages/media/src/messages.ts, generate.ts, worker-pool.ts, preview-worker.ts, preview-cache.ts
                                                measure job, PNG output, size "full"
packages/core/src/ports.ts, session.ts, import-file.ts, file-access.ts, workspace-manager.ts
                                                ImageProbe, measurement at import, measureFile, resolveOriginalSource
apps/desktop/src/main/media-protocol.ts, index.ts, composition.ts, library-handlers.ts
apps/desktop/src/renderer/src/
  viewer/zoom.ts                                pure zoom maths (new)
  components/ImageStage.tsx                     scroll container, image swap, pan, wheel (new)
  components/ViewerToolbar.tsx                  Fit / 100 % / − % + / rotate / fullscreen (new)
  components/FilmStrip.tsx                      horizontal virtualised thumbnails (new)
  hooks/useViewerKeys.ts                        keyboard map (new)
  components/FileDetailDialog.tsx, FileBrowser.tsx, Dialog.tsx, AssetFilesTab.tsx
  screens/InboxScreen.tsx, hooks/useFileDialog.ts, media-url.ts
```

---

### Task 1: Dimensions in the data model and the shared view rule

**Model:** sonnet

**Files:**
- Create: `packages/contracts/src/view-source.ts`, `packages/contracts/test/view-source.test.ts`, `packages/persistence/migrations/0005_*.sql` (generated), `packages/persistence/test/migration-0005.test.ts`
- Modify: `packages/contracts/src/files.ts`, `packages/contracts/src/index.ts`, `packages/persistence/src/schema.ts`, `packages/persistence/src/file-repository.ts`, `packages/core/src/ports.ts`, `packages/core/src/import-file.ts`, `packages/core/test/fakes.ts`, `packages/core/test/media-types.test.ts`, `apps/desktop/test/renderer/fixtures.ts`, and every other place the type checker reports
- Test: also `packages/persistence/test/library-repositories.test.ts`

**Interfaces:**
- Produces (`@assetforge/contracts`):
  ```ts
  export const ORIGINAL_MAX_EDGE = 8192;
  export const ORIGINAL_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'] as const;
  export type ViewSource = 'original' | 'converted' | 'reduced' | 'preview' | 'none';
  export function viewSource(mimeType: string, width: number | null, height: number | null): ViewSource;
  // FileRecordSchema gains:
  width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable()
  ```
- Produces (`FileRepository` in `packages/core/src/ports.ts`):
  ```ts
  markComplete(id: string, r: { sizeBytes: number; sha256: string; width: number | null; height: number | null }): Promise<void>;
  /** Stores the pixel size; rejects with NotFoundError for an unknown id. */
  setDimensions(id: string, size: { width: number; height: number }): Promise<FileRecord>;
  ```
- In this task `importFile` passes `width: null, height: null`; Task 3 fills them.

- [ ] **Step 1: Write the failing `viewSource` test** (`packages/contracts/test/view-source.test.ts`), as a table:

  | mimeType | width | height | expected |
  | --- | --- | --- | --- |
  | each of the five `ORIGINAL_MIME_TYPES` | 7680 | 4320 | `original` |
  | `image/png` | 8192 | 8192 | `original` |
  | `image/png` | 8193 | 10 | `reduced` |
  | `image/jpeg` | 10 | 8193 | `reduced` |
  | `image/tiff` | 8192 | 100 | `converted` |
  | `image/tiff` | 9000 | 100 | `reduced` |
  | `image/png`, `image/tiff` | null | null | `preview` |
  | `image/png` | 100 | null | `preview` |
  | `image/svg+xml`, `text/html`, `application/octet-stream`, `IMAGE/PNG`, `image/png; charset=x`, `''` | 100 | 100 | `none` |

  Also `expect(ORIGINAL_MAX_EDGE).toBe(8192)`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/contracts test view-source` — FAIL (module missing).
- [ ] **Step 3: Implement `view-source.ts`**, export it from `index.ts`, add `width`/`height` to `FileRecordSchema`. The comparison is exact (no lower-casing, no parameter stripping).
- [ ] **Step 4: Core guard test** in `packages/core/test/media-types.test.ts`: for every entry of `PREVIEWABLE_MIME_TYPES`, `viewSource(type, null, null) === 'preview'`; `[...ORIGINAL_MIME_TYPES, 'image/tiff']` sorted equals `PREVIEWABLE_MIME_TYPES` sorted.
- [ ] **Step 5: Persistence tests first.** `migration-0005.test.ts` follows `migration-0004.test.ts` (database created with migrations up to `0004`, one complete file row, then opened with the current folder): the row survives with `width` and `height` `null`. In `library-repositories.test.ts`: `markComplete` with `width: 1600, height: 2000` → `get` returns them; `markComplete` with nulls → nulls; `setDimensions` stores and returns the record with tags; `setDimensions` on an unknown id rejects with `NotFoundError`; `list` and `findCompleteBySha256` return the dimensions.
- [ ] **Step 6: Implement.** Nullable `integer('width')`, `integer('height')` on `file` in `schema.ts`; run `pnpm --filter @assetforge/persistence db:generate` (the migration must contain only the two `ALTER TABLE … ADD` statements — no table rebuild); map them in `toRecord`; implement the repository methods and the fakes; set `width: null, height: null` wherever a `FileRecord` is built. `DERIVED_DATA_VERSION` stays `1`.
- [ ] **Step 7: Run** `pnpm typecheck` and `pnpm test` — PASS.
- [ ] **Step 8: Commit and push** — `feat: store image dimensions and add the shared view-source rule`.

---

### Task 2: Media — measuring, lossless PNG and the `full` size

**Model:** sonnet

**Files:**
- Modify: `packages/media/src/messages.ts`, `generate.ts`, `preview-worker.ts`, `worker-pool.ts`, `preview-cache.ts`, `index.ts`, `packages/media/test/fixtures/*.mjs` (new message shape)
- Test: `packages/media/test/generate.test.ts`, `worker-pool.test.ts`, `preview-cache.test.ts`

**Interfaces:**
- Produces (`@assetforge/media`):
  ```ts
  export interface ImageSize { width: number; height: number }
  export interface PreviewJob { sourcePath: string; targetPath: string; longestEdge: number; format: 'webp' | 'png' }
  export type WorkerJob = { kind: 'render'; job: PreviewJob } | { kind: 'measure'; sourcePath: string };
  export interface WorkerRequest { id: number; work: WorkerJob }
  export interface WorkerResponse { id: number; result: PreviewResult | ImageSize | null }

  // generate.ts (worker only)
  export function measureImage(sourcePath: string, limits?: PreviewLimits): Promise<ImageSize | null>; // never throws

  // WorkerPool
  run(job: PreviewJob): Promise<PreviewResult>;            // unchanged contract
  measure(sourcePath: string): Promise<ImageSize | null>;  // never rejects; crash, timeout, closed pool → null

  // preview-cache.ts
  export type PreviewSize = 'thumb' | 'detail' | 'full';
  PREVIEW_EDGE.full === 8192
  export const FULL_FORMAT_VERSION = 1;
  export const FULL_CLEANUP_EVERY = 8;
  previewRelativePath(sha256, 'full') === `full/${sha256.slice(0, 2)}/${sha256}-8192-v1.png`
  ```
- `measureImage`: `stat` (not a file or larger than `maxBytes` → `null`), then Sharp `metadata()` opened with `limitInputPixels` and **without** `animated`, so `height` is one frame. EXIF orientation 5–8 swaps width and height. `width * height > maxPixels` → `null`. Any failure → `null`.
- PNG output: same pipeline as today (`rotate()`, `resize` inside `longestEdge`, `withoutEnlargement`) ending in `.png({ compressionLevel: 3 })`; `webp` stays as it is. Thumbnails and detail previews are requested with `format: 'webp'`, `full` with `format: 'png'`.
- Cache: `full` lives in its own directory `full` with its own budget (`cleanup` already evicts each directory separately against `limitBytes`; add the directory). A new `full` entry counts towards its own counter and triggers `cleanup` every `FULL_CLEANUP_EVERY` entries (large files must not pile up for 500 entries). The `thumb`/`detail` paths and their version are unchanged.

- [ ] **Step 1: Failing tests in `generate.test.ts`:**
  - `measureImage` of a 2000 × 1000 PNG → `{ width: 2000, height: 1000 }`.
  - A 40 × 20 JPEG written with `.withMetadata({ orientation: 6 })` → `{ width: 20, height: 40 }`.
  - A 3-frame animated GIF (and WebP) of 30 × 20 → `{ width: 30, height: 20 }` (Review Focus 1). Build it with Sharp from a raw buffer of stacked frames (`raw: { width: 30, height: 60, channels: 4, pageHeight: 20 }`); if this Sharp version cannot write that, commit a tiny fixture file instead.
  - A text file named `a.png`, a missing path, a directory → `null`.
  - With `limits = { maxPixels: 100, maxBytes: 1 << 20 }` a 20 × 20 PNG → `null`; with `maxBytes: 10` → `null` (Review Focus 2).
  - `generatePreview({ …, longestEdge: 8192, format: 'png' })` of a 64 × 48 8-bit RGBA TIFF with random pixels: target is PNG, 64 × 48, and its raw RGBA buffer equals the source's raw RGBA buffer byte for byte (lossless).
  - The same for a TIFF with orientation 6: output is 48 × 64 and equals the raw buffer of `sharp(source).rotate()`.
  - `longestEdge: 32, format: 'png'` of the 64 × 48 source → 32 × 24 PNG.
  - `format: 'webp'` still yields WebP.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/media test generate` — FAIL.
- [ ] **Step 3: Implement** `messages.ts`, `measureImage`, the `format` switch, and the worker's dispatch on `work.kind`.
- [ ] **Step 4: Failing tests in `worker-pool.test.ts`:** `measure` returns the size through the real worker; `measure` on a closed pool, with the crash worker and with the hang worker (timeout) resolves `null`; a `run` and a `measure` queued together both settle; existing `run` tests keep passing with the new message shape.
- [ ] **Step 5: Implement** `WorkerPool.measure` (same queue, same timeout, same slot handling as `run`).
- [ ] **Step 6: Failing tests in `preview-cache.test.ts`:** the `full` relative path above; `get({ size: 'full' })` calls the pool with `longestEdge: 8192, format: 'png'` and the `full/…png` target, `thumb` with `256, 'webp'`; a second `get` is served from the cache without the pool; `cleanup` evicts `full` against the limit without touching `thumbnails` and `previews` and vice versa; after `FULL_CLEANUP_EVERY` new `full` entries a cleanup has run (with `cleanupEvery` left at its default).
- [ ] **Step 7: Implement** the cache changes; export the new names from `index.ts`.
- [ ] **Step 8: Run** `pnpm --filter @assetforge/media test`, then `pnpm typecheck` and `pnpm test` — PASS (the desktop main process only needs `format`-free calls; it does not build `PreviewJob`s itself).
- [ ] **Step 9: Commit and push** — `feat(media): measure images and render lossless full-size PNG renditions`.

---

### Task 3: Measuring at import and on demand

**Model:** sonnet

**Files:**
- Create: `packages/core/src/measure-file.ts`, `packages/core/test/measure-file.test.ts`
- Modify: `packages/core/src/ports.ts`, `session.ts`, `import-file.ts`, `workspace-manager.ts`, `index.ts`, `packages/core/test/fakes.ts`, `packages/core/test/import.test.ts`, `packages/contracts/src/ipc.ts`, `apps/desktop/src/main/composition.ts`, `index.ts`, `library-handlers.ts`, `apps/desktop/test/library-ipc.test.ts`, `apps/desktop/test/renderer/fake-api.ts` if it lists channels

**Interfaces:**
- Consumes: `FileRepository.markComplete` / `setDimensions` (Task 1); `WorkerPool.measure` (Task 2).
- Produces (`@assetforge/core`):
  ```ts
  export interface ImageProbe { measure(absolutePath: string): Promise<{ width: number; height: number } | null> }
  // WorkspaceHost gains `imageProbe: ImageProbe`; WorkspaceSession gains `readonly imageProbe: ImageProbe`;
  // ImportContext gains `probe: ImageProbe`.
  /** Rejects with NotFoundError for an unknown id; otherwise returns the (possibly updated) record. */
  export function measureFile(s: WorkspaceSession, fileId: string): Promise<FileRecord>;
  ```
- Produces (IPC): `'files:measure': { request: z.object({ fileId: z.uuid() }), response: FileRecordSchema }`, handled as `manager.exclusive((s) => measureFile(s, r.fileId))`.
- `CompositionOptions` gains optional `imageProbe?: ImageProbe`; default: a probe that resolves `null`. `apps/desktop/src/main/index.ts` creates the worker pool once and passes it to both `createPreviewService` and, as `{ measure: (path) => pool.measure(path) }`, to the manager.

- [ ] **Step 1: Failing tests in `import.test.ts`** (fake probe recording its calls):
  - A complete `a.png` import calls the probe once with the absolute path of the **final** inbox path and returns/stores `width`/`height` from it.
  - `notes.txt` (not previewable) never calls the probe; dimensions are `null`.
  - A probe resolving `null` and a probe that rejects both leave the import `complete` with `null` dimensions and `error: null` (Review Focus 2, 3).
  - A failed import (checksum mismatch) never calls the probe.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/core test import` — FAIL.
- [ ] **Step 3: Implement.** Measure after `storage.move` succeeded and before `markComplete`, inside its own `try`/`catch`; pass the result to `markComplete` and the returned record.
- [ ] **Step 4: Failing tests in `measure-file.test.ts`:**
  - Complete previewable file with `null` dimensions → probe called once, record returned and stored with the size.
  - Calling it again → probe **not** called, same record (idempotent).
  - Probe `null` → record unchanged, no write.
  - Pending or failed file, non-previewable file → probe not called, record unchanged.
  - Unknown id → `NotFoundError`.
  - File missing on disk (`storage.exists` false) → probe not called, record unchanged; unreachable storage → `StorageUnreachableError` (Review Focus 4).
- [ ] **Step 5: Implement `measureFile`**, the channel, the handler, the composition option and the wiring in `index.ts`. Add to `library-ipc.test.ts`: `files:measure` with a fake probe returns the measured record; a non-UUID `fileId` is rejected by validation.
- [ ] **Step 6: Run** `pnpm typecheck` and `pnpm test` — PASS.
- [ ] **Step 7: Commit and push** — `feat: measure image dimensions at import and on demand`.

---

### Task 4: Protocol — originals and the `full` size

**Model:** opus

**Files:**
- Modify: `packages/core/src/file-access.ts`, `packages/core/test/file-access.test.ts`, `apps/desktop/src/main/media-protocol.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/test/media-protocol.test.ts`, `apps/desktop/src/renderer/src/media-url.ts`, `apps/desktop/test/media-url.test.ts`, `ReadMe.md` (the protocol rule near line 570 and the sentence near line 518)

**Interfaces:**
- Consumes: `viewSource`, `ORIGINAL_MIME_TYPES`, `ORIGINAL_MAX_EDGE` (Task 1); `PreviewSize` including `'full'` (Task 2).
- Produces (`@assetforge/core`):
  ```ts
  export interface OriginalSource { absolutePath: string; mimeType: (typeof ORIGINAL_MIME_TYPES)[number] }
  /** null unless the file exists, is complete, has a checksum and viewSource(mimeType, width, height) === 'original'. */
  export function resolveOriginalSource(s: WorkspaceSession, fileId: string): Promise<OriginalSource | null>;
  ```
- Produces (`media-protocol.ts`):
  ```ts
  export function parseOriginalUrl(url: string): { fileId: string } | null;  // exactly `assetforge-media://original/<uuid>`
  // parsePreviewUrl additionally accepts size=full
  export interface MediaProtocolDeps {
    findSource(fileId: string): Promise<PreviewSource | null>;
    findOriginal(fileId: string): Promise<OriginalSource | null>;
    previews: Pick<PreviewService, 'get'>;
    readFile(path: string): Promise<Uint8Array>;                                   // thumb, detail
    /** Rejects when the file cannot be opened; nothing is read into memory as a whole. */
    openFile(path: string): Promise<{ size: number; stream: ReadableStream<Uint8Array> }>;  // original, full
  }
  export function findOriginalIn(manager: WorkspaceManager): (fileId: string) => Promise<OriginalSource | null>;
  ```
- Produces (renderer `media-url.ts`):
  ```ts
  export function previewUrl(fileId: string, size: 'thumb' | 'detail' | 'full'): string;
  export function originalUrl(fileId: string): string;   // `assetforge-media://original/${fileId}`
  /** The large image of the viewer; null for `none`. */
  export function viewUrl(file: Pick<FileRecord, 'id' | 'mimeType' | 'width' | 'height'>): { source: ViewSource; url: string | null };
  ```
- Responses:
  - original: 200, body = stream, headers exactly `Content-Type: <stored MIME>`, `Content-Length: <size>`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.
  - `size=full`: 200, body = stream, `Content-Type: image/png`, `Content-Length`, `Cache-Control: no-store`.
  - `thumb` / `detail`: unchanged (`image/webp`, `private, max-age=31536000`).

- [ ] **Step 1: Failing parser tests.** `parseOriginalUrl` accepts only the exact spelling. Rejected (each its own case): a query (`?size=full`, `?`), a fragment (`#`, `#x`), a trailing slash, a second path segment, dot segments (`/./<id>`, `/../<id>`), an upper-case host, credentials, a port, a non-UUID id, an upper-case UUID if the canonical comparison rejects it today for previews (mirror `parsePreviewUrl`), host `preview` without query, another scheme, an empty string. `parsePreviewUrl` accepts `size=full` and still rejects `size=original`, `size=FULL`.
- [ ] **Step 2: Failing `resolveOriginalSource` tests** (`file-access.test.ts`): `null` for an unknown id, a pending file, a failed file, a complete file without checksum, `image/tiff`, `image/svg+xml`, `text/html`, dimensions `null`, 8193 × 10; a complete 7680 × 4320 `image/jpeg` → its absolute path and `image/jpeg`. A text file imported as `x.png` (dimensions `null`) → `null` (Review Focus 3).
- [ ] **Step 3: Failing handler tests** (`media-protocol.test.ts`, fake deps):
  - original → the four headers above with the stored type for each of the five types, body bytes equal the file.
  - `POST`, `HEAD` → 404. `findOriginal` resolving `null` → 404 and `openFile` not called. `findOriginal` or `openFile` rejecting (missing file, `StorageUnreachableError`) → 404 with no body and no headers (Review Focus 4).
  - `size=full` → `previews.get` called with `size: 'full'`, answered as `image/png` / `no-store` through `openFile`; `get` resolving `null` → 404.
  - `thumb` still answers `image/webp` with the long cache header through `readFile`.
  - One integration case with the real manager (as the existing ones): an imported PNG whose dimensions were stored is served through `findOriginalIn`; the same file after `setDimensions` to 9000 × 10 is a 404.
  - `PREVIEW_EDGE.full === ORIGINAL_MAX_EDGE`.
- [ ] **Step 4: Run** `pnpm --filter @assetforge/core test file-access` and `pnpm --filter @assetforge/desktop test media-protocol` — FAIL.
- [ ] **Step 5: Implement** core, the handler (try the original parser first, then the preview parser) and the wiring in `index.ts`: `openFile` opens the file, takes the size from the open handle and returns a web stream that closes the handle when it ends, errors or is cancelled.
- [ ] **Step 6: `media-url.ts` with tests** (`media-url.test.ts`): `originalUrl`, `previewUrl(id, 'full')`; `viewUrl` → `original` with the original URL, `converted` and `reduced` with `?size=full`, `preview` with `?size=detail`, `none` with `null`. Every URL built here is accepted by the main-process parsers (import them in the test).
- [ ] **Step 7: ReadMe.** Rewrite the protocol rule: previews `thumb|detail` (WebP) and `full` (lossless PNG, at most 8192 px, own cache directory `cache/full` with its own 2 GiB budget); originals only through `assetforge-media://original/<file id>` for complete files of the five types with known dimensions up to 8192 px, streamed with the stored type, `nosniff` and `no-store`; everything else a bare 404. Mention stored dimensions and `files:measure` where the file model is described.
- [ ] **Step 8: Run** `pnpm typecheck` and `pnpm test` — PASS.
- [ ] **Step 9: Commit and push** — `feat(desktop): serve originals and full-size renditions through the media protocol`.

---

### Task 5: Viewer stage — zoom, pan, rotate, source swap

**Model:** opus

**Files:**
- Create: `apps/desktop/src/renderer/src/viewer/zoom.ts`, `components/ImageStage.tsx`, `components/ViewerToolbar.tsx`, `apps/desktop/test/zoom.test.ts`, `apps/desktop/test/renderer/image-stage.test.tsx`
- Modify: `components/FileDetailDialog.tsx`, `components/Dialog.tsx` (detail size), `components/AssetFilesTab.tsx`, `screens/InboxScreen.tsx`, `apps/desktop/test/renderer/file-dialog.test.tsx`, `fixtures.ts`

**Interfaces:**
- Consumes: `viewUrl`, `previewUrl` (Task 4); `files:measure` (Task 3); `FileRecord.width/height`.
- Produces (`viewer/zoom.ts`, pure):
  ```ts
  export const ZOOM_STEPS = [10, 25, 33, 50, 67, 100, 150, 200, 300, 400, 800] as const;
  export interface Size { width: number; height: number }
  export type Zoom = { mode: 'fit' } | { mode: 'percent'; percent: number };
  export type Rotation = 0 | 90 | 180 | 270;
  /** Image pixel size after rotation (90 and 270 swap). */
  export function rotated(image: Size, rotation: Rotation): Size;
  /** Largest percentage ≤ 100 at which the rotated image fits the stage; 100 for an empty stage or image. */
  export function fitPercent(image: Size, stage: Size, dpr: number, rotation: Rotation): number;
  export function effectivePercent(zoom: Zoom, image: Size, stage: Size, dpr: number, rotation: Rotation): number;
  /** Next step above (+1) or below (−1) `percent`; stays at 800 / at min(10, percent). */
  export function stepPercent(percent: number, direction: 1 | -1): number;
  /** CSS pixel size of the unrotated image element at `percent`. */
  export function cssSize(image: Size, percent: number, dpr: number): Size;
  /** Scroll offset that keeps the image point under `pointer` (stage coordinates) fixed when the content size changes. */
  export function anchoredScroll(scroll: number, pointer: number, before: number, after: number): number;
  ```
- Produces (`ImageStage`), consumed by Tasks 6 and 7:
  ```ts
  export interface ViewerControls {
    fit(): void; actual(): void; zoomIn(): void; zoomOut(): void; rotate(): void;
    percent: number;                 // rounded, as displayed
    zoom: Zoom; canActual: boolean;  // false for the `preview` source
    marker: string | null;           // "Reduced from 12000 × 9000 px" | "Preview only" | null
  }
  // <ImageStage file={FileRecord} onControls={(c: ViewerControls) => void} />   — state resets when file.id changes
  ```
  `ViewerToolbar` takes `controls: ViewerControls` plus `fullscreen: { active: boolean; toggle(): void } | null` (Task 7 passes it; `null` renders no fullscreen button).
- `FileDetailDialog` gains `onMeasured(file: FileRecord): void`; both hosts pass their `useFileDialog().update`.

**Behaviour to build (spec "Viewer"):**
- Detail dialog size becomes `w-[min(96vw,1600px)] h-[min(92vh,1000px)]`. The right column is: toolbar row, then the stage filling the rest. Non-previewable or incomplete files keep today's placeholder and get no toolbar.
- Details list gains `Dimensions` between `Type` and `Size`: `1600 × 2000 px`, `–` while unknown.
- When the dialog shows a complete previewable file with `width === null`, it calls `files:measure` once per file id and hands a record with dimensions to `onMeasured`; failures are ignored.
- The stage is a scroll container (`overflow: auto`, focusable region with `aria-label="Image"`). Inside it a box with the rotated CSS size, centred when smaller than the stage. Two layers of the same size: the 1024 px preview (`previewUrl(id, 'detail')`) at once, and the `viewUrl` image, which becomes visible on its `load` event; then the preview layer is removed. For the `preview` source there is only the preview layer. If the large image fires `error`, the preview stays and an inline `role="alert"` (class `ALERT`) says `The image could not be loaded`.
- The basis for percentages is the stored size; for the `preview` source it is the preview's `naturalWidth`/`naturalHeight` once loaded.
- Default per file: Fit. `actual()` → 100 %. `zoomIn`/`zoomOut` → `stepPercent` from the effective percentage. Zoom changes from the toolbar anchor on the stage centre; Ctrl+wheel steps once per event and anchors on the pointer (`preventDefault`, listener registered non-passive); a plain wheel scrolls natively; dragging with the primary button pans by changing the scroll offsets; a double click toggles Fit ↔ 100 % (anchored on the pointer; nothing when `canActual` is false).
- `image-rendering: pixelated` on both layers when the effective percentage is ≥ 100, otherwise `auto`.
- `rotate()` adds 90° clockwise; view only.
- The stage size comes from `useElementSize` (`hooks/useVirtualRows.ts`); Fit follows a resize.
- Toolbar (left to right): `Fit` (`title="Fit (0)"`, `aria-pressed` while in fit mode), `100%` (`title="Actual pixels (1)"`, `aria-pressed` at exactly 100, disabled when `!canActual`), zoom out (`title="Zoom out (−)"`), the percentage as text with `aria-live="polite"` and — when `marker` is set — a `TriangleAlert` icon in `text-warning` whose `title` and `aria-label` are the marker, zoom in (`title="Zoom in (+)"`), rotate (`title="Rotate (R)"`). Icon buttons use `ICON_BUTTON`, text buttons `BUTTON`.

- [ ] **Step 1: Failing `zoom.test.ts`:**
  - `fitPercent({4000×2000}, {1000×800}, 1, 0)` = 25; with `dpr` 2 → 50; rotation 90 → `min(1000/2000, 800/4000) = 20`.
  - `fitPercent({100×50}, {1000×800}, 1, 0)` = 100 (never above); stage `{0×0}` → 100; image `{0×0}` → 100 (no `NaN`, no `Infinity`).
  - `stepPercent`: 25→33, 26→33, 100→150, 800→800 (up); 100→67, 84→67, 10→10, 7→7 (down); 7→10 (up).
  - `cssSize({1600×2000}, 100, 1.25)` = `{1280×1600}`; at 50 % and `dpr` 1 → `{800×1000}`.
  - `anchoredScroll(100, 200, 1000, 2000)` = 400; with `before` 0 → 0.
  - `effectivePercent({ mode: 'percent', percent: 150 }, …)` = 150; fit mode equals `fitPercent`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test zoom` — FAIL; implement `zoom.ts`; PASS.
- [ ] **Step 3: Failing DOM tests** (`image-stage.test.tsx`; mock the stage size the way `file-browser.test.tsx` mocks element sizes, set `window.devicePixelRatio`):
  - A 4000 × 2000 PNG in a 1000 × 800 stage shows `25%`, Fit pressed, the preview layer present with the detail URL and the large image with `assetforge-media://original/<id>`; after `fireEvent.load` on the large image the preview layer is gone.
  - `fireEvent.error` on the large image → preview stays, alert `The image could not be loaded` (Review Focus 4).
  - "100%" → `100%`, image element CSS width `4000px` at `dpr` 1 and `3200px` at `dpr` 1.25; `image-rendering` is `pixelated`; back to Fit → not `pixelated`.
  - Zoom in from Fit 25 % → 33 %; zoom out twice → 10 %; the buttons at the ends stay enabled but do not change the value.
  - Double click toggles `25%` ↔ `100%`. Ctrl+wheel up → next step, and the event is default-prevented; a plain wheel leaves the percentage.
  - Rotate → box size swaps (fit of 4000 × 2000 rotated in 1000 × 800 → `20%`).
  - `image/tiff` 100 × 100 → large image URL `…preview/<id>?size=full`, no marker. 12000 × 9000 PNG → `?size=full`, marker `Reduced from 12000 × 9000 px`, percentage relative to 12000 × 9000.
  - Dimensions `null` → only the detail preview, marker `Preview only`, "100%" disabled, double click does nothing (Review Focus 2).
  - Re-rendering with another file id resets zoom to Fit and rotation to 0 and mounts exactly one large image.
- [ ] **Step 4: Failing dialog tests** (`file-dialog.test.tsx`): `Dimensions` shows `1600 × 2000 px` / `–`; a previewable complete file without dimensions triggers exactly one `files:measure` and `onMeasured` receives the record; a rejected `files:measure` shows nothing and is not repeated; a file with dimensions and a `notes.txt` trigger none; `notes.txt` shows the placeholder and no toolbar. Existing dialog tests keep passing.
- [ ] **Step 5: Implement** the components and the host wiring (`onMeasured`).
- [ ] **Step 6: Run** `pnpm typecheck` and `pnpm test` — PASS.
- [ ] **Step 7: Commit and push** — `feat(desktop): zoomable image stage in the file detail dialog`.

---

### Task 6: Browsing through the list

**Model:** opus

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/FileBrowser.tsx`, `components/FileDetailDialog.tsx`, `components/Dialog.tsx` (title padding), `hooks/useFileDialog.ts`, `components/AssetFilesTab.tsx`, `screens/InboxScreen.tsx`
- Test: `apps/desktop/test/renderer/file-browser.test.tsx`, `file-dialog.test.tsx`, `inbox.test.tsx`, `asset-screen.test.tsx`

**Interfaces:**
- Produces (`FileBrowser.tsx`):
  ```ts
  export interface ViewerList {
    total: number;
    /** Position of the viewed file in the list. */
    index: number;
    slot(index: number): Slot<FileRecord>;           // from paged-list.ts
    /** Shows the file at `index`: loads its page when needed, then calls `onView(file)`. Clamped to 0 … total − 1; the latest call wins. */
    show(index: number): void;
    /** Keeps the pages of this index range loaded (film strip). */
    want(first: number, last: number): void;
  }
  // FileBrowserProps gains:
  viewer?: {
    /** The file the host's dialog shows; null when closed. */
    fileId: string | null;
    /** The dialog must show this file now; null closes it. */
    onView(file: FileRecord | null): void;
    render(list: ViewerList): ReactNode;
  };
  ```
  `render` is called while `fileId !== null` and the file's index is known; its result is rendered by the browser (the dialog is modal, the place in the tree does not matter). Hosts move their `<FileDetailDialog>` into `viewer.render` and pass `list` on.
- Produces (`useFileDialog`): additional `show(file: FileRecord): void` — the dialog shows another file; from then on the focus return targets that file's tile (the remembered opener is dropped once the shown id differs from the opened one).
- `FileDetailDialog` gains `list: ViewerList | null` and `onShow(file)` is not needed (the browser calls `viewer.onView`). Header: counter `2 / 14` and two icon buttons `Previous file (←)` / `Next file (→)` (`ChevronLeft` / `ChevronRight`, `ICON_BUTTON`) left of Close, disabled at the ends; `Dialog`'s `TITLE_PADDING.detail` grows so the title never runs under them.

**Behaviour to build (spec "Browsing", "List changes under the viewer"):**
- While `viewer.fileId` is set, the browser adds to its wanted pages: the pages of `index − 1 … index + 1`, of a pending `show` target and of the `want` range. They stay wanted across a reload (`reloadToken` change).
- Stepping walks **all** files of the displayed list, images or not; no wrap-around.
- The viewer is tracked by file id. After the displayed list changed: if the id is found in a loaded page, `index` follows it. If the page that should hold the last known index is loaded and the id is not in the list, the browser calls `onView` with the file now at that index (the one that followed), else the one at `total − 1`, else `null` when the list is empty.
- Hosts no longer close the dialog themselves after assign, detach or a role/tag change; they reload as today and react to `onView`: `file === null ? dialog.close() : dialog.show(file)`.
- On close the browser brings the tile of the last shown file into view and focuses it (`refocus(index)` of `useVirtualRows` handles rows that are not rendered); `useFileDialog`'s own focus return stays as the fallback for an unchanged file.

- [ ] **Step 1: Failing tests in `file-browser.test.tsx`** (a `viewer.render` that prints `index`, `total` and buttons calling `show`):
  - Opening the third of 5 files gives `index 2`, `total 5`; `show(3)` calls `onView` with the fourth file; `show(-1)` and `show(5)` are clamped to the first and last.
  - 130 files, viewer on index 59: `files:list` is requested for offset 60 without scrolling; `show(60)` resolves after that page loaded; `show(125)` requests offset 120 and calls `onView` once with file 125 after the answer; two quick `show` calls → only the latest reaches `onView`.
  - Reload where the viewed file is gone from the middle → `onView(follower)`; gone from the end → `onView(previous)`; the only file gone → `onView(null)`; file still present → `onView` not called and `index` unchanged (Review Focus 5).
  - Reload that shrinks the list while a `show` for a page beyond the new total is pending → `onView` with the last file, no unhandled rejection (Review Focus 5).
  - After `viewer.fileId` returns to `null`, the tile of the last shown file has focus, also when it was on a page that was never scrolled to.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test file-browser` — FAIL.
- [ ] **Step 3: Implement** the browser side and `useFileDialog.show`.
- [ ] **Step 4: Failing dialog and host tests:**
  - `file-dialog.test.tsx`: counter `2 / 14`; Previous disabled at index 0, Next disabled at the last index; a click on Next calls `list.show(index + 1)`; a text file in the list is shown with its placeholder; `list === null` renders no counter and no arrows.
  - `inbox.test.tsx`: assigning the shown file keeps the dialog open on the following file and the counter total drops by one; assigning the last remaining file closes the dialog.
  - `asset-screen.test.tsx`: detaching the shown file shows the following one; changing the role with an active role filter that no longer matches moves on as well; adding a tag keeps the same file.
  - Focus: open file A, step to C, close → tile C has focus; open A, close → tile A has focus (unchanged behaviour).
- [ ] **Step 5: Implement** the header and the host changes.
- [ ] **Step 6: Run** `pnpm typecheck` and `pnpm test` — PASS.
- [ ] **Step 7: Commit and push** — `feat(desktop): browse the file list inside the viewer`.

---

### Task 7: Film strip, keyboard and fullscreen

**Model:** sonnet

**Files:**
- Create: `apps/desktop/src/renderer/src/components/FilmStrip.tsx`, `hooks/useViewerKeys.ts`, `apps/desktop/test/renderer/viewer-keys.test.tsx`, `film-strip.test.tsx`
- Modify: `components/FileDetailDialog.tsx`, `components/ViewerToolbar.tsx`, `docs/backlog.md`
- Test: also `apps/desktop/test/renderer/file-dialog.test.tsx`

**Interfaces:**
- Consumes: `ViewerList` (Task 6), `ViewerControls`, `ViewerToolbar`'s `fullscreen` prop (Task 5).
- Produces:
  ```ts
  // <FilmStrip list={ViewerList} />
  export function useViewerKeys(
    root: RefObject<HTMLElement | null>,   // the dialog content; listens for keydown there
    actions: { previous(): void; next(): void; zoomIn(): void; zoomOut(): void; fit(): void; actual(): void; rotate(): void; fullscreen(): void },
  ): void;
  ```

**Behaviour to build:**
- **Film strip** below the stage (hidden when `list` is null or `total < 2`): one row, 64 px tiles, horizontally virtualised with `useVirtualizer({ horizontal: true })` over `list.total`. A loaded complete previewable file shows `CoverImage size="thumb"`, any other loaded file its `formatLabel`, an unloaded slot an empty tile. Each tile is a `<button>` with `title` and `aria-label` = file name; the current one has `aria-current="true"` and the accent border. A click calls `list.show(index)`. The visible index range is reported through `list.want(first, last)`; when `list.index` changes the strip scrolls it into view (`scrollToIndex`, `align: 'auto'`). The container is a `<div role="group" aria-label="Files">` — not a `listbox`, so the keyboard guard below does not mistake it for a popup.
- **Keyboard** (`keydown` on the dialog content): `ArrowLeft` / `ArrowRight` previous / next, `+` and `=` zoom in, `-` zoom out, `0` Fit, `1` 100 %, `r` / `R` rotate, `f` / `F` fullscreen. Ignored when Ctrl, Alt or Meta is held, when the event was already default-prevented, when the target is an `input`, `textarea`, `select` or content-editable element, and when a popup is open inside the dialog (an element with `aria-expanded="true"`: the More menu, the tag combobox, the asset picker). Handled keys are default-prevented. Zoom, rotate and fullscreen keys do nothing for a file without a stage. Esc is not handled here.
- **Fullscreen**: the toolbar button `Fullscreen (F)` (`Maximize` / `Minimize`, `aria-pressed`) requests fullscreen on the element wrapping toolbar and stage (`requestFullscreen`), and exits through `document.exitFullscreen`; the state follows the `fullscreenchange` event. The wrapper gets the surface background while fullscreen. The dialog's close path leaves fullscreen first: when `document.fullscreenElement` is set, Esc / Close exit fullscreen and do **not** close the dialog. A rejected `requestFullscreen` is ignored.
- `docs/backlog.md`: add what was deliberately left out (neighbour preloading, 16-bit and wide-gamut TIFF being converted to 8-bit sRGB in the PNG rendition, viewer not reachable from the asset gallery).

- [ ] **Step 1: Failing `film-strip.test.tsx`:** 5 files render 5 tiles with their names as `title`; the current one has `aria-current="true"`; a click on the fourth calls `show(3)`; a `notes.txt` tile shows `TXT` and no image; an unloaded slot renders an empty tile and `want` was called with a range containing it; a list of one file renders no strip; 500 files render far fewer than 500 tiles.
- [ ] **Step 2: Failing `viewer-keys.test.tsx`:** every key of the map calls its action exactly once; `ArrowRight` typed in the tag input, with the More menu open, and with Ctrl held calls nothing; `+` on a `notes.txt` dialog calls nothing; a handled key is default-prevented.
- [ ] **Step 3: Failing fullscreen tests** (`file-dialog.test.tsx`; stub `requestFullscreen`, `document.exitFullscreen` and `document.fullscreenElement`): the button requests fullscreen on the wrapper and becomes pressed after `fullscreenchange`; Esc (the dialog's `cancel` event) while fullscreen calls `exitFullscreen` and not `onClose`; Esc afterwards closes; a rejecting `requestFullscreen` leaves the button unpressed and throws nothing.
- [ ] **Step 4: Run** `pnpm --filter @assetforge/desktop test film-strip viewer-keys file-dialog` — FAIL.
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Run** `pnpm typecheck`, `pnpm test` and `pnpm --filter @assetforge/desktop build` — PASS.
- [ ] **Step 7: Commit and push** — `feat(desktop): film strip, keyboard shortcuts and fullscreen for the viewer`.

---

## After the last task (controller)

- Whole-branch review on the most capable model, one fix wave.
- Short manual check of the built app in the seed workspace (each check once; never "Open externally" / "Show in folder"): open an image, Fit / 100 % / Ctrl+wheel / rotate, step through files incl. a non-image, film strip, fullscreen and Esc, assign from the inbox while the viewer is open, close and check the focused tile; one TIFF and one EXIF-rotated JPEG import.
- Update `CLAUDE.md` (project state: image viewer implemented; protocol and `cache/full`) — it is git-ignored and edited by the controller only.
- Merge into `main`, push, delete the branch.

## Self-review notes

- Spec coverage: Dimensions → Tasks 1–3; view rule → Task 1; protocol and ReadMe → Tasks 2, 4; stage, zoom, animated originals (served unchanged, nothing to build), reduced/preview marker, rotate → Task 5; browsing, list changes, focus return → Task 6; film strip, keyboard, fullscreen → Task 7.
- The spec's test "import stores oriented dimensions (an EXIF-rotated fixture)" is split: orientation in `packages/media` (Task 2, real Sharp under the Electron ABI), storing whatever the probe reports in `packages/core` (Task 3).
- Builder's choices settled here: `viewSource` lives in `contracts`; scroll-container pan/zoom; PNG compression level 3; dialog `min(96vw,1600px) × min(92vh,1000px)`; 64 px film strip; no neighbour preloading; the browser renders the dialog through `viewer.render`.
