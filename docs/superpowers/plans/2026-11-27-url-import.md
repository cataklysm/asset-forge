# URL Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pasted list of file URLs is downloaded through the persistent job queue into the workspace; every file keeps its URL as origin and identical content is, by default, not stored twice.

**Architecture:** `files:importUrls` inserts one `file.download` job per URL (resource class `io`, lane = host). The handler in `core` opens the URL through the port `RemoteFileSource`, feeds the stream to the existing import steps (`importStream`, extended by options) and records the origin in `file_origin`. The Node adapter in `packages/storage` enforces the address check, redirect, size and time rules. The scheduler gains a total limit per resource class and a lane hold for throttled hosts.

**Tech Stack:** TypeScript, Zod 4, better-sqlite3 + Drizzle, Node `http`/`https`/`dns`/`net`, Vitest (+ jsdom), React.

**Spec:** `docs/superpowers/specs/2026-11-27-url-import-design.md` — binding; read it with every task.

## Global Constraints

- Everything in the repository is English. Commit after every task (implementers commit, they never push or merge). No attribution lines in commits.
- Tests never reach the internet, never call host port 11434, never the Venice API, never start the app or Docker. HTTP tests use an in-process `node:http` server on `127.0.0.1` with an ephemeral port and an injected permissive address policy.
- `core` and `contracts` import neither Electron nor `node:http`/`node:https`/`node:dns`.
- Job error messages are fixed texts; never a cause, a path or the URL. URLs are never logged.
- No setting, environment variable or flag weakens the address policy; `createUrlSource` is the only place a policy is passed and the desktop host passes none (default = public only).
- User-Agent is exactly `AssetForge/<app version>`; no cookies, no `Referer`, no other headers than `Accept: */*` and `Accept-Encoding: identity`.
- Renderer: no explanatory text in the layout (tooltips through `title`), button class constants from `ui.ts`, labels in `labels.ts`, no colour literals (`test/theme.test.ts`).
- Commands: `pnpm --filter @assetforge/<package> test <file>` (no `--`), `pnpm typecheck`, `pnpm test`. Known flake: `inbox.test.tsx > filters and scroll offset survive navigation`.
- Constants (exact): `MAX_IMPORT_URLS = 5000`, `MAX_FILE_ORIGINS = 50`, `MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024`, `DOWNLOAD_HEADER_TIMEOUT_MS = 30_000`, `DOWNLOAD_IDLE_TIMEOUT_MS = 60_000`, `DOWNLOAD_TOTAL_TIMEOUT_MS = 1_800_000`, `MAX_DOWNLOAD_REDIRECTS = 5`, `DOWNLOAD_FREE_SPACE_RESERVE = 2 * 1024 ** 3`, `RETRY_AFTER_MIN_MS = 5_000`, `RETRY_AFTER_MAX_MS = 900_000`, `RETRY_AFTER_DEFAULT_MS = 60_000`, `DEFAULT_TOTALS = { io: 4 }`.

## Review Focus

1. A redirect or DNS answer that points at a private address after the first check passed (rebinding, `http://public → 302 → http://127.0.0.1`, IPv4-mapped IPv6 `::ffff:10.0.0.1`, a host with one public and one private address) — must fail `download_address_refused` with no connection to the private address. Tests in Task 5.
2. A server that lies about or omits `Content-Length` and sends more than the limit — the stream is cut, the job fails `download_too_large`, no file row and no staged bytes remain. Tests in Tasks 5 and 4.
3. The application closes mid-download — on the next open the pending row and its staged bytes are gone (not a `failed` file) and the job runs again. Tests in Tasks 4 and 6.
4. The same URL pasted twice, in one request and in two requests while the first is still queued, and again after it finished — exactly one file. Tests in Tasks 4 and 6.
5. A host answering 429 with `Retry-After` — all waiting jobs of that host wait, jobs of other hosts keep running, run counts of the held jobs do not rise. Tests in Task 3.

---

### Task 1: Contracts

**Files:**
- Modify: `packages/contracts/src/jobs.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/src/index.ts` (exports, if needed)
- Create: `packages/contracts/src/url-import.ts`
- Test: `packages/contracts/test/url-import.test.ts` (follow the folder's existing test style), extend the existing jobs contract test if one exists

**Interfaces — Produces:**

```ts
// jobs.ts
export const FILE_DOWNLOAD_JOB = 'file.download';
// JobErrorCodeSchema gains, with these messages in JOB_ERROR_MESSAGES:
//  download_unreachable     'The address could not be reached'
//  download_unavailable     'The server is temporarily unavailable'
//  download_throttled       'The server asked to slow down'
//  download_blocked         'The server refused access'
//  download_not_found       'The file was not found at this address'
//  download_rejected        'The server rejected the request'
//  download_address_refused 'This address is not allowed'
//  download_too_large       'The file is larger than the download limit'
//  download_not_a_file      'This address is a web page, not a file'
//  download_type_refused    'This file type cannot be imported'
//  download_no_space        'There is not enough free disk space'
// RETRYABLE gains download_unreachable, download_unavailable, download_throttled.
export const JobResultSchema = z.enum(['already_present']);
export type JobResult = z.infer<typeof JobResultSchema>;
export const FileDownloadPayloadSchema = z.object({
  v: z.literal(1),
  url: z.string().min(1).max(2000),
  target: FileTargetSchema.nullable(),
  skipDuplicates: z.boolean(),
});
/** { url, host } of a download payload; nulls for anything else. */
export function downloadJobFields(payload: unknown): { url: string | null; host: string | null };
// JobViewSchema gains: url: z.string().nullable(), host: z.string().nullable(), result: JobResultSchema.nullable().
//   For a download job providerId, providerName and model are null (the lane is a host, not a provider id).
export const PausedHostSchema = z.object({ host: z.string(), reason: JobErrorCodeSchema });
// JobSummarySchema gains: pausedHosts: z.array(PausedHostSchema)

// url-import.ts
export const MAX_IMPORT_URLS = 5000;
export const MAX_FILE_ORIGINS = 50;
export const IMPORT_URL_LINE_MAX = 2000;
export const UrlImportResultSchema = z.object({
  queued: count, alreadyImported: count, alreadyQueued: count,
  invalid: z.array(z.object({ line: z.number().int().min(1), text: z.string().max(200) })),
});
export const FileOriginSchema = z.object({ id: IdSchema, url: z.string(), createdAt: z.iso.datetime() });

// ipc.ts
'files:importUrls': { request: { urls: z.array(z.string()).min(1).max(MAX_IMPORT_URLS), target: FileTargetSchema.optional(), skipDuplicates: z.boolean().optional() }, response: UrlImportResultSchema }
'files:origins':    { request: { fileId: IdSchema }, response: z.array(FileOriginSchema) }
'files:openOrigin': { request: { fileId: IdSchema, originId: IdSchema }, response: z.object({}) }
'jobs:resumeHost':  { request: { host: z.string().min(1).max(300) }, response: z.object({}) }
```

`host` in `downloadJobFields` is `new URL(url).host` (lower case, with a non-default port); an unparsable URL yields nulls. Lines longer than 2000 characters are not a schema error; they are reported as `invalid` by the use case (Task 4), so the `urls` items carry no max length.

- [ ] **Step 1:** Write tests: every new code has a message and `isRetryableJobError` is true exactly for the three retryable ones; `FileDownloadPayloadSchema` accepts `{ v: 1, url, target: null, skipDuplicates: true }` and refuses `v: 2`; `downloadJobFields({ v:1, url:'https://Example.com:8443/a.png', … })` → `{ url, host: 'example.com:8443' }`, an analysis payload → nulls; `files:importUrls` request refuses 0 and 5001 lines.
- [ ] **Step 2:** Run them, expect failures. **Step 3:** Implement. Adding fields to `JobViewSchema`/`JobSummarySchema` breaks producers and fixtures across packages: add `url: null, host: null, result: null` and `pausedHosts: []` wherever a `JobView`/`JobSummary` literal is built (persistence job repository list mapping, `packages/core/test/memory-jobs.ts`, `apps/desktop/src/main/job-handlers.ts`, renderer test fixtures and `fake-api.ts`), and stub the four new channels in the main-process handler map so `pnpm typecheck` passes (stubs reject with `internal_error`; Task 6 replaces them).
- [ ] **Step 4:** `pnpm typecheck` and `pnpm test` green. **Step 5:** Commit `feat(contracts): URL import contracts`.

---

### Task 2: Persistence — origins, job result, lane hold

**Files:**
- Modify: `packages/persistence/src/schema.ts`, `file-repository.ts`, `job-repository.ts`, `index.ts`, `open-database.ts` (wire `fileOrigins`); `packages/core/src/ports.ts`; `packages/core/test/memory-jobs.ts` and `packages/core/test/fakes.ts` (same new methods)
- Create: `packages/persistence/src/file-origin-repository.ts`, migration `0015` via `pnpm --filter @assetforge/persistence db:generate`
- Test: `packages/persistence/test/migration-0015.test.ts`, `file-origin-repository.test.ts`, extend `job-repository.test.ts`, `packages/core/test/memory-jobs.test.ts`

**Interfaces — Produces (in `packages/core/src/ports.ts`):**

```ts
export interface FileOrigin { id: string; url: string; createdAt: string }
export interface FileOriginRepository {
  listByFile(fileId: string): Promise<FileOrigin[]>;                    // createdAt, then id
  get(id: string): Promise<(FileOrigin & { fileId: string }) | null>;
  /** The oldest complete file (trash included) that carries this URL; null when none. */
  findCompleteFileByUrl(url: string): Promise<string | null>;
  /** Of `urls`, those carried by a complete file (trash included). */
  knownUrls(urls: readonly string[]): Promise<Set<string>>;
  /** False, writing nothing, when the file already has this URL or already carries MAX_FILE_ORIGINS. */
  insert(row: { id: string; fileId: string; url: string; createdAt: string }): Promise<boolean>;
}
// WorkspaceDatabase gains: fileOrigins: FileOriginRepository
// FileRepository:
//   insertPending(r: {...existing; origin?: { id: string; url: string } }): Promise<void>  // origin row in the same transaction, created_at = importedAt
//   /** Deletes a pending row (its origins cascade). False when the row is missing or not pending. */
//   deletePending(id: string): Promise<boolean>;
//   /** Ids of pending rows that carry an origin. */
//   listPendingDownloadIds(): Promise<string[]>;
// JobRepository:
//   /** Sets file_id and result of a running job. False when the row is not `running` or the file does not exist. */
//   setOutcome(id: string, r: { fileId: string; result: JobResult | null; now: string }): Promise<boolean>;
//   /** queued | retry_wait jobs of these types in this lane whose run_after is null or earlier: status retry_wait, run_after = until; attempt, error untouched. Returns how many. */
//   holdLane(r: { types: readonly string[]; lane: string | null; until: string; now: string }): Promise<number>;
//   `enqueue` is unchanged; it already returns the inserted ids.
```

Schema: table `file_origin` (`id` text pk, `file_id` text not null references `file.id` on delete cascade, `url` text not null, `created_at` text not null; unique index on (`file_id`, `url`); index on `url`); `job.result` text nullable. `job-repository.list` maps `url`/`host` through `downloadJobFields(payload)`, `result` from the column, and for `type === FILE_DOWNLOAD_JOB` answers `providerId: null, providerName: null, model: null`; `fileName` stays the joined original name. A retry (`retry`) clears `result` and, for download jobs, `file_id`.

- [ ] **Step 1:** Tests. Migration: a 0014 database with a job and a file migrates; `file_origin` exists; `job.result` is null. Origins: insert twice same URL → second false; 51st insert → false; `knownUrls` ignores a pending and a failed file but includes a trashed complete one; deleting the file (purge) removes origins; `insertPending` with `origin` writes both rows, `deletePending` removes both and answers false for a complete row. Jobs: `setOutcome` on a running job is visible in `list` (`fileName`, `result: 'already_present'`); `holdLane` moves two queued jobs of lane `a` to `retry_wait` with `run_after`, leaves lane `b`, a running job and a job already waiting longer untouched, and `claimNext` skips them until `now >= until`; `list` answers `host`/`url` for a download job and `providerId: null`.
- [ ] **Step 2:** Run, expect failures. **Step 3:** Implement schema, generate the migration, implement repositories and both fakes. **Step 4:** `pnpm --filter @assetforge/persistence test`, `pnpm --filter @assetforge/core test`, `pnpm typecheck` green. **Step 5:** Commit `feat(persistence): file origins, job result and lane hold`.

---

### Task 3: Scheduler — total limit, retry wait, lane hold, pause codes

**Files:**
- Modify: `packages/jobs/src/scheduler.ts`, `packages/jobs/src/pause-gate.ts`, `packages/jobs/src/index.ts`, `packages/core/src/jobs.ts`
- Test: `packages/jobs/test/scheduler.test.ts`, `packages/jobs/test/pause-gate.test.ts`

**Interfaces — Consumes:** `JobRepository.holdLane` (Task 2). **Produces:**

```ts
// core/jobs.ts
export class JobError extends Error {
  readonly code: JobErrorCode;
  /** For a retryable code: wait at least this long before the next run and hold the job's lane until then. */
  readonly retryAfterMs: number | null;
  constructor(code: JobErrorCode, options?: { cause?: unknown; retryAfterMs?: number });
}
// jobs/scheduler.ts
export const DEFAULT_TOTALS: Partial<Record<ResourceClass, number>> = { io: 4 };
// SchedulerOptions gains: totals?: Partial<Record<ResourceClass, number>>  (default DEFAULT_TOTALS)
```

Behaviour: a class whose running count reached its total claims nothing in that pass (it gets a pass when one of its runs ends). In `settle`, for a retryable error with `retryAfterMs !== null`: `delay = max(usual delay, retryAfterMs)`; after `scheduleRetry`, call `jobs.holdLane({ types: <types of the job's class>, lane: job.lane, until: runAfter, now })`. With `job.attempt >= MAX_ATTEMPTS` the job fails as today but the lane is still held for `retryAfterMs`. Pause gate: `DOWN` gains `download_unreachable`, `download_unavailable`, `download_throttled`, `download_blocked`; `FATAL` unchanged.

- [ ] **Step 1:** Tests (fake clock and the memory job repository the file already uses): with `limits.io = 2`, `totals.io = 4` and six jobs in six lanes, four run; when one ends the fifth starts. A handler throwing `new JobError('download_throttled', { retryAfterMs: 120_000 })` puts its job to `retry_wait` 120 s ahead, the two other queued jobs of the lane too with `attempt` unchanged, a job of another lane runs at once; after 120 s all three run. `retryAfterMs` below the usual delay keeps the usual delay. Pause gate: three `download_blocked` in a row pause the lane, `download_not_found` in between resets the count.
- [ ] **Step 2–4:** Fail, implement, `pnpm --filter @assetforge/jobs test` and `pnpm typecheck` green. **Step 5:** Commit `feat(jobs): total limit per class and lane hold`.

---

### Task 4: Core — import options, recovery, use cases, download handler

**Files:**
- Modify: `packages/core/src/import-file.ts`, `recover-imports.ts`, `ports.ts`, `index.ts`, `jobs.ts` (`retryFailedJobs` unchanged: downloads are included)
- Create: `packages/core/src/url-import.ts`, `packages/core/src/download-name.ts`, `packages/core/src/download-handler.ts`
- Test: `packages/core/test/import.test.ts`, `recovery.test.ts` (extend), `url-import.test.ts`, `download-name.test.ts`, `download-handler.test.ts` (new)

**Interfaces — Consumes:** Tasks 1–3. **Produces:**

```ts
// ports.ts
export type RemoteFileFailure =
  | 'unreachable' | 'unavailable' | 'throttled' | 'blocked' | 'not_found' | 'rejected' | 'address_refused' | 'too_large';
export class RemoteFileError extends Error {
  constructor(readonly failure: RemoteFileFailure, readonly retryAfterMs: number | null = null, options?: { cause?: unknown });
}
export interface RemoteFile {
  /** Fails with RemoteFileError('too_large') past the size limit and ('unreachable') on a stall or a lost connection. */
  stream: Readable;
  finalUrl: string;
  contentType: string | null;      // lower case, without parameters
  contentLength: number | null;
  dispositionName: string | null;  // raw file name from Content-Disposition
}
export interface RemoteFileSource { open(url: string, signal: AbortSignal): Promise<RemoteFile> }  // rejects with RemoteFileError
// Storage gains: /** Free bytes of the volume holding the storage root; null when unknown. */ freeBytes(): Promise<number | null>;

// import-file.ts — importStream(ctx, source, options?)
export interface ImportOptions {
  /** Inserted with the pending row. */
  origin?: { id: string; url: string };
  /** After the checksum, before the move: a complete file outside the trash with this SHA-256 ends the import without a file. */
  skipDuplicate?: boolean;
  /** A failure removes staging and deletes the pending row instead of marking it failed. */
  discardOnFailure?: boolean;
}
// ImportResult (contracts) is unchanged. With skipDuplicate and a hit: staging removed, pending row deleted,
// result { file: null, error: null, duplicateOf: [ids, oldest first] }. With discardOnFailure and a failure:
// { file: null, error: <message>, duplicateOf: [] } and no row.
// The thrown stream error must stay observable: importStream gains the optional `onStreamError?(error: unknown): void` in ImportOptions,
// called with the error that ended the stream, so the handler can map RemoteFileError to its code.

// url-import.ts
export function normalizeDownloadUrl(input: string): string;   // normalizeSourceUrl, then the fragment dropped; throws validation_failed
export function enqueueUrlImport(s: WorkspaceSession, r: { urls: readonly string[]; target: FileTarget | null; skipDuplicates: boolean }): Promise<UrlImportResult>;
export function listFileOrigins(s: WorkspaceSession, fileId: string): Promise<FileOrigin[]>;        // unknown file: not_found
export function resolveFileOriginUrl(s: WorkspaceSession, r: { fileId: string; originId: string }): Promise<string>;  // not_found; URL rule applied again

// download-name.ts
export function downloadFileName(r: { finalUrl: string; contentType: string | null; dispositionName: string | null }): string;
export function isWebPage(contentType: string | null): boolean;   // text/html, application/xhtml+xml

// download-handler.ts
export function createFileDownloadHandler(deps: { session: WorkspaceSession; remote: RemoteFileSource }): JobHandler;
// resourceClass 'io', onInterrupted 'requeue'
```

Rules to implement exactly as spec §7.1–§7.5:
- `enqueueUrlImport`: empty (after trim) lines are skipped and not counted; a line over 2000 characters or failing the rule goes to `invalid` (`line` 1-based over the lines as sent, `text` cut to 200); a repeat of a URL already seen in this call counts `alreadyQueued`; `fileOrigins.knownUrls` → `alreadyImported`; the rest is enqueued in one `jobs.enqueue` call (`type FILE_DOWNLOAD_JOB`, `resourceClass 'io'`, `fileId null`, `lane = new URL(url).host`, `dedupeKey 'url:' + url`), and inputs the call did not insert count `alreadyQueued`. A target whose asset does not exist: `NotFoundError`, nothing enqueued.
- `downloadFileName`: `dispositionName`, else the last path segment of `finalUrl` percent-decoded (undecodable: as is), else `download`; through `sanitizeFileName`; when `fileKind(name) === 'other'` and the name's extension is not one of the map's, append by content type: `image/jpeg .jpg`, `image/png .png`, `image/webp .webp`, `image/gif .gif`, `image/avif .avif`, `image/tiff .tiff`, `image/bmp .bmp`, `image/svg+xml .svg`, `application/pdf .pdf`, `application/zip .zip`, `model/gltf-binary .glb`.
- Handler `run`: (1) invalid payload → `internal_error`; (2) `fileOrigins.findCompleteFileByUrl(url)` hit → `setOutcome({ fileId, result: 'already_present' })`, done; (3) free space: `free = await storage.freeBytes()`; `free !== null && free < DOWNLOAD_FREE_SPACE_RESERVE` → `download_no_space`; (4) `remote.open`; map `RemoteFileError.failure` to `download_<failure>` carrying `retryAfterMs`; (5) `isWebPage` → destroy stream, `download_not_a_file`; name; `isRefusedImportName(name)` → destroy, `download_type_refused`; free space again with `contentLength` (`free < reserve + (contentLength ?? 0)` → destroy, `download_no_space`); (6) `importStream(ctx, { sourcePath: '', entryName: null, name, stream }, { origin: { id: newId(), url }, skipDuplicate: payload.skipDuplicates, discardOnFailure: true, onStreamError })`; (7) skip hit → `fileOrigins.insert` on `duplicateOf[0]` (a false answer is fine), `setOutcome({ fileId: duplicateOf[0], result: 'already_present' })`; (8) error → the captured `RemoteFileError` mapped, otherwise `internal_error`; an aborted signal rethrows the abort; (9) success → `setOutcome({ fileId, result: null })`, then with a target `relocateFile(s, file.id, target)` in a try/catch that swallows (file stays in the inbox).
- `recoverIncompleteImports`: a pending row whose id is in `files.listPendingDownloadIds()` gets its staging and inbox path removed and is deleted through `deletePending` instead of `markFailed`; `RecoveryResult` gains `discardedIds: string[]`.

- [ ] **Step 1:** Tests, using `packages/core/test/fakes.ts` and a fake `RemoteFileSource` that serves buffers:
  - import: `skipDuplicate` with existing content → no new row, staging empty, `duplicateOf` holds the existing id; without the option behaviour is byte-for-byte today's (existing tests untouched); `discardOnFailure` with a stream that errors → no row, staging empty; `origin` → `fileOrigins.listByFile` shows it on the complete file.
  - recovery: a pending row with an origin is deleted and listed in `discardedIds`; a pending row without one is still marked failed.
  - `normalizeDownloadUrl('https://a.example/x.png#frag')` → `'https://a.example/x.png'`; `ftp://`, user info, 2001 characters throw.
  - `enqueueUrlImport` with `['https://a.example/1.png', '', 'nope', 'https://a.example/1.png#x', 'https://b.example/2.png']` where `2.png` is already an origin of a trashed complete file → `{ queued: 1, alreadyImported: 1, alreadyQueued: 1, invalid: [{ line: 3, text: 'nope' }] }`; a second identical call → `queued: 0, alreadyQueued: 2`; unknown target asset → `not_found` and no job; the job has lane `a.example` and class `io`.
  - `downloadFileName`: disposition wins; `…/photo%20one` + `image/jpeg` → `photo one.jpg`; `…/` → `download`; `…/a.png` + `image/jpeg` stays `a.png`.
  - handler: success stores the file with its origin and `job.fileId`; with a target the file is in the asset with the role; target asset deleted meanwhile → file in the inbox, job succeeds; duplicate with skip → one file, two origins, `result: 'already_present'`; duplicate without skip → two files; known URL → no `open` call; HTML → `download_not_a_file` and no row; `evil.exe` → `download_type_refused`; `RemoteFileError('throttled', 90_000)` → `JobError` code `download_throttled`, `retryAfterMs 90_000`; a stream failing with `RemoteFileError('too_large')` mid-body → `download_too_large`, no row, no staging; `freeBytes()` 1 GiB → `download_no_space` and no `open`; abort mid-body → rejects, no row, no staging.
- [ ] **Step 2–4:** Fail, implement, `pnpm --filter @assetforge/core test` and `pnpm typecheck` green (add `freeBytes` to every `Storage` implementation and fake; Task 5 gives the local one its real body — until then it answers `null`). **Step 5:** Commit `feat(core): URL import use cases and download handler`.

---

### Task 5: Storage — URL source adapter, address policy, free space

**Files:**
- Create: `packages/storage/src/public-address.ts`, `packages/storage/src/url-source.ts`
- Modify: `packages/storage/src/local-storage.ts` (`freeBytes` through `fs.promises.statfs` on the root or its nearest existing parent; `bavail * bsize`; any error → `null`), `packages/storage/src/index.ts`
- Test: `packages/storage/test/public-address.test.ts`, `url-source.test.ts`, extend `local-storage.test.ts`

**Interfaces — Consumes:** `RemoteFileSource`, `RemoteFileError` (Task 4). **Produces:**

```ts
// public-address.ts
/** True only for a globally routable unicast address. `address` is an IPv4 or IPv6 literal. */
export function isPublicAddress(address: string): boolean;
// url-source.ts
export interface UrlSourceOptions {
  userAgent: string;
  allowAddress?: (address: string) => boolean;   // default isPublicAddress
  lookup?: (host: string) => Promise<string[]>;   // default dns.promises.lookup(host, { all: true }), addresses only
  maxBytes?: number; headerTimeoutMs?: number; idleTimeoutMs?: number; totalTimeoutMs?: number; maxRedirects?: number;  // defaults: the Global Constraints constants
}
export function createUrlSource(options: UrlSourceOptions): RemoteFileSource;
```

Rules (spec §7.3), exactly:
- `isPublicAddress` false for: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4` (incl. broadcast); IPv6 `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, `64:ff9b::/96` and `2002::/16` and `::ffff:0:0/96` whose embedded IPv4 is not public (IPv4-mapped in both dotted and hex form); anything `net.isIP` rejects. Strip a zone id (`%eth0`) → false.
- Per hop: parse URL (`http:`/`https:` only, else `rejected`); host is an IP literal → that address, else `lookup` (failure or empty → `unreachable`); **every** address must pass `allowAddress`, else `address_refused`; request with a `lookup` override that yields exactly the first checked address (so the socket connects to the vetted address while `Host`/SNI/certificate use the host name); `agent: false`; headers `User-Agent`, `Accept: */*`, `Accept-Encoding: identity`, nothing else.
- Status mapping: 2xx (only 200) → file; 301/302/303/307/308 → next hop from `Location` resolved against the current URL (missing/unparsable, user info, or hop count over `maxRedirects` → `rejected`); 429 and 503 → `throttled` with `retryAfterMs` from `Retry-After` (integer seconds or an HTTP date; clamped to `RETRY_AFTER_MIN_MS`…`RETRY_AFTER_MAX_MS`; absent or unparsable → `RETRY_AFTER_DEFAULT_MS`); 401/403/407/451 → `blocked`; 404/410 → `not_found`; 408 and other 5xx → `unavailable`; every other status (incl. 206, other 3xx and 4xx) → `rejected`. A `Content-Encoding` other than absent/`identity` → `rejected`. `Content-Length` over `maxBytes` → `too_large` before any body byte is read. The body of every non-file response is discarded and the socket destroyed.
- The returned stream counts bytes and fails with `RemoteFileError('too_large')` past `maxBytes`; fails `unreachable` on idle timeout, total timeout, socket error or a body shorter than `Content-Length`. Connection/TLS errors and header timeout → `unreachable`. `signal` abort destroys request and stream (stream error is the abort reason).
- `dispositionName`: `filename*=UTF-8''…` (percent-decoded) preferred, then `filename="…"`/`filename=…`; else null. `contentType`: lower-cased media type without parameters.

- [ ] **Step 1:** Tests. `isPublicAddress`: a table of every range above (one address inside each, false) plus `8.8.8.8`, `1.1.1.1`, `2606:4700:4700::1111` true, `::ffff:8.8.8.8` true, `::ffff:7f00:1` false, `::ffff:10.0.0.1` false, `not-an-ip` false. `createUrlSource` against an in-process server with `allowAddress: () => true`: 200 streams the bytes with type, length and disposition name; 302 chain of 5 works, 6 → `rejected`; redirect to `ftp://` → `rejected`; each status group maps as listed; `Retry-After: 120` → 120 000, `Retry-After: 1` → 5 000, `Retry-After: 99999` → 900 000, none → 60 000; `Content-Length` over a small `maxBytes` → `too_large` with zero body bytes requested; chunked body over `maxBytes` → stream error `too_large`; stalled body with `idleTimeoutMs: 50` → `unreachable`; `Content-Encoding: gzip` → `rejected`; the request the server saw carries exactly the three headers plus `Host`/`Connection`; abort mid-body errors the stream. With the **default** policy: `http://127.0.0.1:<port>/` → `address_refused` and the server saw no request; `lookup: async () => ['93.184.216.34', '10.0.0.5']` → `address_refused`; a public URL (through an injected `lookup` to the test server and `allowAddress` true for the first hop only) redirecting to `http://127.0.0.1:<port>/x` → `address_refused`. `freeBytes()` of a temp directory is a positive number; of a root whose parents do not exist, `null` or a number, never a throw.
- [ ] **Step 2–4:** Fail, implement, `pnpm --filter @assetforge/storage test` and `pnpm typecheck` green. **Step 5:** Commit `feat(storage): URL source with address policy`.

---

### Task 6: Desktop main — wiring, channels, acceptance

**Files:**
- Modify: `apps/desktop/src/main/job-host.ts`, `job-handlers.ts`, `library-handlers.ts`, `composition.ts`, `ipc.ts` (channel lists), `index.ts` (app version for the user agent)
- Test: extend `apps/desktop/test/jobs-ipc.test.ts`, `library-ipc.test.ts`; create `apps/desktop/test/url-import-acceptance.test.ts`

**Interfaces — Consumes:** everything above. **Produces:** the four channels of Task 1, working.

- `JobHostDeps` gains `remote: RemoteFileSource`; the scheduler gets the handler `[FILE_DOWNLOAD_JOB]: createFileDownloadHandler({ session, remote })` and `totals` (default `DEFAULT_TOTALS`, overridable like `limits`). `PAUSABLE` gains `'io'`.
- `composition.ts` builds `createUrlSource({ userAgent: \`AssetForge/${appVersion}\` })` — **no** `allowAddress` — unless the composition options carry a `remote` (tests only); `appVersion` is a new required composition option filled from `app.getVersion()` in `index.ts`.
- `jobs:summary`: lanes of class `io` go to `pausedHosts` (`{ host: lane, reason }`, a null lane is skipped); the others to `paused` as today. `jobs:resumeHost { host }` → `jobs.resume(host)`. `jobs:resume` unchanged.
- `files:importUrls`: `manager.exclusive((s) => enqueueUrlImport(s, { urls, target: target ?? null, skipDuplicates: skipDuplicates ?? true }))`, then `jobs.changed()` and `jobs.wake()`. `files:origins`: read. `files:openOrigin`: `resolveFileOriginUrl` then `host.openExternal(url)`; a host failure answers `invalid_operation` `This source could not be opened` (as `assets:openSource`).
- `jobs:reroute` and `jobs:waitingByProvider` never see download jobs (they are scoped to the analysis type already; assert it).

- [ ] **Step 1:** Tests. IPC: `files:importUrls` without a workspace → `no_workspace_open`; 5001 lines → `invalid_request`; origins/openOrigin of an unknown file → `not_found`; `openOrigin` calls the fake `openExternal` with the stored URL and never with a renderer-supplied one; `jobs:summary.pausedHosts` lists a paused `io` lane and `jobs:resumeHost` clears it. Acceptance (real SQLite, real local storage in a temp dir, in-process HTTP server, `remote = createUrlSource({ userAgent: 'AssetForge/test', allowAddress: () => true })`, the fake scheduler clock the other acceptance tests use): three URLs → three complete inbox files each with one origin, `jobs:list` shows `host` and `url`; the same list again → `alreadyImported: 3`, no request reaches the server; two URLs with identical bytes → one file with two origins and one job with `result: 'already_present'`; with `skipDuplicates: false` → two files; a target asset with role `reference` → the file is in the asset; a 404 → job `failed` `download_not_found`, `files:list` of the inbox has no failed row; a server answering 429 `Retry-After: 30` for host A while host B serves → B's file completes, A's jobs are `retry_wait`; after advancing the clock and the server recovering they complete; three 403 in a row → `pausedHosts` has the host, further jobs stay queued, `jobs:resumeHost` lets them run; closing the workspace mid-download (server holds the body) and reopening → no pending or failed row from it, the job runs again and completes; the default composition (no `remote` option) refuses `http://127.0.0.1:<port>/x.png` with `download_address_refused`.
- [ ] **Step 2–4:** Fail, implement, `pnpm --filter @assetforge/desktop test` and `pnpm typecheck` green. **Step 5:** Commit `feat(desktop): URL import channels and download jobs`.

---

### Task 7: Renderer — import dialog and entry points

**Files:**
- Create: `apps/desktop/src/renderer/src/components/UrlImportDialog.tsx`
- Modify: `screens/InboxScreen.tsx`, `screens/AssetScreen.tsx` (or the component that holds the asset's import button), `labels.ts`, `apps/desktop/test/renderer/fake-api.ts`
- Test: `apps/desktop/test/renderer/url-import-dialog.test.tsx`, extend `inbox.test.tsx`, `asset-screen.test.tsx`

**Interfaces — Produces:** `<UrlImportDialog target={FileTarget | null} onClose={() => void} />` built on the shared `Dialog`.

- Button `Import from URLs` (`URL_IMPORT_LABEL`) directly after the existing import button in the inbox and on the asset screen, disabled under the same conditions; on the asset screen the dialog receives `{ assetId, role: <the role select's current value> }`.
- Dialog state `editing`: a `textarea` (label `URLs`, tooltip `One address per line`), a checkbox `Skip duplicates` checked by default (tooltip `Identical content is not stored again`), `Cancel`, `Import` (disabled while no non-empty line or while sending). Lines are split on `\r?\n`; more than 5000 non-empty lines disables `Import` with the tooltip `At most 5000 addresses at once`. When the text has at most 5000 lines, all lines are sent as typed (trailing empty lines dropped) so `line` numbers match the input; otherwise only the non-empty lines are sent.
- State `done`: four lines `Queued <n>`, `Already imported <n>`, `Already queued <n>`, `Not usable <n>` (a line is shown only when its count is above 0; `Queued 0` always), the invalid lines as `<line>: <text>` in a scrolling list, and `Close`. A failed call shows the error text through the dialog's usual error line and returns to `editing` with the text kept.
- After a start the jobs context is refreshed (`useJobs().refresh()`); lists reload by themselves through `resultToken`.

- [ ] **Step 1:** Tests: opening from the inbox sends `{ urls, skipDuplicates: true }` without `target`; unchecking sends `false`; from the asset screen the target carries the selected role; the done state shows the counts and `3: nope`; an error keeps the text; 5001 lines disable `Import`; `Import` is disabled for whitespace only; theme and labels tests stay green.
- [ ] **Step 2–4:** Fail, implement, `pnpm --filter @assetforge/desktop test` and `pnpm typecheck` green. **Step 5:** Commit `feat(desktop): URL import dialog`.

---

### Task 8: Renderer — jobs screen, pause banner, file sources

**Files:**
- Modify: `screens/JobsScreen.tsx`, `components/AppShell.tsx`, `components/WorkspaceShell.tsx` (passes `pausedHosts` and the resume callback), `jobs-context.tsx` (`sameSummary` compares `pausedHosts` entry by entry), `components/FileDetailDialog.tsx`, `labels.ts`
- Create: `apps/desktop/src/renderer/src/components/FileOrigins.tsx`
- Test: extend `jobs-screen.test.tsx`, `shell.test.tsx`, `jobs-context.test.tsx`, `file-dialog.test.tsx`; create `file-origins.test.tsx`

- Jobs screen: a `file.download` job has the type label `Download`; the Provider cell shows `job.host`; the file cell shows `job.fileName ?? shortened job.url` (host + last path segment, at most 60 characters, full URL in `title`); a succeeded job with `result === 'already_present'` shows the status text `Already present`. The provider filter and `MoveJobsDialog` are untouched.
- Banner: after the provider lines one line per `pausedHosts` entry: `<host>` and `JOB_ERROR_MESSAGES[reason]` with `Resume` (calls `jobs:resumeHost`, then refreshes the jobs context; a rejection shows in the line like the provider lines). No `Move jobs`, no `Settings`.
- `FileOrigins { fileId }`: loads `files:origins`; renders nothing for an empty list or a failed load; otherwise a `Source` label and per origin the URL through the `Link` component (`onFollow` → `files:openOrigin { fileId, originId }`) with a copy icon button (`navigator.clipboard.writeText(url)`), the same pattern and classes as `SourceList`; more than five scroll. Placed in the details column of `FileDetailDialog` above `GenerationDetails`, keyed by file id, also for a trashed file.

- [ ] **Step 1:** Tests: the three job cell cases; a host line with Resume calling `jobs:resumeHost` and showing a rejection; `sameSummary` differs when only `pausedHosts` changes; `FileOrigins` renders two origins, follows through `files:openOrigin` (never an anchor with `href`), copies, renders nothing for none; the file dialog requests origins for the shown file and again after Next.
- [ ] **Step 2–4:** Fail, implement, `pnpm --filter @assetforge/desktop test` and `pnpm typecheck` green. **Step 5:** Commit `feat(desktop): download jobs, paused hosts and file sources`.

---

### Task 9: Documentation

**Files:** `ReadMe.md` (§4.1, §10 table list, §15.2, §15.3, §16), `docs/backlog.md` (section "URL import")

- [ ] **Step 1:** ReadMe: §4.1 a paragraph "Implemented (URL import)" with the channel, the URL rule, known-URL and duplicate behaviour, origins and what does not exist (spec §3); §10 the table `file_origin` and `job.result`; §15.2 the job type `file.download`, host lanes, the total limit of 4, the lane hold, the code table of spec §7.5, the pause per host; §15.3 the constants; §16 the address check and the honest user agent. Backlog: site adapters, grouped import view, remembered URLs after purge, origin editing/search/filter, pHash, concurrent identical downloads, a pause for all hosts on a full disk.
- [ ] **Step 2:** `pnpm test` and `pnpm typecheck` green. **Step 3:** Commit `docs: URL import`.
