# Phase 4a — Jobs and Batch Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A persistent job queue in the workspace database and a batch image analysis that writes AI tags on files, running end to end against a deterministic mock provider.

**Architecture:** A general `job` table plus a `file_analysis` provenance table in the workspace SQLite database. A scheduler (`packages/jobs`) lives in the Electron main process, one per open workspace, and runs pluggable handlers with per-class limits, retry with backoff, cancel and restart recovery. The only job type, `vision.analyze_file`, reads a JPEG from the media worker pool, asks a `VisionProvider` (Ollama HTTP adapter in `packages/providers`) and writes tags in one transaction. The renderer polls a job summary, shows a Jobs screen and paints AI tags in their own colour.

**Tech Stack:** TypeScript 7, Zod 4, better-sqlite3 + Drizzle, Vitest 5 (jsdom + Testing Library for the renderer), Sharp, React 19, Tailwind 4 tokens, plain Node for the mock provider.

**Spec:** `docs/superpowers/specs/2026-11-26-phase-4a-jobs-design.md` — binding. Where this plan and the spec differ, the spec wins.

**Branch:** `phase-4a-jobs` (from `main`). Every commit is followed by `git push`. No attribution lines in commit messages.

## Global Constraints

- Everything in the repository is English. Commit messages follow the existing style (`feat:`, `test:`, `docs:`, `refactor:`).
- `packages/core` and `packages/contracts` import no Electron, no SQLite, no HTTP client, no concrete provider. `packages/jobs` and `packages/providers` depend on `core` and `contracts` only.
- New packages copy the layout of `packages/storage`: `"type": "module"`, `"exports": "./src/index.ts"`, `tsconfig.json` extending `../../tsconfig.base.json`, `vitest.config.ts` with `include: ['test/**/*.test.ts']`, scripts `test` and `typecheck`. `packages/jobs` and `packages/providers` run under plain Node Vitest (no native modules).
- Tests of `packages/persistence`, `packages/media` and `apps/desktop` run under Electron's Node; run a single file with `pnpm --filter @assetforge/<package> test <file>` (no `--`).
- A stored job error is exactly one `JobErrorCode` and the fixed message of that code. Never a URL, response body, cause message or absolute path — not in the row, not over IPC. Causes go to `console.error` in the main process only.
- No provider call and no image decoding inside a database transaction or inside `WorkspaceManager.exclusive`.
- The scheduler's `stop()` is never awaited from inside `exclusive`, and it is stopped before `manager.open`, `create`, `close` or `remove` is called.
- Exact values: at most 3 runs per job; retry delays 5 000 ms and 30 000 ms; limits `{ cpu: 2, io: 2, local_gpu: 1, remote_api: 2 }`; at most 20 tags per analysis; JPEG quality 85, longest edge 1024; adapter timeout 120 000 ms; mock port 11500; summary poll every 2 000 ms; `ANALYSIS_PROMPT_VERSION = 1`; provider name `ollama`; default model `mock-vision`; default base URL `http://127.0.0.1:11500`.
- Renderer: no explanatory text in the layout (tooltips through `title`), every button uses `BUTTON` / `ICON_BUTTON` from `ui.ts`, no colour literals outside `index.css` tokens (`test/theme.test.ts` guards it).
- No real Ollama, no API key, no `Authorization` header anywhere in 4a. Implementers never launch the app.
- `pnpm test` and `pnpm typecheck` are green at the end of every task.

## Review Focus

1. **A provider answer full of junk** — `tags` holding non-strings, empty strings, 200-character strings, 500 entries, or the same tag in different case. Expected: cleaned to at most 20 valid distinct tags, or `invalid_response`; never a crash, never a tag longer than `MAX_TAG_LENGTH`. (Task 8)
2. **HTTP 200 that is not an answer** — a non-JSON body, Ollama's `{ "error": "…" }` shape, a missing `message.content`. Expected: `invalid_response`, and the body appears nowhere in the job row. (Task 7)
3. **"Retry failed" with two finished jobs of one file** — both failed or cancelled. Expected: exactly one becomes `queued`, the other stays, no unique-index error reaches the renderer. (Task 2)
4. **A summary poll that fails** — `jobs:summary` rejects (workspace closing, shutdown). Expected: the shell keeps working, no alert, the last summary stays, polling continues. (Task 12)
5. **A broken `ASSETFORGE_VISION_BASE_URL`** — empty, `file:///x`, `http://user:secret@host`, not a URL. Expected: the default is used, one warning is logged, and the warning does not contain the value. (Task 9)

## Execution notes

Subagent models: tasks 1, 3, 5, 6, 10 — `sonnet`; tasks 2, 4, 7, 8, 9, 11, 12, 13, 14 — `opus`; task reviews — `opus` (`sonnet` for 1, 6, 10); final whole-branch review — `fable`.

## File structure

```text
packages/contracts/src/jobs.ts                 job enums, error codes and messages, JobView, summary, enqueue result
packages/contracts/src/ipc.ts                  eight new channels (added in task 9)
packages/core/src/jobs.ts                      Job, NewJob, JobError, JobHandler, JobControl, job use cases
packages/core/src/analysis.ts                  prompt, schema, cleanTags, enqueueAnalysis, createAnalyzeFileHandler
packages/core/src/ports.ts                     JobRepository, FileAnalysisRepository, VisionProvider, ModelImageSource; TagRepository change
packages/core/test/memory-jobs.ts              InMemoryJobRepository (also imported by packages/jobs tests)
packages/persistence/src/schema.ts             job, file_analysis
packages/persistence/src/job-repository.ts
packages/persistence/src/file-analysis-repository.ts
packages/persistence/migrations/0006_*.sql     generated
packages/jobs/src/scheduler.ts                 createScheduler, DEFAULT_LIMITS, MAX_ATTEMPTS, RETRY_DELAYS_MS
packages/providers/src/ollama-vision.ts        createOllamaVision
packages/media/src/{messages,generate,preview-worker,worker-pool}.ts   the `jpeg` worker job
docker/mock-provider/server.mjs + server.d.mts
compose.yaml, .env.example
apps/desktop/src/main/vision-config.ts         readVisionConfig
apps/desktop/src/main/job-host.ts              scheduler lifecycle per workspace, change counter
apps/desktop/src/main/job-handlers.ts          IPC handlers of the eight channels
apps/desktop/src/renderer/src/analysis.ts      analysable(), startAnalysis()
apps/desktop/src/renderer/src/jobs-context.tsx summary polling
apps/desktop/src/renderer/src/screens/JobsScreen.tsx
```

---

### Task 1: Contracts — job types

**Files:**
- Create: `packages/contracts/src/jobs.ts`, `packages/contracts/test/jobs.test.ts`
- Modify: `packages/contracts/src/index.ts` (export)

**Interfaces — Produces:**

```ts
export const JobStatusSchema = z.enum(['queued', 'running', 'waiting_remote', 'succeeded', 'failed', 'cancelled', 'retry_wait']);
export const ResourceClassSchema = z.enum(['cpu', 'io', 'local_gpu', 'remote_api']);
export const JobErrorCodeSchema = z.enum(['provider_unreachable', 'provider_timeout', 'provider_unavailable', 'provider_rejected', 'invalid_response', 'file_unavailable', 'internal_error']);
export type JobStatus, ResourceClass, JobErrorCode;
export const ACTIVE_JOB_STATUSES = ['queued', 'running', 'waiting_remote', 'retry_wait'] as const;
export const FINISHED_JOB_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;
export const JOB_ERROR_MESSAGES: Record<JobErrorCode, string>;
export function isRetryableJobError(code: JobErrorCode): boolean;
export const ANALYZE_FILE_JOB = 'vision.analyze_file';
export const AnalyzeFilePayloadSchema = z.object({ version: z.literal(1) });
export const JobViewSchema;        // id, type, status, attempt, fileId, fileName, errorCode, errorMessage, createdAt, startedAt, finishedAt, runAfter (nullable where the spec says so)
export const JobSummarySchema;     // queued, running, waiting, failed, cancelled, succeeded, changes — non-negative integers
export const AnalysisSkipReasonSchema = z.enum(['not_found', 'not_analysable', 'already_queued']);
export const EnqueueAnalysisResultSchema; // { enqueued: number, skipped: { fileId, reason }[] }
```

Messages (exact):

| Code | Message |
| --- | --- |
| `provider_unreachable` | `The analysis provider could not be reached` |
| `provider_timeout` | `The analysis provider did not answer in time` |
| `provider_unavailable` | `The analysis provider is temporarily unavailable` |
| `provider_rejected` | `The analysis provider rejected the request` |
| `invalid_response` | `The analysis provider returned an unusable answer` |
| `file_unavailable` | `The file is not available for analysis` |
| `internal_error` | `The job failed unexpectedly` |

- [ ] **Step 1: Write failing tests** in `jobs.test.ts`: every `JobErrorCode` has a non-empty message; `isRetryableJobError` is true exactly for `provider_unreachable`, `provider_timeout`, `provider_unavailable`, `invalid_response`; `ACTIVE_JOB_STATUSES` and `FINISHED_JOB_STATUSES` together are exactly `JobStatusSchema.options`; `JobViewSchema` accepts a view with `fileId: null, fileName: null` and rejects an unknown status; `AnalyzeFilePayloadSchema` rejects `{ version: 2 }`.
- [ ] **Step 2:** Run `pnpm --filter @assetforge/contracts test jobs` — fails (module missing).
- [ ] **Step 3:** Implement `jobs.ts` and export it from `index.ts`.
- [ ] **Step 4:** Run the test, then `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat(contracts): add job types and error codes`, push.

---

### Task 2: Persistence — `job` and `file_analysis`, repositories

**Files:**
- Modify: `packages/core/src/ports.ts`, `packages/core/src/index.ts`, `packages/persistence/src/schema.ts`, `packages/persistence/src/open-database.ts`, `packages/core/test/fakes.ts`
- Create: `packages/core/src/jobs.ts` (types only in this task), `packages/core/test/memory-jobs.ts`, `packages/persistence/src/job-repository.ts`, `packages/persistence/src/file-analysis-repository.ts`, `packages/persistence/migrations/0006_*.sql` (generated), `packages/persistence/test/migration-0006.test.ts`, `packages/persistence/test/job-repository.test.ts`, `packages/persistence/test/file-analysis-repository.test.ts`

**Interfaces — Consumes:** Task 1 types. `reindexAsset`, `assetOfFile`, `ensureTag` from the existing `search-index.ts` / `tag-repository.ts`.

**Interfaces — Produces** (in `packages/core/src/jobs.ts` and `ports.ts`):

```ts
export interface Job {
  id: string; type: string; resourceClass: ResourceClass; status: JobStatus;
  fileId: string | null; payload: unknown; dedupeKey: string | null; attempt: number;
  runAfter: string | null; errorCode: JobErrorCode | null; errorMessage: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null; updatedAt: string;
}
export interface NewJob { id: string; type: string; resourceClass: ResourceClass; fileId: string | null; payload: unknown; dedupeKey: string | null }

export interface JobRepository {
  /** One transaction. Inserts each job as `queued`, attempt 0; a job whose dedupe key is held by an active job (or by an earlier job of the same call) is skipped. Returns the inserted ids. */
  enqueue(r: { jobs: readonly NewJob[]; now: string }): Promise<string[]>;
  get(id: string): Promise<Job | null>;
  listByStatus(status: JobStatus): Promise<Job[]>;                       // oldest created_at first, then id
  /** Oldest job (created_at, id) of the class and one of `types` that is `queued`, or `retry_wait` with run_after <= now. Atomically sets `running`, attempt + 1, started_at = now, clears run_after and the error. */
  claimNext(r: { resourceClass: ResourceClass; types: readonly string[]; now: string }): Promise<Job | null>;
  /** Earliest run_after of `retry_wait` jobs of these types; null when there is none. */
  nextRunAfter(types: readonly string[]): Promise<string | null>;
  /** running → succeeded | failed | cancelled, finished_at = now, message from JOB_ERROR_MESSAGES. False when the row is not `running`. */
  finish(id: string, r: { status: 'succeeded' | 'failed' | 'cancelled'; errorCode: JobErrorCode | null; now: string }): Promise<boolean>;
  /** running → retry_wait with run_after and the error. False when the row is not `running`. */
  scheduleRetry(id: string, r: { errorCode: JobErrorCode; runAfter: string; now: string }): Promise<boolean>;
  /** running → queued, attempt − 1 (not below 0), started_at cleared. False when the row is not `running`. */
  release(id: string, now: string): Promise<boolean>;
  /** queued | retry_wait | waiting_remote → cancelled, for one job or for all. Returns how many. */
  cancelPending(r: { id?: string; now: string }): Promise<number>;
  /** failed | cancelled → queued with attempt 0, error, run_after, started_at and finished_at cleared; for one job or for all, newest created_at first, skipping a job whose dedupe key is held by an active job. Returns how many. */
  retry(r: { id?: string; now: string }): Promise<number>;
  clearFinished(): Promise<number>;
  counts(): Promise<Record<JobStatus, number>>;
  /** Newest created_at first, then id descending. `fileName` is the file's original name. */
  list(q: { limit: number; offset: number; status?: JobStatus }): Promise<{ items: JobView[]; total: number }>;
}

export interface FileAnalysis { fileId: string; sha256: string; provider: string; model: string; promptVersion: number; analysedAt: string }
export interface FileAnalysisRepository {
  get(fileId: string): Promise<FileAnalysis | null>;
  /**
   * One transaction. Returns false and writes nothing unless the file exists, is complete and has
   * this sha256. Otherwise: deletes every `ai` assignment of the file, inserts an `ai` assignment
   * for each tag the file does not carry manually (creating missing tags), upserts the analysis
   * row and reindexes the file's asset.
   */
  apply(r: { fileId: string; sha256: string; tags: readonly { name: string; displayName: string; newId: string }[]; provider: string; model: string; promptVersion: number; now: string }): Promise<boolean>;
}
// WorkspaceDatabase gains: jobs: JobRepository; analyses: FileAnalysisRepository;
```

Schema: columns, check constraints and indexes exactly as the spec's "Job model" table and "Analysis record" paragraph; index names `job_claim_idx` on `(status, resource_class, created_at, id)` and `job_active_dedupe_idx` (unique, partial: `status in ('queued','running','waiting_remote','retry_wait')`). `job.file_id` and `file_analysis.file_id` reference `file.id`.

`InMemoryJobRepository` in `packages/core/test/memory-jobs.ts` implements the full `JobRepository` contract over an array (`list` takes file names from an optional `fileName(id)` callback); `InMemoryDatabase` in `fakes.ts` gets `jobs` and an in-memory `analyses` that follows the same contract on the fake's tag data.

- [ ] **Step 1: Write the failing repository tests** (real database in a temp dir, the `tag-repository.test.ts` pattern):
  - `job-repository.test.ts`: enqueue returns ids and skips a second active job for one dedupe key, within one call and across calls; a new job is accepted after the first finished; `claimNext` takes the oldest by `created_at` then `id`, ignores other classes and types not listed, ignores `retry_wait` with a later `run_after` and takes it once `now` reached it, sets attempt 1 and `started_at`; `finish` / `scheduleRetry` / `release` return false for a job that is not `running`; `release` after a claim leaves attempt 0; `finish` with `provider_timeout` stores exactly `JOB_ERROR_MESSAGES.provider_timeout`; `cancelPending` for one and for all leaves running and finished rows alone; `retry` resets attempt and error; **`retry` for all with two failed jobs of one dedupe key requeues exactly one (the newer) and returns 1**; `retry` of one job whose key is active returns 0; `counts`; `clearFinished` removes only finished rows and returns their number; `list` order, `status` filter, `total`, `fileName` joined and null without a file.
  - `file-analysis-repository.test.ts`: `apply` returns false and writes nothing for an unknown file, a pending file, a different sha256; replaces earlier `ai` assignments; leaves manual assignments; does not add `ai` for a tag carried manually; a second `apply` replaces the analysis row; the asset's full-text search and the `tagNames` filter of `assets:list` and `files:list` find an AI tag afterwards.
  - `migration-0006.test.ts`: follows `migration-0005.test.ts` — a database migrated to 0005 with data migrates to 0006, both tables exist, the status check constraint rejects `'paused'`.
- [ ] **Step 2:** Run the three files — fail.
- [ ] **Step 3:** Add the types and ports, the Drizzle tables, run `pnpm --filter @assetforge/persistence db:generate`, check the generated SQL contains both check constraints and the partial unique index (add them by hand to the generated file if drizzle-kit omits one, as migration `0004` did for FTS).
- [ ] **Step 4:** Implement both repositories (synchronous better-sqlite3 transactions behind the async port, like the existing repositories) and wire them into `openWorkspaceDatabase`. Implement the in-memory fakes.
- [ ] **Step 5:** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 6:** Commit `feat(persistence): add the job and file analysis tables`, push.

---

### Task 3: Tags — manual wins

**Files:**
- Modify: `packages/core/src/ports.ts` (`TagRepository` doc and signatures), `packages/core/src/tags.ts`, `packages/core/test/fakes.ts`, `packages/core/test/tags.test.ts`, `packages/persistence/src/tag-repository.ts`, `packages/persistence/test/tag-repository.test.ts`; any desktop test that pins "AI tags stay" (`apps/desktop/test/library-ipc.test.ts`)

**Interfaces — Produces:** `TagRepository.removeFromAsset({ assetId, name })`, `removeFromFile({ fileId, name })`, `removeFromFiles({ fileIds, name })` — the `origin` parameter is gone; they delete the assignment whatever its origin. `addToAsset` / `addToFile` / `addToFiles` keep `origin`: with `manual` they delete an `ai` assignment of that tag on that owner in the same transaction; with `ai` they do nothing when the owner already carries the tag. The interface comment states the rule "an owner carries a tag at most once". IPC contracts do not change.

- [ ] **Step 1: Change and add tests** (both the core fake and the real repository): adding a tag by hand to a file that carries it as `ai` leaves exactly one assignment with origin `manual`; the same for assets and for `addToFiles` per file; adding `ai` over `manual` leaves `manual`; removing by hand removes an `ai` assignment (single and batch); the existing "AI tags stay" assertions are inverted.
- [ ] **Step 2:** Run `pnpm --filter @assetforge/persistence test tag-repository` and `pnpm --filter @assetforge/core test tags` — fail.
- [ ] **Step 3:** Implement in the repository, the fake and the use cases; update `FileAnalysisRepository.apply` only if it shared a helper that changed.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat(tags): an owner carries a tag at most once, manual wins`, push.

---

### Task 4: `packages/jobs` — the scheduler

**Files:**
- Create: `packages/jobs/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/scheduler.ts`, `test/scheduler.test.ts`
- Modify: `packages/core/src/jobs.ts`

**Interfaces — Consumes:** `JobRepository`, `Job` (Task 2); `InMemoryJobRepository` imported in the test as `../../core/test/memory-jobs.js`.

**Interfaces — Produces:**

```ts
// packages/core/src/jobs.ts
export class JobError extends Error { readonly code: JobErrorCode; constructor(code: JobErrorCode, options?: { cause?: unknown }); } // message = JOB_ERROR_MESSAGES[code]
export interface JobHandler { resourceClass: ResourceClass; onInterrupted: 'requeue' | 'fail'; run(job: Job, signal: AbortSignal): Promise<void> }
export interface JobControl { wake(): void; cancel(jobId: string): Promise<void> }

// packages/jobs/src/scheduler.ts
export const DEFAULT_LIMITS: Record<ResourceClass, number> = { cpu: 2, io: 2, local_gpu: 1, remote_api: 2 };
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [5_000, 30_000] as const;
export interface Scheduler extends JobControl { start(): Promise<void>; stop(): Promise<void> }
export function createScheduler(options: {
  jobs: JobRepository;
  handlers: Record<string, JobHandler>;
  limits?: Record<ResourceClass, number>;
  now?(): Date;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** Called after every status change the scheduler made. Must not throw. */
  onChange?(): void;
  log?(message: string, cause: unknown): void;   // default console.error
}): Scheduler;
```

Behaviour decisions beyond the spec's bullet list:
- A pass claims, per resource class, while `running < limit` and `claimNext` returns a job, passing only the handler types of that class. After each pass one timer is set for `nextRunAfter` (replacing the previous one). Passes never overlap: a `wake` during a pass schedules one more pass after it.
- Run outcome, with `attempt` being the value after the claim: resolved → `succeeded`; `JobError` retryable and `attempt < MAX_ATTEMPTS` → `scheduleRetry` with `run_after = now + RETRY_DELAYS_MS[attempt − 1]`; any other `JobError` → `failed` with its code; anything else thrown → `failed` / `internal_error`, the cause goes to `log`.
- `cancel(jobId)`: a job running in this scheduler gets its signal aborted and ends `cancelled` whatever its handler does afterwards; `cancel` resolves without waiting for the handler. Any other job goes through `cancelPending({ id })`. Unknown or finished ids are no-ops.
- `start()`: for each row found `running` — handler policy `requeue` or no handler → `release`; `fail` → `finish(failed, internal_error)`. Then the first pass.
- `stop()`: no new claims, timer cleared, every running signal aborted, all runs awaited; a run that still resolved is `succeeded`, a cancelled one is `cancelled`, every other one is `release`d. After `stop` resolves no repository method is called; `wake` and `cancel` are no-ops; `stop` twice is fine.

- [ ] **Step 1: Write the failing tests** with a manual clock (`now` variable, a timer list the test fires) and handlers built from deferred promises. One test per line of the spec's "Scheduler" testing bullet, plus: `onChange` fires on claim and on finish; a `wake` during a running pass is not lost; the retry timer fires the pass that claims the job, and `run_after` equals `now + 5000` after run 1 and `now + 30000` after run 2, `failed` after run 3; a `retry_wait` job competes by its `created_at` (older than a queued one → claimed first); `local_gpu: 1` runs one job while `cpu: 2` runs two at the same time; after `stop` the fake's call counter does not move even when a still-pending handler settles later.
- [ ] **Step 2:** `pnpm install`, `pnpm --filter @assetforge/jobs test` — fails.
- [ ] **Step 3:** Implement `JobError` and the types in core, then the scheduler.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat(jobs): add the job scheduler`, push.

---

### Task 5: Media — the JPEG worker job

**Files:**
- Modify: `packages/media/src/messages.ts`, `generate.ts`, `preview-worker.ts`, `worker-pool.ts`, `index.ts`, `test/generate.test.ts`, `test/worker-pool.test.ts`

**Interfaces — Produces:**

```ts
export const MODEL_JPEG_EDGE = 1024;
export const MODEL_JPEG_QUALITY = 85;
/** A JPEG of the image for a vision model; null when the source cannot be decoded within the preview limits. Never throws. */
export function modelJpeg(sourcePath: string): Promise<Uint8Array | null>;            // generate.ts
// WorkerJob gains { kind: 'jpeg'; sourcePath: string }; WorkerResponse.result gains Uint8Array
// WorkerPool gains: jpeg(sourcePath: string): Promise<Uint8Array | null>;  // null on timeout, crash or an invalid answer, like `measure`
```

Same `limitInputPixels` and byte limit as `generatePreview`; `.rotate()` for EXIF; `fit: 'inside'`, `withoutEnlargement: true`; `flatten({ background: '#ffffff' })`; the result is not written to disk.

- [ ] **Step 1: Write the failing tests** using the existing fixtures: a 3000 × 2000 source yields a JPEG whose metadata is 1024 × 683; a 200 × 100 source stays 200 × 100; an EXIF-rotated fixture comes out with swapped dimensions; a transparent PNG yields a white pixel where it was transparent; the output starts with `FF D8`; a text file and a source above the pixel limit yield `null`; `pool.jpeg` returns bytes through a real worker and `null` for a missing file.
- [ ] **Step 2:** `pnpm --filter @assetforge/media test generate` — fails.
- [ ] **Step 3:** Implement; extend `validResult` in the pool for the new kind.
- [ ] **Step 4:** `pnpm --filter @assetforge/media test`, `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat(media): render a JPEG for vision models in the worker pool`, push.

---

### Task 6: Mock provider and Compose profile

**Files:**
- Create: `docker/mock-provider/server.mjs`, `docker/mock-provider/server.d.mts`, `compose.yaml`, `.env.example`, `packages/providers/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts` (empty export for now), `test/mock-provider.test.ts`

**Interfaces — Produces:**

```ts
// server.d.mts
export type MockFailure = number | 'invalid' | 'hang';
export interface MockProvider { url: string; close(): Promise<void>; requests: { method: string; path: string; body: unknown; headers: Record<string, string | string[] | undefined> }[] }
export function startMockProvider(options?: { port?: number; host?: string; delayMs?: number; failures?: MockFailure[] }): Promise<MockProvider>;
export const MOCK_MODEL = 'mock-vision';
```

- `port: 0` picks a free port (tests use it); `url` is `http://<host>:<actual port>`.
- `GET /api/tags` → `{ models: [{ name: 'mock-vision', model: 'mock-vision' }] }`.
- `POST /api/chat` → `{ model, created_at, message: { role: 'assistant', content: '{"tags":[…]}' }, done: true }` after `delayMs`. Tags: SHA-256 of the first image's decoded bytes selects six distinct entries of a 40-word subject/material/colour vocabulary, one of five view tags and one of five style tags (the examples in the spec). No image → 400 `{ error }`; another model → 404 `{ error }`; unknown path → 404.
- `failures` is consumed one entry per `POST /api/chat`: a number answers that status with `{ error: 'mock failure' }`; `'invalid'` answers 200 with content `not json`; `'hang'` never answers (the socket is destroyed on `close`).
- Run directly (`node server.mjs`): reads `MOCK_PORT`, `MOCK_HOST`, `MOCK_DELAY_MS`, logs one line with the URL.
- `compose.yaml`: service `mock-provider`, `profiles: ['mock']`, `image: node:22-alpine`, `command: ['node', '/app/server.mjs']`, the file mounted read-only at `/app/server.mjs`, `environment: MOCK_HOST=0.0.0.0, MOCK_DELAY_MS=${MOCK_DELAY_MS:-0}`, `ports: ['127.0.0.1:11500:11500']`, no volumes.
- `.env.example`: `ASSETFORGE_VISION_BASE_URL=http://127.0.0.1:11500`, `ASSETFORGE_VISION_MODEL=mock-vision`, `MOCK_DELAY_MS=0`, each with a one-line comment.

- [ ] **Step 1: Write the failing tests**: the same image twice gives the same eight tags, another image different ones; the eight are six vocabulary tags + one view + one style, all lower case; no image → 400; other model → 404; `failures: [503, 'invalid']` answers 503, then invalid content, then a normal answer; `'hang'` does not answer within 100 ms and `close()` still resolves; `delayMs: 50` delays the answer by at least 50 ms; `requests` records the body.
- [ ] **Step 2:** `pnpm install`, `pnpm --filter @assetforge/providers test` — fails.
- [ ] **Step 3:** Implement the server, the declaration, Compose and `.env.example`.
- [ ] **Step 4:** Tests green; `docker compose --profile mock config` parses (skip with a note in the report when Docker is unavailable to the agent).
- [ ] **Step 5:** Commit `feat(mock): add the mock vision provider and its Compose profile`, push.

---

### Task 7: `packages/providers` — the Ollama vision adapter

**Files:**
- Create: `packages/providers/src/ollama-vision.ts`, `packages/providers/test/ollama-vision.test.ts`
- Modify: `packages/providers/src/index.ts`, `packages/core/src/ports.ts`

**Interfaces — Consumes:** `startMockProvider` (Task 6), `JobError` (Task 4).

**Interfaces — Produces:**

```ts
// core ports.ts
export interface VisionProvider { analyzeImage(r: { image: Uint8Array; prompt: string; schema: unknown; signal: AbortSignal }): Promise<unknown> }
// providers
export const OLLAMA_PROVIDER = 'ollama';
export function createOllamaVision(options: { baseUrl: string; model: string; timeoutMs?: number; fetch?: typeof fetch }): VisionProvider;
```

Request exactly as the spec's adapter section; `baseUrl` with or without a trailing slash. Error mapping: fetch rejection that is not an abort → `provider_unreachable`; timeout → `provider_timeout`; 5xx and 429 → `provider_unavailable`; other non-2xx → `provider_rejected`; 2xx whose body is not JSON, has no string `message.content`, or whose content is not JSON → `invalid_response`. When the caller's signal aborts, the caller's abort reason is rethrown (not a `JobError`). The response body is never put into an error message; it may be the `cause`.

- [ ] **Step 1: Write the failing tests** against the in-process mock: the recorded request has `model`, `stream: false`, `format` equal to the schema, `options.temperature === 0`, one user message with the prompt and one base64 image that decodes to the input bytes, and **no `authorization` header**; success returns the parsed `{ tags }`; 503 and 429 → `provider_unavailable`; 400 and 404 (wrong model) → `provider_rejected`; `'invalid'` → `invalid_response`; an injected `fetch` answering 200 with `{ "error": "x" }`, and one answering 200 with `<html>`, → `invalid_response`; a closed port → `provider_unreachable`; `'hang'` with `timeoutMs: 50` → `provider_timeout`; `'hang'` with a caller abort after 20 ms rejects with something that is not a `JobError`; no thrown `JobError.message` contains the base URL.
- [ ] **Step 2:** Run — fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat(providers): add the Ollama vision adapter`, push.

---

### Task 8: Core — analysis and job use cases

**Files:**
- Create: `packages/core/src/analysis.ts`, `packages/core/test/analysis.test.ts`, `packages/core/test/jobs.test.ts`
- Modify: `packages/core/src/jobs.ts`, `packages/core/src/ports.ts`, `packages/core/src/index.ts`, `packages/core/test/fakes.ts`

**Interfaces — Consumes:** `JobRepository`, `FileAnalysisRepository`, `JobHandler`, `JobControl`, `JobError`, `VisionProvider`; `isPreviewable`; `normalizeTagName`, `cleanTagText`, `MAX_TAG_LENGTH`.

**Interfaces — Produces:**

```ts
// ports.ts
export interface ModelImageSource { jpeg(absolutePath: string): Promise<Uint8Array | null> }

// analysis.ts
export const ANALYSIS_PROMPT_VERSION = 1;
export const ANALYSIS_PROMPT: string;
export const ANALYSIS_SCHEMA: unknown;      // JSON schema: object, required `tags`, array of strings
export const MAX_ANALYSIS_TAGS = 20;
/** The usable tags of a provider answer, in order, distinct by normalised name, at most 20; [] when the answer has no usable tag. */
export function cleanAnalysisTags(answer: unknown): { name: string; displayName: string }[];
export function isAnalysable(file: FileRecord): boolean;   // complete, previewable MIME type, has a sha256
export function enqueueAnalysis(session: WorkspaceSession, r: { fileIds: readonly string[] }): Promise<EnqueueAnalysisResult>;
export function createAnalyzeFileHandler(deps: { session: WorkspaceSession; vision: VisionProvider; images: ModelImageSource; provider: string; model: string }): JobHandler;

// jobs.ts
export function listJobs(session, q: { limit: number; offset: number; status?: JobStatus }): Promise<{ items: JobView[]; total: number }>;
export function countJobs(session): Promise<Omit<JobSummary, 'changes'>>;   // waiting = retry_wait + waiting_remote
export function cancelJob(session, control: JobControl, jobId: string): Promise<void>;          // NotFoundError for an unknown id; a finished job is left alone
export function cancelAllJobs(session, control: JobControl): Promise<number>;                   // cancelPending for all, then control.cancel for each running job; returns pending + running
export function retryJob(session, jobId: string): Promise<void>;                                // NotFoundError; InvalidOperationError unless failed/cancelled and its file has no active job
export function retryFailedJobs(session): Promise<number>;
export function clearFinishedJobs(session): Promise<number>;
```

- `enqueueAnalysis`: per id in request order — unknown → `not_found`; not `isAnalysable` → `not_analysable`; otherwise a `NewJob` (`type: ANALYZE_FILE_JOB`, `resourceClass: 'local_gpu'`, `payload: { version: 1 }`, `dedupeKey: 'vision.analyze_file:<file id>'`, `id: session.newId()`); candidates the repository did not insert → `already_queued`. `enqueued` is the number inserted.
- The handler has `resourceClass: 'local_gpu'`, `onInterrupted: 'requeue'` and follows the spec's three steps. Any exception from `storage.absolutePath` or the image source in step 1 → `file_unavailable`. A job without `fileId` or with a payload that fails `AnalyzeFilePayloadSchema` → `internal_error`. `signal.aborted` is checked after step 1 and again directly before `analyses.apply`; an abort throws the signal's reason and writes nothing. `apply` returning false → `file_unavailable`. Tags get ids from `session.newId()`, the time from `session.now()`.
- `cleanAnalysisTags`: the answer must parse as `{ tags: unknown[] }`; non-string entries are dropped; each string goes through `cleanTagText` / `normalizeTagName` exactly as `tagName` in `tags.ts` does, entries that fail it (empty, longer than `MAX_TAG_LENGTH`) are dropped.
- `ANALYSIS_PROMPT`: asks for 8 to 15 short English lower-case tags covering what is shown, materials and dominant colours, exactly one view tag and exactly one style tag with the spec's examples, answered as JSON `{ "tags": [...] }`.

- [ ] **Step 1: Write the failing tests** (fakes: `InMemoryDatabase`, a scripted `VisionProvider`, a scripted `ModelImageSource`):
  - `cleanAnalysisTags`: `{ tags: ['Red  Car', 'red car', 7, '', 'x'.repeat(200), null] }` → one tag `red car`; 500 distinct tags → the first 20; `{}` / `'text'` / `{ tags: 'a' }` → `[]`.
  - `enqueueAnalysis`: a mix of a good image, an unknown id, a pending file, a `.blend` file and an already queued file → `enqueued: 1` and the four reasons in request order.
  - Handler: success writes AI tags and the analysis record (`provider`, `model`, `promptVersion: 1`, the file's sha256) and passes `ANALYSIS_PROMPT` and `ANALYSIS_SCHEMA` to the provider; unknown file, pending file, non-previewable file, a throwing storage, an image source returning null twice → `JobError('file_unavailable')` and the provider is not called; image source null once while the file's `relativePath` changed in between → the second call gets the new absolute path and the run succeeds; null with an unchanged path → `file_unavailable` after one call; sha256 changed during the provider call → `file_unavailable`, no tags, no record; abort during the provider call → rejects, no tags, no record; an answer with no usable tag → `invalid_response`; a provider `JobError` passes through unchanged; a manual tag the provider also names stays manual and single; a second successful run replaces the first run's AI tags.
  - Job use cases: `countJobs` adds `retry_wait` and `waiting_remote` into `waiting`; `cancelJob` of an unknown id rejects `not_found`; `cancelAllJobs` returns pending + running and calls `control.cancel` once per running job; `retryJob` rejects `invalid_operation` for a queued job and for a failed job whose file has an active job.
- [ ] **Step 2:** `pnpm --filter @assetforge/core test analysis` — fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat(core): add the image analysis job and job use cases`, push.

---

### Task 9: Desktop main — scheduler lifecycle, configuration, IPC

**Files:**
- Create: `apps/desktop/src/main/vision-config.ts`, `job-host.ts`, `job-handlers.ts`, `apps/desktop/test/vision-config.test.ts`, `apps/desktop/test/jobs-ipc.test.ts`, `apps/desktop/test/analysis-acceptance.test.ts`
- Modify: `packages/contracts/src/ipc.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/package.json` (dependencies `@assetforge/jobs`, `@assetforge/providers`), `apps/desktop/test/renderer/fake-api.ts` only if its typing requires the new channels

**Interfaces — Consumes:** everything from tasks 1–8; `pool.jpeg` (Task 5).

**Interfaces — Produces:**

```ts
// contracts ipc.ts — eight channels exactly as the spec's IPC table. `jobs:list` uses the same limit/offset rules as `files:list`; `jobId` is `IdSchema`; `analysis:enqueue` uses `FileIdsSchema`.

// vision-config.ts
export const DEFAULT_VISION_BASE_URL = 'http://127.0.0.1:11500';
export const DEFAULT_VISION_MODEL = 'mock-vision';
export function readVisionConfig(env: Record<string, string | undefined>, warn?: (message: string) => void): { baseUrl: string; model: string };

// job-host.ts
export interface JobHost extends JobControl {
  /** Starts a scheduler for the open workspace; no-op without one or when one runs. Never rejects. */
  workspaceOpened(): Promise<void>;
  /** Stops the scheduler and waits for its jobs; no-op without one. Never rejects. */
  workspaceClosing(): Promise<void>;
  changes(): number;
  /** For the IPC handlers: a job changed outside the scheduler. */
  changed(): void;
}
export function createJobHost(deps: { manager: WorkspaceManager; vision: VisionProvider; images: ModelImageSource; provider: string; model: string; limits?: Record<ResourceClass, number> }): JobHost;

// job-handlers.ts
export function createJobHandlers(manager: WorkspaceManager, jobs: JobHost): Pick<IpcHandlers, 'analysis:enqueue' | 'jobs:list' | 'jobs:summary' | 'jobs:cancel' | 'jobs:cancelAll' | 'jobs:retry' | 'jobs:retryFailed' | 'jobs:clearFinished'>;
```

Decisions:
- `readVisionConfig`: the base URL must parse, have protocol `http:` or `https:` and empty `username` / `password`; otherwise the default is used and `warn('ASSETFORGE_VISION_BASE_URL is not a usable http(s) URL; using the default')` is called — the value itself is never logged. An empty or missing model → the default. A trailing slash is removed.
- `createJobHost` takes the session once per scheduler through `manager.read(async (s) => s)`; it is valid until `workspaceClosing` resolved. `wake` / `cancel` without a scheduler are no-ops. The scheduler's `onChange` and `changed()` raise the counter.
- `HostActions` in `ipc.ts`: `workspaceOpened(): Promise<void>` (was `void`) and new `workspaceClosing(): Promise<void>`; neither rejects. `workspace:open`, `workspace:create`, `workspace:close` and `workspace:remove` await `workspaceClosing()` **before** calling the manager and outside `exclusive`; after the manager call — also when it failed — they await `workspaceOpened()` when `manager.current()` is not null. In `index.ts` the two actions combine the job host with the existing preview cleanup, and the quit path awaits `jobHost.workspaceClosing()` before it closes the manager.
- All eight handlers run through `manager.read` (each repository call is one atomic transaction; nothing here needs the serial queue). After a change they call `jobs.changed()` and `jobs.wake()`. `jobs:summary` is `countJobs` plus `changes: jobs.changes()`.
- The acceptance test injects a `ModelImageSource` that reads the file bytes with `fs.readFile` (no worker pool) and `limits` with `local_gpu: 1`.

- [ ] **Step 1: Write the failing tests:**
  - `vision-config.test.ts`: defaults for `{}`; a valid `https://host:1234/` → `https://host:1234`; `''`, `'nonsense'`, `'file:///x'`, `'http://user:secret@host'` → default, `warn` called once, and the warning does not contain `secret` or the given value.
  - `jobs-ipc.test.ts` (`dispatch`, real database, mock on port 0): every channel answers `no_workspace_open` without a workspace; `analysis:enqueue` with a duplicate id fails validation; enqueue → `jobs:list` shows the job with `fileName`; `jobs:summary.changes` rises after enqueue and after a job finished; `jobs:retry` of a queued job → `invalid_operation`; `jobs:cancel` of an unknown id → `not_found`; `jobs:clearFinished` returns the number removed; opening a second workspace while a job runs leaves that job `queued` with attempt 0 in the first workspace's database (reopen and check) and no unhandled rejection occurs.
  - `analysis-acceptance.test.ts` — the phase criterion: import six small PNGs with different content; give two of them a manual tag, one of which is a tag the mock will return for that image (take it from a direct mock call); start the mock with `delayMs: 150`; enqueue all six; when the first job has succeeded, `jobs:cancelAll`; expect no active job and at least one `cancelled`; `jobs:retryFailed`; when the next job is `running`, `workspace:close`; `workspace:open` with a job host whose scheduler is not started yet and expect no `running` row and attempt 0 on the interrupted job; start it and wait until `jobs:summary` shows six succeeded and nothing active; every file has eight tags of origin `ai` minus the ones it carries manually; both manual tags are still there with origin `manual` and exist once; every file has a `file_analysis` row with model `mock-vision`; the mock received no request with an `authorization` header. Waiting is done by polling `jobs:summary` with a 10 s deadline.
- [ ] **Step 2:** Run the three files — fail.
- [ ] **Step 3:** Implement contracts channels, config, host, handlers and the wiring in `ipc.ts` and `index.ts` (`createOllamaVision` from `readVisionConfig(process.env, console.warn)`, `images: { jpeg: (p) => pool.jpeg(p) }`, `provider: OLLAMA_PROVIDER`).
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build` — green.
- [ ] **Step 5:** Commit `feat(desktop): run analysis jobs per workspace and expose the job channels`, push.

---

### Task 10: Renderer — the AI tag colour

**Files:**
- Modify: `apps/desktop/src/renderer/src/index.css`, `ui.ts`, `components/TagChip.tsx`, `apps/desktop/test/renderer/tags.test.tsx`, `apps/desktop/test/theme.test.ts` (only if it lists the tokens)

**Interfaces — Produces:** token `--color-ai: #b9a3ff` (Tailwind colour `ai`); `export const AI_CHIP = \`${CHIP_BASE} border-ai text-ai\``.

- `TagChip`: `AI_CHIP` when `tag.origin === 'ai'` and neither `filter` nor `matched`; then the chip has `title="AI tag"` and the remove button `aria-label="Remove AI tag <displayName>"`. Everything else is unchanged.

- [ ] **Step 1: Write the failing tests:** an `ai` chip has the `AI_CHIP` classes, the title `AI tag` and a button named `Remove AI tag Car`; a manual chip, a filter chip with origin `ai` and a matched chip keep their look, have no title and the button name `Remove Car`; a unit test computes the WCAG contrast of `--color-ai` (parsed from `index.css`) against `--color-bg` and `--color-surface` and expects at least 4.5.
- [ ] **Step 2:** `pnpm --filter @assetforge/desktop test tags` — fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @assetforge/desktop test`, `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat(ui): show AI tags in their own colour`, push.

---

### Task 11: Renderer — starting an analysis

**Files:**
- Create: `apps/desktop/src/renderer/src/analysis.ts`, `apps/desktop/test/renderer/analysis.test.tsx`
- Modify: `file-actions.ts`, `screens/InboxScreen.tsx`, `components/AssetFilesTab.tsx` (and `screens/AssetScreen.tsx` where the tab's strip or error state lives), `apps/desktop/test/renderer/inbox.test.tsx`, `asset-screen.test.tsx`, `fixtures.ts`

**Interfaces — Consumes:** `analysis:enqueue`; `ResultStrip`, `ResultFailure`; `SelectionBar`.

**Interfaces — Produces:**

```ts
// analysis.ts
export const NONE_ANALYSABLE = 'None of the selected files is an image that can be analysed';
export function analysable(file: FileRecord): boolean;                       // status complete && previewable
export function analysableFiles(sel: FileSelection): FileRecord[];
/** Calls analysis:enqueue; the title is "<n> queued, <m> skipped" and one failure per skipped file. */
export function startAnalysis(files: readonly FileRecord[]): Promise<{ title: string; failures: ResultFailure[] }>;
// FileActionContext gains: onAnalyse?(): void
```

- Skip reasons on screen: `not_found` → `File not found`, `not_analysable` → `Not an image that can be analysed`, `already_queued` → `Already queued`.
- `fileMenuItems` adds `{ label: 'Analyse', title: 'Tag this image with the vision model', onSelect: ctx.onAnalyse }` after "Show in folder" when `ctx.onAnalyse` is given and `analysable(file)`.
- Inbox and asset Files tab: an `Analyse` button in the `SelectionBar` (after `Add tags`), `disabled` with `title={NONE_ANALYSABLE}` when `analysableFiles(selection)` is empty; it sends only the analysable files. Both hosts pass `onAnalyse` to the tile menu and to the detail dialog's `actions`. The outcome is shown in a `ResultStrip` at the place the host already shows one (the inbox reuses its strip state; the Files tab gets the same strip above its selection bar). A rejected call shows its `describeError` text in the host's existing alert. The selection is kept.

- [ ] **Step 1: Write the failing tests:** the menu of a complete PNG has `Analyse`, the menus of a pending PNG and of a `.blend` file do not, and no host without `onAnalyse` shows it; choosing it calls `analysis:enqueue` with that id and shows `1 queued, 0 skipped`; inbox selection of two images and one document → the button sends the two image ids; a response with `skipped: [{ fileId, reason: 'already_queued' }]` shows `1 queued, 1 skipped` and a row `<file name>: Already queued`; a selection of documents only → the button is disabled with the tooltip; a rejected call shows the alert; the same selection-bar and menu cases on the asset Files tab.
- [ ] **Step 2:** Run `pnpm --filter @assetforge/desktop test analysis` — fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @assetforge/desktop test`, `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat(ui): start an image analysis from the file menu and the selection`, push.

---

### Task 12: Renderer — job state in the shell

**Files:**
- Create: `apps/desktop/src/renderer/src/jobs-context.tsx`, `apps/desktop/test/renderer/jobs-context.test.tsx`
- Modify: `components/WorkspaceShell.tsx`, `components/AppShell.tsx`, `nav.ts`, `components/FileBrowser.tsx`, `screens/InboxScreen.tsx`, `components/AssetFilesTab.tsx` / `screens/AssetScreen.tsx`, `apps/desktop/test/renderer/shell.test.tsx`, `inbox.test.tsx`, `file-browser.test.tsx`

**Interfaces — Consumes:** `jobs:summary`.

**Interfaces — Produces:**

```ts
// jobs-context.tsx
export const JOB_POLL_MS = 2000;
export interface JobState {
  summary: JobSummary | null;     // null until the first answer
  active: number;                 // queued + running + waiting; 0 without a summary
  /** Rises whenever a poll saw `changes` move. */
  changeToken: number;
  /** Rises whenever a poll saw `changes` move and `succeeded` rise. */
  resultToken: number;
  /** Polls now (after the user changed jobs). */
  refresh(): void;
}
export function JobsProvider(props: { children: ReactNode }): JSX.Element;   // polls on mount and every JOB_POLL_MS; one request at a time; a failed poll keeps the last state and is not reported
export function useJobs(): JobState;                                         // outside a provider: the empty state with a no-op refresh
// nav.ts: View gains { name: 'jobs' }; AppShell: Section gains 'jobs', Props gain `activeJobs: number`
```

- `WorkspaceShell` wraps its content in `JobsProvider`, passes `active` to `AppShell` and renders a placeholder page titled `Jobs` for the view `jobs` until Task 13 replaces it.
- `AppShell`: fourth `NAV` entry `{ section: 'jobs', label: 'Jobs', icon: ListChecks }`; when `activeJobs > 0` the entry shows the number at its right edge (`tabular-nums`, muted) and the link's accessible name is `Jobs, <n> active`.
- File lists: the inbox and the asset Files tab add `resultToken` to the `reloadToken` they pass to `FileBrowser` (and to their own count loads). `FileBrowser`: when a loaded page holds a record of `viewer.fileId` that is a different object than the one last handed to the viewer, it calls `viewer.onView(record)` once, so an open detail dialog shows the fresh record.
- `startAnalysis` callers (Task 11) call `refresh()` after a successful enqueue.

- [ ] **Step 1: Write the failing tests** (fake timers): the provider polls at once and again after 2 000 ms, never overlapping (a poll still pending at the next tick is not doubled); `changeToken` rises only when `changes` moved; `resultToken` rises only when `changes` moved and `succeeded` rose; **a rejected poll renders no alert, keeps the previous summary and the next tick polls again**; unmounting stops polling; the navigation shows `Jobs` without a number for an idle summary and `Jobs, 3 active` for `queued: 2, running: 1`; choosing it shows the Jobs page; with the inbox open, a poll with risen `succeeded` makes `files:list` run again and the scroll position is kept; with the detail dialog open on a file, the reloaded record's new `ai` tag appears in the dialog.
- [ ] **Step 2:** Run `pnpm --filter @assetforge/desktop test jobs-context` — fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @assetforge/desktop test`, `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat(ui): poll the job summary, add the Jobs entry and refresh file lists`, push.

---

### Task 13: Renderer — the Jobs screen

**Files:**
- Create: `apps/desktop/src/renderer/src/screens/JobsScreen.tsx`, `apps/desktop/test/renderer/jobs-screen.test.tsx`
- Modify: `components/WorkspaceShell.tsx`, `labels.ts`, `apps/desktop/test/labels.test.ts`

**Interfaces — Consumes:** `useJobs()`; `jobs:list`, `jobs:cancel`, `jobs:cancelAll`, `jobs:retry`, `jobs:retryFailed`, `jobs:clearFinished`; `Page`, `usePagedList`, `FilterBar`, `SELECT`, `ICON_BUTTON`, `BUTTON`, the table markup of `FileTable`.

- `Page` title `Jobs`, count = the list total, count tooltip `Jobs in this workspace`.
- Columns: Job, File, Status, Attempt, Created, Error. Job shows `Analyse image` for `vision.analyze_file`, otherwise the type. File shows `fileName` or `—`. Attempt shows `<attempt> / 3`. Created uses the existing date formatter. Error shows `errorMessage`.
- Status labels (in `labels.ts`): `queued` → `Queued`, `running` → `Running`, `retry_wait` → `Retrying`, `waiting_remote` → `Waiting`, `succeeded` → `Done`, `failed` → `Failed`, `cancelled` → `Cancelled`. A `retry_wait` row's status cell has the tooltip `Next try at <time of runAfter>`.
- Filter bar: a status select labelled `Status` with `All` plus the seven labels; choosing one resets the list to the top.
- Row actions, icon buttons with `title` and `aria-label`: `Cancel job` (X icon) for queued, running, retry_wait, waiting_remote; `Retry job` (RotateCcw) for failed, cancelled.
- Page actions, `BUTTON`: `Cancel all` (disabled when `active === 0`), `Retry failed` (disabled when `failed + cancelled === 0`), `Clear finished` (disabled when `succeeded + failed + cancelled === 0`); disabled also without a summary.
- After every action: `refresh()` and a list reload. The list also reloads when `changeToken` moves (the list key contains it; the position is kept, stale rows stay until the new page arrived). An action error is shown in an `ALERT` paragraph above the table.
- Empty text: `No jobs`.

- [ ] **Step 1: Write the failing tests:** rows show the six columns for a running job, a `retry_wait` job (label `Retrying`, tooltip with the time) and a failed job (its message); the status filter sends `status: 'failed'`; `Cancel job` exists only on active rows and calls `jobs:cancel` with the id; `Retry job` only on failed and cancelled rows and calls `jobs:retry`; the three page actions call their channels and are disabled for an all-zero summary, each enabled by exactly its own counts; a rejected `jobs:retry` shows the alert; a moved `changes` in the next poll makes `jobs:list` run again; an empty list shows `No jobs`; `labels.test.ts` pins the seven labels.
- [ ] **Step 2:** Run `pnpm --filter @assetforge/desktop test jobs-screen` — fails.
- [ ] **Step 3:** Implement and replace the placeholder in `WorkspaceShell`.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build` — green.
- [ ] **Step 5:** Commit `feat(ui): add the Jobs screen`, push.

---

### Task 14: Documentation

**Files:**
- Modify: `ReadMe.md` (§6, §10, §14, §17, §18), `docs/backlog.md`, `CLAUDE.md` (project state paragraph, commands, layout)

- `ReadMe.md`, as the spec's "Documentation" section lists: §6 — only tags are stored, view and style arrive as tags, Image2Prompt is a planned function whose text is not saved, manual wins ("an owner carries a tag at most once"), provenance in `file_analysis`; §10 — `job` without a `JobAttempt` table (an attempt history comes when a job type needs it, at the latest for paid jobs), `file_analysis`; §14 — profile `mock` on `127.0.0.1:11500`, no shipped `ai` profile (the owner's Ollama is used, configured in 4b), `ASSETFORGE_VISION_BASE_URL` and `ASSETFORGE_VISION_MODEL`; §17 — phase 4 split into 4a (done) and 4b; §18 — first vision model decided: `qwen3.5:9b`, changeable as a setting, arrives with 4b.
- `docs/backlog.md`: a "Phase 4a" section with what was deferred — no circuit breaker for an unreachable provider, no attempt history, the file name on the Jobs screen is not a link, job rows are only removed by "Clear finished" — plus every finding parked during the build.
- `CLAUDE.md`: a "Phase 4a (Jobs and batch tagging) is implemented" passage in the style of the existing ones (packages, table names, channels, the manual-wins rule, the env variables, the mock command), `packages/jobs` and `packages/providers` no longer "planned", the `docker compose --profile mock up -d` line marked as existing.

- [ ] **Step 1:** Edit the three files; every statement is checked against the code on the branch, not against this plan.
- [ ] **Step 2:** `pnpm test`, `pnpm typecheck` — green (nothing may depend on the docs, this is the final full run).
- [ ] **Step 3:** Commit `docs: describe phase 4a in the ReadMe, backlog and CLAUDE.md`, push.
