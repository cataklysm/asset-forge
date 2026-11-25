# Phase 3a – Gallery and Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the library visible: cached WebP thumbnails and detail previews served through `assetforge-media://`, a cover image per asset, an endlessly scrolling grid/table asset gallery, file tiles with a detail dialog, "Open externally" / "Show in folder", and list state that survives navigation.

**Architecture:** A new package `packages/media` (no Electron, no core dependency) owns Sharp: a worker entry that turns one source file into one WebP, a bounded worker pool, and a preview cache keyed by SHA-256 + edge + format version. The main thread never imports Sharp. `core` gains the previewable-MIME and blocked-extension constants, the cover rule and use cases, and two file-access functions that resolve an absolute path through a new `Storage.absolutePath`. The desktop host installs a pure protocol handler function on the default session and passes shell calls into the IPC handlers through a `HostActions` object. The renderer windows the asset list with `@tanstack/react-virtual`; every decision is a pure function with a Vitest test.

**Tech Stack:** unchanged plus `sharp` (in `@assetforge/media` and `@assetforge/desktop`), `esbuild` (devDependency of `@assetforge/media`, test-only worker bundling, version already in the lockfile) and `@tanstack/react-virtual` (renderer).

**Spec:** `docs/superpowers/specs/2026-11-25-phase-3a-gallery-previews-design.md`

**Branch:** `phase-3a-gallery-previews` (exists).

**Models:** each task names the model for its implementer subagent. Task reviewers run on `sonnet`, except Tasks 1, 3, 8 and 10 (`opus`). The final whole-branch review runs on the most capable model.

## Global Constraints

- Everything in the repository is English. No attribution lines in commit messages. Every commit is followed by `git push` (`git push -u origin phase-3a-gallery-previews` the first time).
- `core` and `contracts` stay free of Electron and Sharp. `media` does not depend on Electron, `core` or `contracts` (it receives directories and paths). IPC handler modules and `media-protocol.ts` stay free of Electron imports.
- Thumbnail longest edge 256 px; detail preview longest edge 1024 px; never enlarged beyond the original; output WebP.
- Written to a temporary file next to the target and renamed. EXIF auto-orientation applied; metadata stripped; animated images yield their first frame.
- Input pixel limit 100 megapixels; input file size limit 256 MiB; beyond them, or on a decode error, the result is "no preview".
- A pool of 2 workers; requests for the same preview share one result; a crashed worker is replaced and its request fails as "no preview".
- Cache: `<userData>/cache/thumbnails/` and `<userData>/cache/previews/`, keyed by the file's SHA-256, the size and a format version — never by file ID. A row without a checksum gets no preview.
- Each cache directory is limited to 2 GiB; LRU eviction down to 90 %. Cleanup once after a workspace opens, then after every 500 new entries. A failed source is remembered in memory for the session.
- Previewable MIME types (one constant in `core`): `image/png`, `image/jpeg`, `image/webp`, `image/tiff`, `image/gif`, `image/avif`. A list, not an `image/*` test.
- Exactly one migration: `0003` — adds nullable `asset.cover_file_id` referencing `file.id` and sets the MIME type of already imported `.avif` files. No other schema change.
- Protocol: `assetforge-media://preview/<file-id>?size=thumb|detail`; privileged (standard, secure) before ready; default session only; every failure is a `404` without a body. CSP gains `img-src 'self' assetforge-media:`.
- Block list (one constant in `core`): `exe`, `com`, `bat`, `cmd`, `msi`, `scr`, `pif`, `lnk`, `ps1`, `vbs`, `vbe`, `js`, `jse`, `wsf`, `wsh`, `hta`, `jar`, `sh`, `app`, `command`, `desktop`, `html`, `htm`, `svg`, `url`, `reg`, `py`, `pyw`, `psm1`, `chm`, `jnlp`, `application`, `appref-ms`, `settingcontent-ms`, `library-ms`, `msc`, `cpl`, `msp`, `scf`, `inf`, `website`, `diagcab`. Extension from the on-disk name after removing trailing dots and spaces, lower case; no extension → not opened.
- Asset gallery pages of 60, at most two requests at a time.
- `AssetForgeError` messages reach the renderer: no cause messages, absolute paths or credentials in them. No absolute path in any protocol response.
- UI: every button uses `BUTTON` from `apps/desktop/src/renderer/src/ui.ts`; no explanatory text in the layout (tooltips via `title`); interactive elements have an accessible name. The only new renderer dependency is `@tanstack/react-virtual`.
- Tests in `packages/persistence`, `packages/media` and `apps/desktop` run under Electron's Node (`cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`). Single test: `pnpm --filter @assetforge/<package> test <file> -t "<name>"` (no `--`).
- Each task ends with `pnpm test` and `pnpm typecheck` green in the whole repository.

## Review Focus

1. A pathological image that makes a worker hang (not crash) → that request becomes "no preview" after a timeout, the worker is replaced, and other previews keep being served. (Task 3: `a job that exceeds the timeout resolves none and the pool keeps serving`)
2. NAS unreachable or source file missing at request time → `404`, but the source is **not** remembered as failed, so the preview appears once the share is back. (Task 4: `a missing source is not remembered as failed`; Task 10: `storage unreachable answers 404`)
3. The user deletes `<userData>/cache` while the app runs → the next request regenerates the preview instead of returning a vanished path. (Task 4: `a deleted cache directory is recreated on the next request`)
4. An image whose import is still pending or failed → never the automatic cover, cannot be chosen, gets no preview. (Task 8: `pending and failed images are never the cover`; Task 6: `resolvePreviewSource ignores files that are not complete`)
5. A blocked program disguised by case or trailing characters (`Setup.EXE.`, `run.Bat `) → not openable, `files:openExternal` answers `validation_failed`, the shell is never called. (Task 5: `isOpenable normalises case and trailing dots and spaces`; Task 9: `a blocked file is never handed to the shell`)

---

### Task 1: Sharp gate — `packages/media` loads Sharp in tests, a worker and the built app

**Model:** opus

This task proves Sharp works and nothing else. If any of Steps 4, 7 or 9 fails and cannot be fixed by configuration (`allowBuilds`, externals, entry names), **stop and report BLOCKED** with the exact error; do not continue with later tasks.

**Files:**
- Create: `packages/media/package.json`, `packages/media/tsconfig.json`, `packages/media/vitest.config.ts`, `packages/media/src/index.ts`, `packages/media/src/preview-worker.ts`, `packages/media/src/messages.ts`, `packages/media/test/global-setup.ts`, `packages/media/test/worker-url.ts`, `apps/desktop/scripts/check-sharp.mjs`
- Modify: `pnpm-workspace.yaml`, `apps/desktop/package.json`, `apps/desktop/electron.vite.config.ts`, `.gitignore`
- Test: `packages/media/test/native-module.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
// packages/media/src/messages.ts
export interface PreviewJob { sourcePath: string; targetPath: string; longestEdge: number }
export type PreviewResult = 'ok' | 'none';
export interface WorkerRequest { id: number; job: PreviewJob }
export interface WorkerResponse { id: number; result: PreviewResult }
// packages/media/src/preview-worker.ts — worker_threads entry: on each WorkerRequest from
// parentPort, run the job and post a WorkerResponse. Task 2 replaces the job body.
// packages/media/test/worker-url.ts
export const TEST_WORKER_URL: URL; // packages/media/.test-build/preview-worker.mjs
// Built app: out/main/preview-worker.js next to out/main/index.js; sharp is external.
```

- [ ] **Step 1: Scaffold the package.** `package.json` modelled on `packages/persistence/package.json`: name `@assetforge/media`, `"type": "module"`, `"exports": "./src/index.ts"`, the same `test` and `typecheck` scripts, dependency `sharp` (current release via `pnpm --filter @assetforge/media add sharp`), devDependencies `@types/node`, `cross-env`, `electron`, `typescript`, `vitest` at the versions persistence uses, and `esbuild` at the version already in the lockfile. `tsconfig.json` like persistence (`include: ["src", "test", "vitest.config.ts"]`). `vitest.config.ts`: `include: ['test/**/*.test.ts']`, `globalSetup: ['test/global-setup.ts']`. `src/index.ts` exports only the types from `messages.ts` for now. Add `sharp` to `apps/desktop` dependencies at the same version, and `@assetforge/media: workspace:*`. In `pnpm-workspace.yaml` add `sharp: false` under `allowBuilds` (plan decision: the binary comes from the prebuilt optional `@img/sharp-<platform>` package; the install script is not needed). Add `.test-build/` to `.gitignore`.

- [ ] **Step 2: Write `test/global-setup.ts` and `test/worker-url.ts`.** `setup()` bundles `src/preview-worker.ts` with esbuild (`bundle: true, platform: 'node', format: 'esm', external: ['sharp'], outfile: '.test-build/preview-worker.mjs'`). Plan decision: tests load the worker from an esbuild bundle because a worker thread cannot load TypeScript source; `sharp` resolves from `packages/media/node_modules`.

- [ ] **Step 3: Write the failing tests** in `packages/media/test/native-module.test.ts`:

```ts
it('sharp loads under the Electron ABI and resizes', async () => {
  expect(process.versions.electron).toBeDefined();
  const { default: sharp } = await import('sharp');
  const out = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#f00' } })
    .resize({ width: 10 }).webp().toBuffer({ resolveWithObject: true });
  expect(out.info).toMatchObject({ format: 'webp', width: 10, height: 5 });
});

it('sharp resizes inside a worker thread', async () => {
  // write a 40×20 PNG to a temp dir, start new Worker(TEST_WORKER_URL), post
  // { id: 1, job: { sourcePath, targetPath, longestEdge: 10 } }
  expect(response).toEqual({ id: 1, result: 'ok' });
  expect(await sharp(targetPath).metadata()).toMatchObject({ format: 'webp', width: 10, height: 5 });
  await worker.terminate();
});
```

- [ ] **Step 4: Run** `pnpm --filter @assetforge/media test native-module` — expect FAIL first (worker entry empty), then implement `preview-worker.ts` minimally (`sharp(sourcePath).resize({ width: longestEdge, height: longestEdge, fit: 'inside' }).webp().toFile(targetPath)`, `'none'` on any error) and run again: PASS.

- [ ] **Step 5: Add the worker entry to the main build** in `apps/desktop/electron.vite.config.ts`: add `@assetforge/media` to `WORKSPACE_PACKAGES`, `sharp` to `externalizeDeps.include`, and `build.rolldownOptions.input = { index: 'src/main/index.ts', 'preview-worker': '../../packages/media/src/preview-worker.ts' }` (resolve both with `fileURLToPath(new URL(…, import.meta.url))`).

- [ ] **Step 6: Write `apps/desktop/scripts/check-sharp.mjs`.** Run as an Electron **main** process (`electron scripts/check-sharp.mjs <worker-path>`): after `app.whenReady()`, write a source PNG into a fresh directory under `app.getPath('temp')` with `fs` from a fixed base64 constant of a 40×20 PNG (the main thread must not import Sharp), start `new Worker(<worker-path>)`, post a job with `longestEdge: 10`, print `sharp-check: ok` and `app.exit(0)` on `'ok'` plus a non-empty target file, else print `sharp-check: failed` and `app.exit(1)`.

- [ ] **Step 7: Verify the built app.** Run `pnpm --filter @assetforge/desktop build`, confirm `apps/desktop/out/main/preview-worker.js` exists and contains `from "sharp"` / `require("sharp")` rather than a bundled copy, then from `apps/desktop` (with `ELECTRON_RUN_AS_NODE` unset) run `npx electron scripts/check-sharp.mjs out/main/preview-worker.js`. Expected: `sharp-check: ok`, exit code 0. Also launch the built app once (`npx electron .`) and confirm it starts.

- [ ] **Step 8: Verify dev.** Start `pnpm dev`, wait until the window shows, confirm `apps/desktop/out/main/preview-worker.js` was (re)written by the dev build, run the same check command in a second shell — expected `sharp-check: ok` — and stop dev.

- [ ] **Step 9: Run** `pnpm test` and `pnpm typecheck` — green.

- [ ] **Step 10: Commit and push.**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml .gitignore packages/media apps/desktop/package.json apps/desktop/electron.vite.config.ts apps/desktop/scripts/check-sharp.mjs
git commit -m "build: add media package and prove Sharp under Electron, in a worker and in the built app"
git push -u origin phase-3a-gallery-previews
```

---

### Task 2: Preview generator

**Model:** sonnet

**Files:**
- Create: `packages/media/src/generate.ts`
- Modify: `packages/media/src/preview-worker.ts`
- Test: `packages/media/test/generate.test.ts`

**Interfaces:**
- Consumes: `PreviewJob`, `PreviewResult` (Task 1).
- Produces:

```ts
// packages/media/src/generate.ts (imports sharp; imported only by preview-worker.ts, never by index.ts)
export interface PreviewLimits { maxPixels: number; maxBytes: number }
export const DEFAULT_LIMITS: PreviewLimits; // { maxPixels: 100_000_000, maxBytes: 256 * 1024 ** 2 }
export function generatePreview(job: PreviewJob, limits?: PreviewLimits): Promise<PreviewResult>;
```

- [ ] **Step 1: Write the failing tests** (fixtures generated with Sharp into a temp dir per test; call `generatePreview` directly in the test process):

```ts
it('DEFAULT_LIMITS are 100 megapixels and 256 MiB', () =>
  expect(DEFAULT_LIMITS).toEqual({ maxPixels: 100_000_000, maxBytes: 268_435_456 }));
it('bounds the longest edge', …);          // 2000×1000 PNG, edge 256 → webp 256×128
it('never upscales', …);                    // 100×50 PNG, edge 1024 → webp 100×50
it('applies EXIF orientation and strips metadata', …); // 40×20 JPEG withMetadata({ orientation: 6 }) → 20×40, metadata().exif undefined
it.each(['png', 'jpeg', 'webp', 'tiff', 'gif', 'avif'])('turns %s into webp', …); // 'ok', format 'webp'
it('takes the first frame of an animated gif', …);    // 2 frames of 40×30 → 40×30, pages 1 or undefined
it('a pixel count above the limit yields none', …);   // 20×20 PNG, { maxPixels: 100, maxBytes: DEFAULT } → 'none', no target
it('a file above the size limit yields none', …);     // { maxPixels: DEFAULT, maxBytes: 10 } → 'none', no target
it('corrupt input yields none', …);                   // random bytes named x.png → 'none', no target
it('leaves no temporary file after success or failure', …); // readdir(dir) holds only source and, on success, target
```

Build the animated GIF with whatever multi-frame input the installed Sharp offers (`join: { animated: true }` or raw input with `pageHeight`).

- [ ] **Step 2: Run** `pnpm --filter @assetforge/media test generate` — expect FAIL ("generatePreview is not exported").

- [ ] **Step 3: Implement `generatePreview(job, limits = DEFAULT_LIMITS): Promise<PreviewResult>`.** `stat` the source first (larger than `maxBytes` → `'none'`). Then `sharp(sourcePath, { limitInputPixels: maxPixels, animated: false, pages: 1 }).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).webp().toFile(tmp)`, where `tmp = \`${targetPath}.${randomUUID()}.tmp\``, then `mkdir(dirname(targetPath), { recursive: true })` before writing and `rename(tmp, targetPath)` after. Any error → remove `tmp` (ignore errors) and return `'none'`; never throw. At module load call `sharp.cache(false)` and `sharp.concurrency(1)` (plan decision: bound memory per worker; the pool provides the parallelism). Switch `preview-worker.ts` to call `generatePreview(job)`.

- [ ] **Step 4: Run** `pnpm --filter @assetforge/media test` — PASS (including Task 1's worker test).

- [ ] **Step 5: Commit and push** — `feat(media): generate bounded WebP previews with Sharp`.

---

### Task 3: Worker pool

**Model:** opus

**Files:**
- Create: `packages/media/src/worker-pool.ts`, `packages/media/test/fixtures/crash-worker.mjs`, `packages/media/test/fixtures/hang-worker.mjs`
- Modify: `packages/media/src/index.ts`
- Test: `packages/media/test/worker-pool.test.ts`

**Interfaces:**
- Consumes: `PreviewJob`, `PreviewResult`, `WorkerRequest`, `WorkerResponse` (Task 1), `TEST_WORKER_URL` (Task 1).
- Produces:

```ts
export interface WorkerPoolOptions { workerUrl: URL; size: number; timeoutMs: number }
export interface WorkerPool { run(job: PreviewJob): Promise<PreviewResult>; close(): Promise<void> }
export function createWorkerPool(options: WorkerPoolOptions): WorkerPool;
export const POOL_SIZE = 2;
export const JOB_TIMEOUT_MS = 30_000;
```

`index.ts` exports `createWorkerPool`, `POOL_SIZE`, `JOB_TIMEOUT_MS` and the types.

- [ ] **Step 1: Write the fixture workers.** `crash-worker.mjs`: on a request whose `job.sourcePath` ends with `crash`, `process.exit(1)`; otherwise reply `'ok'`. `hang-worker.mjs`: on a request whose `sourcePath` ends with `hang`, never reply; otherwise reply `'ok'`.

- [ ] **Step 2: Write the failing tests:**

```ts
it('runs at most `size` jobs at once', …);            // hang-worker, size 2, timeoutMs 200, three 'hang' jobs started together: all resolve 'none'; the first two after ≥ 200 ms, the third after ≥ 400 ms (it waited for a slot)
it('runs real previews through the bundled worker', …); // TEST_WORKER_URL, 4 jobs → all 'ok'
it('a crashed worker fails its job as none and is replaced', async () => {
  const pool = createWorkerPool({ workerUrl: crashUrl, size: 1, timeoutMs: 5_000 });
  expect(await pool.run(job('a-crash'))).toBe('none');
  expect(await pool.run(job('b'))).toBe('ok');
});
it('a job that exceeds the timeout resolves none and the pool keeps serving', async () => {
  const pool = createWorkerPool({ workerUrl: hangUrl, size: 1, timeoutMs: 200 });
  expect(await pool.run(job('a-hang'))).toBe('none');
  expect(await pool.run(job('b'))).toBe('ok');
});
it('close terminates the workers and later runs resolve none', …);
it('POOL_SIZE is 2', () => expect(POOL_SIZE).toBe(2));
```

- [ ] **Step 3: Run** `pnpm --filter @assetforge/media test worker-pool` — expect FAIL.

- [ ] **Step 4: Implement `createWorkerPool`.** Workers start lazily up to `size`; jobs beyond that wait in a FIFO queue. Each worker runs one job at a time. On `error` or `exit` of a busy worker, or when `timeoutMs` passes (then `terminate()` it), the job resolves `'none'` and the worker is dropped; the next queued job starts a fresh worker. `run` never rejects. Plan decision: a per-job timeout (30 s) is added so a hanging decoder cannot block a pool slot forever (spec anti-goal "blocking other previews").

- [ ] **Step 5: Run** `pnpm --filter @assetforge/media test` — PASS.

- [ ] **Step 6: Commit and push** — `feat(media): bounded preview worker pool with crash and timeout replacement`.

---

### Task 4: Preview cache

**Model:** opus

**Files:**
- Create: `packages/media/src/preview-cache.ts`
- Modify: `packages/media/src/index.ts`
- Test: `packages/media/test/preview-cache.test.ts`

**Interfaces:**
- Consumes: `WorkerPool`, `PreviewResult` (Task 3).
- Produces:

```ts
export type PreviewSize = 'thumb' | 'detail';
export const PREVIEW_EDGE: Record<PreviewSize, number>; // { thumb: 256, detail: 1024 }
export const PREVIEW_FORMAT_VERSION = 1;
export const CACHE_LIMIT_BYTES = 2 * 1024 ** 3;
export const CACHE_TARGET_RATIO = 0.9;
export const CLEANUP_EVERY = 500;
/** Path relative to the cache root, e.g. `thumbnails/ab/<sha256>-256-v1.webp`. */
export function previewRelativePath(sha256: string, size: PreviewSize): string;
export interface PreviewRequest { sha256: string; sourcePath: string; size: PreviewSize }
export interface PreviewService {
  /** Absolute path of the cached WebP, or null for "no preview". Never throws. */
  get(request: PreviewRequest): Promise<string | null>;
  /** LRU cleanup of both directories; concurrent calls share one run. Never throws. */
  cleanup(): Promise<void>;
  close(): Promise<void>;
}
export interface PreviewServiceOptions { cacheDir: string; pool: WorkerPool; limitBytes?: number; cleanupEvery?: number }
export function createPreviewService(options: PreviewServiceOptions): PreviewService;
export function evictLeastRecentlyUsed(dir: string, limitBytes: number, targetRatio: number): Promise<{ removedFiles: number }>;
```

`cacheDir` is `<userData>/cache`; the directories are `thumbnails` and `previews` below it (ReadMe §9.3).

- [ ] **Step 1: Write the failing tests** (a fake `WorkerPool` that writes a few bytes to `targetPath` and counts calls, plus one test with the real pool and `TEST_WORKER_URL`):

```ts
it('the key changes with hash and size and carries the format version', () => {
  expect(previewRelativePath(A, 'thumb')).toBe(`thumbnails/${A.slice(0, 2)}/${A}-256-v1.webp`);
  expect(previewRelativePath(A, 'detail')).toBe(`previews/${A.slice(0, 2)}/${A}-1024-v1.webp`);
  expect(previewRelativePath(B, 'thumb')).not.toBe(previewRelativePath(A, 'thumb'));
});
it('limits are 2 GiB, 90 % and every 500 entries', …);
it('a hit does not call the pool again', …);                 // two sequential gets → 1 pool call, same path
it('concurrent identical requests produce one file', …);     // Promise.all of 5 gets → 1 pool call, all same path
it('two files with the same content share one entry', …);    // same sha256, different sourcePath → 1 pool call
it('a failed source is remembered for the session', …);      // pool returns 'none' → null; second get → null, still 1 call
it('a missing source is not remembered as failed', …);       // sourcePath absent → null, 0 pool calls; create source → path
it('a deleted cache directory is recreated on the next request', …); // get, rm -r cacheDir, get → new path exists, 2 pool calls
it('evicts least recently used entries down to the target', …);      // 10 files × 100 B, mtimes ascending, limit 500 → oldest removed until total ≤ 450
it('eviction tolerates files vanishing underneath it', …);  // delete half the files between readdir and stat via a pre-removed name list; resolves, no throw
it('runs cleanup after every `cleanupEvery` new entries', …); // cleanupEvery 3, limit tiny → after 3rd new entry the oldest is gone
it('runs real previews end to end', …);                      // real pool: get → file is webp ≤ 256 px
```

- [ ] **Step 2: Run** `pnpm --filter @assetforge/media test preview-cache` — expect FAIL.

- [ ] **Step 3: Implement.** `get`: if `failed` (in-memory `Set` of `<sha256>:<size>`) has the key → `null`; if the target exists → touch its mtime (`utimes`, errors ignored) and return it; if `stat(sourcePath)` fails → `null` without remembering; else share one in-flight promise per key around `pool.run({ sourcePath, targetPath, longestEdge: PREVIEW_EDGE[size] })`; `'ok'` → count a new entry (trigger `cleanup()` without awaiting when the count reaches `cleanupEvery`, then reset) and return the path; `'none'` → remember and return `null`. Plan decision: LRU order is file mtime, refreshed on every hit (Windows does not keep atime reliably). `evictLeastRecentlyUsed` walks the two-character shard directories, ignores `ENOENT` on every `stat`/`unlink`, sorts by mtime ascending and deletes until total ≤ `limitBytes * targetRatio`; it does nothing when total ≤ `limitBytes`. Stale `*.tmp` files older than one hour are deleted by the same walk (plan decision: a crash between write and rename must not leak space). `close` calls `pool.close()`.

- [ ] **Step 4: Run** `pnpm --filter @assetforge/media test` — PASS.

- [ ] **Step 5: Commit and push** — `feat(media): content-keyed preview cache with LRU cleanup`.

---

### Task 5: Media rules in core and contracts

**Model:** sonnet

**Files:**
- Create: `packages/core/src/media-types.ts`
- Modify: `packages/core/src/file-names.ts`, `packages/core/src/errors.ts`, `packages/core/src/index.ts`, `packages/core/test/fakes.ts`, `packages/contracts/src/errors.ts`, `packages/contracts/src/files.ts`, `packages/persistence/src/file-repository.ts`, `apps/desktop/src/renderer/src/api.ts`
- Test: `packages/core/test/media-types.test.ts`, `packages/core/test/file-names.test.ts`, `packages/contracts/test/schemas.test.ts`, `packages/persistence/test/` (existing file-repository test)

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
// core/media-types.ts
export const PREVIEWABLE_MIME_TYPES: readonly string[]; // the six types, in spec order
export function isPreviewable(mimeType: string): boolean;
export const BLOCKED_OPEN_EXTENSIONS: readonly string[]; // the spec list, verbatim, in spec order
/** Lower-case extension of an on-disk name after stripping trailing dots and spaces; null when none. */
export function diskExtension(fileName: string): string | null;
/** Last `/` segment of a relative storage path. */
export function diskName(relativePath: string): string;
export function isOpenable(relativePath: string): boolean;
// core/errors.ts
export class ValidationFailedError extends AssetForgeError {} // code 'validation_failed'
// contracts/errors.ts: ErrorCodeSchema gains 'validation_failed'
// contracts/files.ts: FileRecordSchema gains
previewable: z.boolean(), // isPreviewable(mimeType)
openable: z.boolean(),    // isOpenable(relativePath)
```

Plan decision: the two flags are fields of `FileRecord`, computed where a record is built — persistence `toRecord` and `InMemoryFiles` in `packages/core/test/fakes.ts` — so every channel that returns files carries them. Plan decision: a name whose only dot is the first character has no extension (cannot occur for stored names, which start with `<fileId>_`).

- [ ] **Step 1: Write the failing tests:**

```ts
it('previewable types are exactly the six raster formats', () => {
  expect(PREVIEWABLE_MIME_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/tiff', 'image/gif', 'image/avif']);
  expect(isPreviewable('image/x-exr')).toBe(false);
  expect(isPreviewable('image/svg+xml')).toBe(false);
});
it('the block list is the spec list', () => expect(BLOCKED_OPEN_EXTENSIONS).toHaveLength(42));
it('isOpenable normalises case and trailing dots and spaces', () => {
  expect(isOpenable('inbox/x_Setup.EXE.')).toBe(false);
  expect(isOpenable('inbox/x_run.Bat ')).toBe(false);
  expect(isOpenable('assets/a/working/x_scene.blend')).toBe(true);
  expect(isOpenable('inbox/x_README')).toBe(false);
  expect(isOpenable('inbox/x_file.appref-ms')).toBe(false);
});
it('maps .avif to image/avif', () => expect(mimeFromFileName('a.AVIF')).toBe('image/avif'));
it('ValidationFailedError carries validation_failed', …);
it('FileRecordSchema requires previewable and openable', …);
// persistence: a stored .png in the inbox lists as previewable: true, openable: true; a .exe as openable: false
```

- [ ] **Step 2: Run** `pnpm --filter @assetforge/core test media-types` — expect FAIL.

- [ ] **Step 3: Implement** the module, the `avif` entry in `MIME_BY_EXTENSION`, the error class, the error code, the schema fields, the flags in `toRecord` and the fake, and `validation_failed: 'This action is not possible for this file.'` in `ERROR_MESSAGES`.

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green.

- [ ] **Step 5: Commit and push** — `feat(core): previewable types, open block list and validation_failed`.

---

### Task 6: Storage absolute paths and file access

**Model:** sonnet

**Files:**
- Create: `packages/core/src/file-access.ts`
- Modify: `packages/core/src/ports.ts`, `packages/core/src/index.ts`, `packages/core/test/fakes.ts`, `packages/storage/src/local-storage.ts`
- Test: `packages/core/test/file-access.test.ts`, `packages/storage/test/local-storage.test.ts`

**Interfaces:**
- Consumes: `isPreviewable`, `isOpenable`, `ValidationFailedError` (Task 5).
- Produces:

```ts
// ports.ts — Storage gains
/** Absolute path of a path inside the storage root; validated like every other operation. Never sent to the renderer. */
absolutePath(relativePath: string): Promise<string>;
// file-access.ts
export interface PreviewSource { sha256: string; absolutePath: string }
/** null unless the file exists, is complete, previewable and has a checksum. Storage errors propagate. */
export function resolvePreviewSource(s: WorkspaceSession, fileId: string): Promise<PreviewSource | null>;
/** Absolute path for the shell. 'open' additionally requires isOpenable. */
export function resolveFilePath(s: WorkspaceSession, fileId: string, purpose: 'open' | 'reveal'): Promise<string>;
```

`InMemoryStorage.absolutePath` returns `/memory/<relativePath>` and throws `StorageUnreachableError` when `reachable` is false. `LocalFileSystemStorage.absolutePath` goes through the private `resolve(relativePath, false)` inside `guarded`.

Plan decision (spec/code conflict): the `Storage` port had no way to hand out a path, but Sharp and the shell need one; the method lives on the port and its result only ever goes to the worker pool or the shell.

- [ ] **Step 1: Write the failing tests:**

```ts
// storage
it('absolutePath resolves inside the root and rejects escapes', …); // 'inbox/a.png' → join(root, 'inbox', 'a.png'); '../x' → path_escape
// core, with fakes
it('resolvePreviewSource returns sha256 and path for a complete image', …);
it('resolvePreviewSource ignores files that are not complete', …); // pending, failed → null
it('resolvePreviewSource ignores non-previewable files and rows without a checksum', …);
it('resolveFilePath rejects unknown and incomplete files with not_found', …);
it('resolveFilePath for open rejects blocked files with validation_failed', …); // reveal of the same file succeeds
it('resolveFilePath reports storage_unreachable without a path', …);
it('resolveFilePath reports a file missing on disk as not_found without a path', …);
// the last two assert error.message contains neither '/' + root segments nor '\\'
```

- [ ] **Step 2: Run** `pnpm --filter @assetforge/core test file-access` — expect FAIL.

- [ ] **Step 3: Implement.** `resolveFilePath`: `files.get` → missing or not `complete` → `NotFoundError('File not found')`; `storage.isReachable()` false → `StorageUnreachableError('The storage of this workspace is not reachable')`; `purpose === 'open' && !isOpenable(relativePath)` → `ValidationFailedError('This file type is never opened by AssetForge')`; `storage.exists(relativePath)` false → `NotFoundError('The file is missing on disk')`; return `storage.absolutePath(relativePath)`.

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green.

- [ ] **Step 5: Commit and push** — `feat(core): resolve preview sources and shell paths through the storage port`.

---

### Task 7: Migration 0003

**Model:** sonnet

**Files:**
- Create: `packages/persistence/migrations/0003_*.sql` (+ generated `meta/` files)
- Modify: `packages/persistence/src/schema.ts`
- Test: `packages/persistence/test/migration-0003.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `asset.coverFileId` column in the Drizzle schema (`cover_file_id`, nullable text, `references((): AnySQLiteColumn => file.id, { onDelete: 'set null' })`). Plan decision: `on delete set null` so a later physical file deletion can never leave a dangling cover. No repository uses the column yet (Task 8).

- [ ] **Step 1: Write the failing test** following `migration-0002.test.ts`: build a phase 2 database from tags `0000`, `0001`, `0002`, seed a workspace, storage, asset type, asset, and three files (`a.png` as `image/png`, `b.avif` and `C.AVIF` as `application/octet-stream`), then open it with the full migrations folder:

```ts
it('migration 0003 adds an empty cover column and fixes avif MIME types', () => {
  expect(cols('asset')).toContain('cover_file_id');
  expect(row('asset').cover_file_id).toBeNull();
  expect(mime('b.avif')).toBe('image/avif');
  expect(mime('C.AVIF')).toBe('image/avif');
  expect(mime('a.png')).toBe('image/png');
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
```

- [ ] **Step 2: Run** `pnpm --filter @assetforge/persistence test migration-0003` — expect FAIL.

- [ ] **Step 3: Add the column to `schema.ts`, run** `pnpm --filter @assetforge/persistence db:generate`. Expected output: one new `0003_*.sql` with `ALTER TABLE \`asset\` ADD \`cover_file_id\` text REFERENCES file(id) ON DELETE set null;`. If drizzle-kit generates a table rebuild instead, keep it; the test's `foreign_key_check` and row assertions cover it. Append:

```sql
--> statement-breakpoint
UPDATE `file` SET `mime_type` = 'image/avif' WHERE lower(`original_name`) LIKE '%.avif';
```

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green.

- [ ] **Step 5: Commit and push** — `feat(persistence): migration 0003 adds asset cover and fixes avif types`.

---

### Task 8: Cover domain — contracts, core, persistence

**Model:** opus

**Files:**
- Create: `packages/core/src/asset-cover.ts`
- Modify: `packages/contracts/src/library.ts`, `packages/contracts/src/index.ts`, `packages/core/src/ports.ts`, `packages/core/src/index.ts`, `packages/core/test/fakes.ts`, `packages/persistence/src/asset-repository.ts`, `packages/persistence/src/file-repository.ts`, `packages/persistence/src/file-move-repository.ts`
- Test: `packages/core/test/asset-cover.test.ts`, `packages/persistence/test/asset-cover.test.ts`, `packages/contracts/test/schemas.test.ts`

**Interfaces:**
- Consumes: `isPreviewable`, `ValidationFailedError` (Task 5); `asset.coverFileId` (Task 7).
- Produces:

```ts
// contracts/library.ts
AssetSummarySchema = AssetSchema.extend({ projectCount, fileCount, workflowProgress, coverFileId: z.uuid().nullable() });
export const AssetDetailSchema = AssetSchema.extend({ coverFileId: z.uuid().nullable(), coverIsChosen: z.boolean() });
export type AssetDetail = z.infer<typeof AssetDetailSchema>;
export const SetCoverRequestSchema = z.object({ assetId: z.uuid(), fileId: z.uuid().nullable() });
// core/ports.ts — AssetRepository gains
export interface AssetCover { coverFileId: string | null; coverIsChosen: boolean }
getCover(assetId: string): Promise<AssetCover | null>; // null when the asset does not exist
setCover(assetId: string, fileId: string | null, updatedAt: string): Promise<void>;
// list() items now carry the effective coverFileId
// core/asset-cover.ts
type CoverCandidate = Pick<FileRecord, 'id' | 'status' | 'mimeType' | 'importedAt'>;
export function automaticCover(files: readonly CoverCandidate[]): string | null;
export function getAssetDetail(s: WorkspaceSession, id: string): Promise<AssetDetail>;
export function setAssetCover(s: WorkspaceSession, request: { assetId: string; fileId: string | null }): Promise<AssetDetail>;
```

Rules: effective cover = `cover_file_id` if set; else `automaticCover` = the complete, previewable file of the asset with the earliest `importedAt`, ties by `id` ascending; else `null`. `setAssetCover`: unknown asset → `not_found`; a non-null file that is unknown, not complete, attached to another asset or not previewable → `validation_failed`; sets `updated_at` to `s.now()` (plan decision: choosing a cover is a change of the asset). Clearing on detach/move does **not** touch `updated_at` (plan decision: it is a side effect, not a user edit of the asset). Port signatures of `FileRepository` and `FileMoveRepository` do not change.

- [ ] **Step 1: Write the failing core tests** (fakes; the fake shares a `CoverChoices extends Map<string, string>` between `InMemoryFiles` and `InMemoryAssets`, like `AssignmentRows`):

```ts
it('automaticCover picks the earliest complete image, ties by id', …);
it('pending and failed images are never the cover', …); // automaticCover → null; setAssetCover → validation_failed
it('a chosen cover wins over the automatic one', …);     // detail { coverFileId: chosen, coverIsChosen: true }
it('no image means no cover', …);                        // .blend only → { coverFileId: null, coverIsChosen: false }
it('setAssetCover rejects files of another asset, inbox files and non-images', …); // validation_failed each
it('setAssetCover with null returns to the automatic cover', …);
it('detaching the cover file clears the choice', …);     // relocateFile(s, coverId, null) → coverIsChosen false
it('moving the cover file to another asset clears the choice', …);
it('a role change within the asset keeps the cover', …);
it('repairing a committed move on open clears the choice', …); // recoverFileMoves with target present, source gone
it('listAssets carries the effective cover of each asset', …);
```

- [ ] **Step 2: Write the failing persistence tests** (real SQLite, as the existing repository tests): the same cover rule over `assets.list` for a page of three assets (chosen, automatic with an equal-`importedAt` tie, none); `setPlacement` to the inbox and to another asset clears `cover_file_id`; `setPlacement` to another role of the same asset keeps it; `fileMoves.commit` to another asset clears it; `getCover` of an unknown asset is `null`. Add one test that the list issues one extra statement: wrap the better-sqlite3 handle's `prepare` with a counter and assert the count for a page of 3 assets equals the count for a page of 30.

- [ ] **Step 3: Run** `pnpm --filter @assetforge/core test asset-cover` and `pnpm --filter @assetforge/persistence test asset-cover` — expect FAIL.

- [ ] **Step 4: Implement.** Persistence `list`: after reading the page rows inside the existing transaction, one query over the page's asset IDs:

```sql
SELECT asset_id, id FROM (
  SELECT asset_id, id, row_number() OVER (PARTITION BY asset_id ORDER BY imported_at, id) AS rn
  FROM file WHERE asset_id IN (…) AND status = 'complete' AND mime_type IN (…PREVIEWABLE_MIME_TYPES)
) WHERE rn = 1
```

`setPlacement` and `fileMoves.commit` become (or stay) one transaction that also runs `UPDATE asset SET cover_file_id = NULL WHERE cover_file_id = :fileId AND id IS NOT :newAssetId`. `getCover` reads the asset's `cover_file_id` and, when null, the same automatic query for one asset.

- [ ] **Step 5: Run** `pnpm test` and `pnpm typecheck` — green. (Desktop still compiles: `assets:get` keeps returning `AssetSchema` until Task 9.)

- [ ] **Step 6: Commit and push** — `feat: asset cover with automatic fallback, cleared when its file leaves the asset`.

---

### Task 9: IPC channels and host actions

**Model:** sonnet

**Files:**
- Modify: `packages/contracts/src/ipc.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/library-handlers.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/test/library-ipc.test.ts`, `apps/desktop/test/ipc.test.ts`, `apps/desktop/test/acceptance.test.ts`
- Test: `apps/desktop/test/file-shell-ipc.test.ts`, `apps/desktop/test/library-ipc.test.ts`

**Interfaces:**
- Consumes: `getAssetDetail`, `setAssetCover`, `AssetDetailSchema`, `SetCoverRequestSchema` (Task 8); `resolveFilePath` (Task 6).
- Produces:

```ts
// contracts/ipc.ts
'assets:get':        { request: IdRequestSchema, response: AssetDetailSchema },
'assets:update':     { request: (unchanged), response: AssetDetailSchema },
'assets:setCover':   { request: SetCoverRequestSchema, response: AssetDetailSchema },
'files:openExternal':{ request: z.object({ fileId: IdSchema }), response: z.null() },
'files:showInFolder':{ request: z.object({ fileId: IdSchema }), response: z.null() },
// main/ipc.ts
export interface HostActions {
  /** Electron shell.openPath: resolves '' on success, an error text otherwise. */
  openPath(absolutePath: string): Promise<string>;
  showItemInFolder(absolutePath: string): void;
  /** Called after workspace:open or workspace:create succeeded. Must not throw. */
  workspaceOpened(): void;
}
export function createWorkspaceHandlers(manager: WorkspaceManager, dialogs: Dialogs, host: HostActions): IpcHandlers;
export function createLibraryHandlers(manager: WorkspaceManager, dialogs: Dialogs, host: HostActions): LibraryHandlers;
```

Handlers: `assets:get` via `manager.read(getAssetDetail)`; `assets:update` via `manager.exclusive` (update, then `getAssetDetail`); `assets:setCover` via `exclusive`; `files:openExternal` resolves with `manager.read((s) => resolveFilePath(s, fileId, 'open'))`, then calls `host.openPath` outside the read; a non-empty result → `InvalidOperationError('No application could open this file')` (plan decision; the shell's text is never forwarded). `files:showInFolder` uses `'reveal'` and `host.showItemInFolder`. In `index.ts`, `host` is `{ openPath: (p) => shell.openPath(p), showItemInFolder: (p) => shell.showItemInFolder(p), workspaceOpened: () => {} }` (Task 10 fills `workspaceOpened`).

- [ ] **Step 1: Write the failing tests** in `file-shell-ipc.test.ts` (real manager in a temp dir as in `library-ipc.test.ts`, a recording `HostActions`):

```ts
it('opens an allowed file with its absolute path inside the workspace', …); // .blend → openPath called once, path startsWith(workspaceRoot), result { ok: true, value: null }
it('a blocked file is never handed to the shell', …);  // stored name Setup.EXE. → validation_failed, openPath not called; showInFolder still works
it('a file missing on disk is not_found', …);
it('unreachable storage is storage_unreachable', …);   // rename the workspace root away
it('a shell failure becomes invalid_operation without the shell text', …); // openPath resolves 'Access is denied C:\\x'
it('no forwarded error message contains an absolute path', …); // scan messages for root with both separators
it('workspace:open and workspace:create call workspaceOpened once each', …);
it('assets:setCover returns the detail and rejects a foreign file', …);
```

In `library-ipc.test.ts` add the three new channels to the `no_workspace_open` list and change `toHaveLength(21)` to `24`. Pass a no-op `HostActions` in every existing `createWorkspaceHandlers` call (`ipc.test.ts`, `acceptance.test.ts`).

- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test file-shell-ipc` — expect FAIL.

- [ ] **Step 3: Implement** contracts, handlers and the `index.ts` host object. Update renderer call sites that read `assets:get` / `assets:update` only as far as typecheck requires (the type widens; nothing should break).

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green.

- [ ] **Step 5: Commit and push** — `feat(desktop): cover, open-externally and show-in-folder channels`.

---

### Task 10: Media protocol and host wiring

**Model:** opus

**Files:**
- Create: `apps/desktop/src/main/media-protocol.ts`
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/index.html`
- Test: `apps/desktop/test/media-protocol.test.ts`

**Interfaces:**
- Consumes: `resolvePreviewSource`, `PreviewSource` (Task 6); `createWorkerPool`, `POOL_SIZE`, `JOB_TIMEOUT_MS` (Task 3); `createPreviewService`, `PreviewService`, `PreviewSize` (Task 4); `HostActions.workspaceOpened` (Task 9).
- Produces:

```ts
export const MEDIA_SCHEME = 'assetforge-media';
export interface MediaProtocolDeps {
  findSource(fileId: string): Promise<PreviewSource | null>;
  previews: Pick<PreviewService, 'get'>;
  readFile(path: string): Promise<Uint8Array>;
}
export function parsePreviewUrl(url: string): { fileId: string; size: PreviewSize } | null;
export function handleMediaRequest(request: { url: string; method: string }, deps: MediaProtocolDeps): Promise<Response>;
export function findSourceIn(manager: WorkspaceManager): (fileId: string) => Promise<PreviewSource | null>; // manager.read(resolvePreviewSource)
```

`parsePreviewUrl` accepts only scheme `assetforge-media:`, host `preview`, a path of exactly one segment that is a UUID, and exactly one query parameter `size` with value `thumb` or `detail`. `handleMediaRequest`: method other than `GET` → 404; then parse → `findSource` → `previews.get` → `readFile`; any `null` or thrown error → `new Response(null, { status: 404 })`. Success → `200`, body the WebP bytes, headers exactly `Content-Type: image/webp` and `Cache-Control: private, max-age=31536000`.

- [ ] **Step 1: Write the failing tests:**

```ts
it('serves the cached webp of a known complete image', …); // status 200, content-type image/webp, cache-control set
it.each([
  'assetforge-media://other/<id>?size=thumb', 'assetforge-media://preview/<id>?size=huge',
  'assetforge-media://preview/<id>', 'assetforge-media://preview/<id>/x?size=thumb',
  'assetforge-media://preview/..%2F..%2Fsecret?size=thumb', 'assetforge-media://preview/not-a-uuid?size=thumb',
  'assetforge-media://preview/<id>?size=thumb&path=C:/x', 'file:///C:/x.png',
])('answers %s with a bare 404', …); // status 404, (await res.arrayBuffer()).byteLength === 0
it('non-GET requests answer 404', …);
it('unknown, incomplete and non-image files answer 404', …); // real manager + findSourceIn
it('no open workspace answers 404', …);
it('storage unreachable answers 404', …);                    // findSource throws StorageUnreachableError
it('no preview answers 404', …);                             // previews.get resolves null
it('no response carries a path', …);                         // headers and body of every case above contain neither the workspace root nor the cache dir
```

- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test media-protocol` — expect FAIL.

- [ ] **Step 3: Implement `media-protocol.ts`.**

- [ ] **Step 4: Wire the host in `index.ts`.** At top level, before the single-instance check: `protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true } }])`. In `start()`: `const previews = createPreviewService({ cacheDir: join(app.getPath('userData'), 'cache'), pool: createWorkerPool({ workerUrl: new URL('./preview-worker.js', import.meta.url), size: POOL_SIZE, timeoutMs: JOB_TIMEOUT_MS }) })`; `workspaceOpened: () => void previews.cleanup()`; inside `app.whenReady()` before creating the window: `protocol.handle(MEDIA_SCHEME, (req) => handleMediaRequest(req, { findSource: findSourceIn(manager), previews, readFile }))` on the default session; on shutdown, after the manager closes, `await previews.close()`. In `renderer/index.html` the CSP becomes `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' assetforge-media:`.

- [ ] **Step 5: Verify.** `pnpm test`, `pnpm typecheck` green; `pnpm --filter @assetforge/desktop build` succeeds; `npx electron scripts/check-sharp.mjs out/main/preview-worker.js` from `apps/desktop` prints `sharp-check: ok`; the built app starts.

- [ ] **Step 6: Commit and push** — `feat(desktop): serve cached previews through assetforge-media`.

---

### Task 11: Renderer logic as pure functions

**Model:** sonnet

**Files:**
- Create: `apps/desktop/src/renderer/src/gallery.ts`, `apps/desktop/src/renderer/src/paged-list.ts`, `apps/desktop/src/renderer/src/list-state.ts`, `apps/desktop/src/renderer/src/media-url.ts`
- Test: `apps/desktop/test/gallery.test.ts`, `apps/desktop/test/paged-list.test.ts`, `apps/desktop/test/list-state.test.ts`, `apps/desktop/test/media-url.test.ts`

**Interfaces:**
- Consumes: nothing (no React, no DOM types beyond `Storage`).
- Produces:

```ts
// paged-list.ts
export const PAGE_SIZE = 60;
export const MAX_IN_FLIGHT = 2;
export type PageEntry<T> = { status: 'loading' } | { status: 'loaded'; items: readonly T[] } | { status: 'failed' };
export interface PagedState<T> { key: string; total: number | null; pages: ReadonlyMap<number, PageEntry<T>> }
export type Slot<T> = { kind: 'placeholder' } | { kind: 'loaded'; item: T } | { kind: 'failed'; page: number };
export function emptyPaged<T>(key: string): PagedState<T>;
/** Pages from `wanted` that are neither loaded, loading nor failed, limited so loading ≤ maxInFlight. */
export function pagesToRequest<T>(state: PagedState<T>, wanted: readonly number[], maxInFlight?: number): number[];
export function markLoading<T>(state: PagedState<T>, pages: readonly number[]): PagedState<T>;
/** Returns `state` itself when `key !== state.key` (stale response). */
export function acceptPage<T>(state: PagedState<T>, key: string, page: number, items: readonly T[], total: number): PagedState<T>;
export function rejectPage<T>(state: PagedState<T>, key: string, page: number): PagedState<T>;
export function retryPage<T>(state: PagedState<T>, page: number): PagedState<T>;
export function slotAt<T>(state: PagedState<T>, index: number, pageSize?: number): Slot<T>;
// gallery.ts
export function columnsForWidth(width: number, minTileWidth: number, gap: number): number; // ≥ 1
export function rowCount(total: number, columns: number): number;
export function rowItems(row: number, columns: number, total: number): { start: number; end: number }; // end exclusive
export function pagesForRows(firstRow: number, lastRow: number, columns: number, total: number, pageSize?: number): number[];
export function nextFocusIndex(current: number, key: string, columns: number, total: number): number | null;
export function offsetShowingIndex(savedOffset: number, index: number, columns: number, rowHeight: number, viewportHeight: number): number;
// list-state.ts
export type AssetView = 'grid' | 'table';
export interface AssetFilters { typeId: string; status: string; projectId: string; nameContains: string } // '' = all
export const NO_FILTERS: AssetFilters;
export function filterKey(filters: AssetFilters): string;
export interface AssetListState { filters: AssetFilters; scrollOffset: number; openedIndex: number | null }
export const VIEW_STORAGE_KEY = 'assetforge.assets.view';
export function readView(storage: Pick<Storage, 'getItem'> | null): AssetView;          // default 'grid'; never throws
export function writeView(storage: Pick<Storage, 'setItem'> | null, view: AssetView): void; // never throws
// media-url.ts
export function previewUrl(fileId: string, size: 'thumb' | 'detail'): string; // `assetforge-media://preview/${fileId}?size=${size}`
export function formatLabel(originalName: string): string; // upper-cased extension after stripping trailing dots/spaces, 'FILE' when none
```

Plan decision: the view choice lives in `localStorage` (per device, survives restarts); the table is the grid with `columns = 1`. `nextFocusIndex`: ArrowRight +1, ArrowLeft −1, ArrowDown +columns, ArrowUp −columns, Home 0, End total−1, clamped to `[0, total−1]`; other keys `null`. `offsetShowingIndex` returns `savedOffset` when the row of `index` is fully visible at that offset, else the offset that puts that row at the top.

- [ ] **Step 1: Write the failing tests:**

```ts
expect(PAGE_SIZE).toBe(60); expect(MAX_IN_FLIGHT).toBe(2);
expect(pagesForRows(0, 9, 4, 2000)).toEqual([0]);            // items 0–39
expect(pagesForRows(14, 16, 4, 2000)).toEqual([0, 1]);       // items 56–67
expect(pagesForRows(0, 3, 4, 10)).toEqual([0]);              // clamps to total
expect(columnsForWidth(1000, 180, 16)).toBe(5); expect(columnsForWidth(100, 180, 16)).toBe(1);
expect(rowCount(2000, 6)).toBe(334); expect(rowItems(333, 6, 2000)).toEqual({ start: 1998, end: 2000 });
expect(pagesToRequest(stateWithLoading([3]), [3, 4, 5, 6])).toEqual([4]);  // one slot left
expect(pagesToRequest(stateWithLoaded([0]), [0, 1])).toEqual([1]);
expect(acceptPage(state, 'old-key', 0, items, 10)).toBe(state);           // stale response ignored
expect(slotAt(loadedPage0, 59)).toEqual({ kind: 'loaded', item: items[59] });
expect(slotAt(loadedPage0, 60)).toEqual({ kind: 'placeholder' });
expect(slotAt(rejectPage(s, s.key, 1), 61)).toEqual({ kind: 'failed', page: 1 });
expect(pagesToRequest(retryPage(failed1, 1), [1])).toEqual([1]);
expect(nextFocusIndex(5, 'ArrowDown', 4, 7)).toBe(6); expect(nextFocusIndex(0, 'ArrowUp', 4, 7)).toBe(0);
expect(offsetShowingIndex(0, 40, 4, 200, 600)).toBe(2000);              // row 10 → top
expect(offsetShowingIndex(1900, 40, 4, 200, 600)).toBe(1900);           // already visible
expect(filterKey({ ...NO_FILTERS, status: 'draft' })).not.toBe(filterKey(NO_FILTERS));
expect(readView(throwingStorage)).toBe('grid'); expect(readView(store({ [VIEW_STORAGE_KEY]: 'table' }))).toBe('table');
expect(readView(store({ [VIEW_STORAGE_KEY]: 'nonsense' }))).toBe('grid');
expect(() => writeView(throwingStorage, 'table')).not.toThrow();
expect(previewUrl(id, 'thumb')).toBe(`assetforge-media://preview/${id}?size=thumb`);
expect(formatLabel('scene.blend')).toBe('BLEND'); expect(formatLabel('README')).toBe('FILE');
```

- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test paged-list` (and the other three files) — expect FAIL.

- [ ] **Step 3: Implement** the four modules.

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green.

- [ ] **Step 5: Commit and push** — `feat(renderer): pure windowing, paging and list-state logic`.

---

### Task 12: Asset gallery with endless scrolling, and list state across navigation

**Model:** opus

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/usePagedList.ts`, `apps/desktop/src/renderer/src/components/CoverImage.tsx`, `apps/desktop/src/renderer/src/components/AssetGrid.tsx`, `apps/desktop/src/renderer/src/components/AssetTable.tsx`, `apps/desktop/test/seed-e2e.test.ts`
- Modify: `apps/desktop/package.json` (add `@tanstack/react-virtual`), `apps/desktop/src/renderer/src/screens/AssetsScreen.tsx`, `apps/desktop/src/renderer/src/components/WorkspaceShell.tsx`, `apps/desktop/src/renderer/src/screens/ProjectsScreen.tsx`, `apps/desktop/src/renderer/src/screens/FilesScreen.tsx`

**Interfaces:**
- Consumes: everything in Task 11; `previewUrl` (Task 11); `assets:list` items with `coverFileId` (Task 8).
- Produces:

```ts
// hooks/usePagedList.ts
export function usePagedList<T>(
  key: string,
  fetchPage: (offset: number, limit: number) => Promise<{ items: T[]; total: number }>,
  wantedPages: readonly number[],
): { state: PagedState<T>; retry(page: number): void };
// components/CoverImage.tsx — <img src={previewUrl(fileId, size)} loading="lazy"> in a fixed frame,
// object-contain; on error or fileId null it renders `fallback` (text) instead; never a broken-image icon.
export function CoverImage(props: { fileId: string | null; size: 'thumb' | 'detail'; fallback: string; className?: string }): JSX.Element;
// AssetsScreen props
{ state: AssetListState; onStateChange(next: AssetListState): void; onOpen(id: string): void }
// ProjectsScreen / FilesScreen gain { offset: number; onOffsetChange(offset: number): void }
```

Behaviour (spec "Renderer — Assets screen" and "Navigation"): the view switch (two `BUTTON`s with `aria-pressed`, `title` tooltips) sits next to the filters and calls `writeView`; the initial view comes from `readView(localStorage)`. One scroll container per view (an inner element that fills the remaining window height; plan decision) driven by `useVirtualizer` over rows (`count = rowCount(total, columns)`, fixed row height per view, overscan 3 rows, `initialOffset = offsetShowingIndex(...)` from the saved state). Grid columns come from `columnsForWidth(containerWidth, 180, 16)` measured with a `ResizeObserver`; table `columns = 1` with a sticky header row. Wanted pages = `pagesForRows` of the virtualizer's visible range; `usePagedList` requests `pagesToRequest(...)` and applies `markLoading`, `acceptPage`, `rejectPage`. A failed slot renders a `BUTTON` "Retry" per page (only in the first slot of that page). Placeholders have the final tile/row size. A tile/row is one `<a href="#">` (or button-styled link) with `onClick` → `onStateChange({ …, scrollOffset, openedIndex: index })` then `onOpen(id)`; `onKeyDown` uses `nextFocusIndex` and, when the target is not rendered, `virtualizer.scrollToIndex(row)` then focuses it after render. Grid tile: `CoverImage` (thumb, fallback = type name) in a 1:1 frame, then name, type, status label, `formatProgress`. Table row: small `CoverImage`, name, type, status, progress, `formatDateTime(updatedAt)`. The asset total is shown next to the view switch. Changing a filter writes `{ filters, scrollOffset: 0, openedIndex: null }`. `WorkspaceShell` keeps `AssetListState` and the projects/inbox offsets in state, so they survive navigation and are dropped when the workspace closes. Plan decision: loaded pages are not kept across navigation; returning re-fetches the visible pages (asset names and statuses may have changed on the detail screen) and restores the offset. Plan decision: only the three top-level lists keep their state; pagers inside detail screens start at page 1. Plan decision: `max-w-5xl` stays for every screen except the assets screen, which uses the full width.

- [ ] **Step 1: Add** `@tanstack/react-virtual` (`pnpm --filter @assetforge/desktop add @tanstack/react-virtual`).

- [ ] **Step 2: Implement** the hook, components, screen and shell changes as above. Remove `Pager` and `PAGE_SIZE = 50` from `AssetsScreen` only.

- [ ] **Step 3: Write `test/seed-e2e.test.ts`** — `describe.skipIf(!process.env.ASSETFORGE_SEED_USER_DATA)`: builds `createWorkspaceManager({ userDataPath: process.env.ASSETFORGE_SEED_USER_DATA, migrationsFolder: MIGRATIONS_FOLDER })`, creates a workspace "Seed" in `ASSETFORGE_SEED_ROOT` and 2 000 assets named `Asset 0001` … `Asset 2000` across the built-in types, and imports a generated 64×64 PNG (Sharp, distinct colour) attached as `reference` to every 50th asset. It is skipped in `pnpm test`.

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green (the seed test reports as skipped).

- [ ] **Step 5: Smoke.** `pnpm --filter @assetforge/desktop build`, seed a throw-away user-data directory (`ASSETFORGE_SEED_USER_DATA=<dir> ASSETFORGE_SEED_ROOT=<dir2> pnpm --filter @assetforge/desktop test seed-e2e`), launch the built app with `--user-data-dir=<dir>`, open "Seed": grid and table render, scrolling to the end works, covers show for every 50th asset. No console errors.

- [ ] **Step 6: Commit and push** — `feat(renderer): virtualized asset gallery with grid and table views`.

---

### Task 13: File tiles, detail dialog and cover actions

**Model:** sonnet

**Files:**
- Create: `apps/desktop/src/renderer/src/components/FileTile.tsx`, `apps/desktop/src/renderer/src/components/FileGrid.tsx`, `apps/desktop/src/renderer/src/components/FileDetailDialog.tsx`
- Modify: `apps/desktop/src/renderer/src/screens/AssetScreen.tsx`, `apps/desktop/src/renderer/src/screens/FilesScreen.tsx`

**Interfaces:**
- Consumes: `CoverImage` (Task 12); `previewUrl`, `formatLabel` (Task 11); `FileRecord.previewable`, `FileRecord.openable` (Task 5); channels `assets:get`, `assets:setCover`, `files:openExternal`, `files:showInFolder` (Task 9); `formatBytes`, `formatDateTime`, `label`.
- Produces:

```ts
export function FileTile(props: { file: FileRecord; isCover: boolean; onSelect(file: FileRecord, trigger: HTMLElement): void }): JSX.Element;
export function FileGrid(props: { files: readonly FileRecord[]; coverFileId: string | null; onSelect: FileTile['onSelect'] }): JSX.Element;
export function FileDetailDialog(props: {
  file: FileRecord;
  cover: { coverFileId: string | null; coverIsChosen: boolean } | null; // null in the inbox: no cover actions
  onSetCover?(fileId: string | null): Promise<void>;
  extraControls?: React.ReactNode; // the existing role select and Detach / AssetPicker controls
  onClose(): void;
}): JSX.Element;
```

Behaviour: `FileTile` is one `<button>` (styled as a tile, not as a `BUTTON` — it is a tile, not an action; plan decision consistent with the "one button style" rule, which covers action buttons) showing `CoverImage(thumb, fallback = formatLabel(originalName))` when `previewable`, else the format label; the original name below; a "Cover" marker when `isCover`. `FileGrid` renders a responsive CSS grid of tiles. `FileDetailDialog` uses a native `<dialog>` opened with `showModal()` (plan decision: the platform provides the focus trap, inert background and Escape); on close, focus returns to the trigger element. It shows `CoverImage(detail)` or the format tile, original name, role, `formatBytes(sizeBytes)`, `formatDateTime(importedAt)`, then actions as `BUTTON`s: "Open externally" (only when `file.openable`), "Show in folder", and — only when `cover` is given and the file is `previewable` — "Use as cover" (when it is not the chosen cover) or "Use automatic cover" (when it is the chosen cover), followed by `extraControls`. Action errors show via `describeError` in an `ALERT` line inside the dialog. On the asset screen the per-role tables become `FileGrid`s (paging unchanged), the cover comes from `assets:get`, and after a cover change, role change or detach the asset detail and file list reload. The inbox replaces its table by a `FileGrid`; the dialog's `extraControls` hold the existing assign control.

- [ ] **Step 1: Implement** the three components and both screens.

- [ ] **Step 2: Run** `pnpm test` and `pnpm typecheck` — green.

- [ ] **Step 3: Smoke** on the seeded or a fresh workspace with the built app: tiles show thumbnails, a `.blend` shows `BLEND`, the dialog opens, Escape closes it and focus is back on the tile, "Use as cover" moves the marker, "Use automatic cover" returns it, the gallery shows the new cover after going back. No console errors.

- [ ] **Step 4: Commit and push** — `feat(renderer): file tiles, file detail dialog and cover actions`.

---

### Task 14: Documentation

**Model:** sonnet

**Files:**
- Modify: `ReadMe.md`, `docs/backlog.md`, `CLAUDE.md` (local file, git-ignored: update "Project state" only, do not stage it)

- [ ] **Step 1: `ReadMe.md`.** §4: note that previews exist for the six raster MIME types and that other formats get a format tile, "Open in external application" with the block list rule. §9.3: `cache/thumbnails` and `cache/previews` exist, keyed by content. §10: add `asset.cover_file_id` to the "Implemented so far" paragraph (phase 3a). §15.1: replace "invalidated based on file ID, content version, size and preview format" with "keyed by the file's SHA-256, the preview size and a preview format version — never by file ID — so identical content shares a preview and a changed file never shows a stale one". §15.3: thumbnail workers "2 concurrent" and both caches "2 GiB" are now implemented constants; gallery page size 60. §16: the `assetforge-media://` protocol serves only cached previews; "Open externally" never opens files on the block list. Add a short "Implemented so far (phase 3a)" note where phase 2 has one.

- [ ] **Step 2: `docs/backlog.md`.** Remove "Returning from a detail screen resets the filters and page of the list." Add: no settings for cache size and location; preview worker timeout (30 s) is a constant; the failure memory is per session and not invalidated when a file changes; pagers inside detail screens (project members, asset files) still reset on navigation; the file grids of an asset still page by 50 and group per loaded page; no DOM test for the gallery, the dialog and keyboard navigation (covered only end to end); `Cache-Control` max-age assumes the content of a file ID never changes (true until working-file re-hashing in phase 6); `check-sharp.mjs` is a manual gate, not part of `pnpm test`.

- [ ] **Step 3: Run** `pnpm test` and `pnpm typecheck` — green. **Commit and push** — `docs: phase 3a gallery, previews and cover`.

---

## End-to-end checklist (controller)

Run on the built app (`pnpm --filter @assetforge/desktop build`, launched unpackaged with a throw-away `--user-data-dir`), with the renderer's DevTools Network panel open.

- [ ] Seed 2 000 assets with `seed-e2e.test.ts` (Task 12, Step 5). Grid view: scroll to the end; the number of tile elements in the DOM (`document.querySelectorAll('[data-asset-tile]').length`) stays bounded (does not grow with scrolling); only the pages scrolled through were requested (count `assets:list` calls via a temporary `console.debug` or DevTools breakpoint on `call`). Same in table view.
- [ ] Set a status filter, switch the view: the filter stays. Open an asset from the middle of the list, go back: the same position, the opened asset in view.
- [ ] Choose the table view, quit, relaunch: the table view is selected.
- [ ] Fresh workspace: import PNG, JPEG, TIFF, AVIF, an animated GIF, an EXR and a `.blend`. Gallery and asset screen show thumbnails for the raster images, format tiles for EXR and BLEND.
- [ ] Attach two images to an asset: the earlier import is the cover. Choose the other one ("Use as cover"), check the marker and the gallery; "Use automatic cover" returns. Choose it again and detach it: the cover falls back to the automatic one.
- [ ] "Open externally" on the `.blend` opens Blender (or the associated application); "Show in folder" reveals it. Import a renamed `.bat`: the dialog offers only "Show in folder".
- [ ] Network panel: every image request is an `assetforge-media://preview/…` URL; no `file://` request; a corrupt PNG shows its format tile, no broken-image icon. Delete `<userData>/cache` while running and scroll: thumbnails come back.
- [ ] Final whole-branch review (most capable model), one fix wave, then finish the branch.
