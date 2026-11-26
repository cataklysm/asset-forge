# Phase 4a — Jobs and batch tagging against the mock provider — design

Date: 2026-11-26. First half of phase 4 (ReadMe §6, §8, §14, §15.2, §15.3, §17). Phase 4b (real Ollama with authentication, result dialog, fingerprint skip, Image2Prompt) follows in its own design.

## Intent

The owner wants images tagged by a vision model, one at a time or hundreds in one go, without losing work when the app closes and without the model ever touching tags they set by hand. This half builds what every long operation of later phases needs as well: a persistent job queue. To show it working end to end it already runs a batch analysis, against a deterministic mock provider, so nothing in this half needs a GPU.

## Goals

- Persistent jobs with the seven statuses of ReadMe §15.2, per-class concurrency limits, retry with backoff, cancel, and resume after a restart.
- A batch analysis of selected image files: one job per file; the result is written as AI tags on the file.
- AI tags are recognisable by their own colour everywhere a file tag chip is shown.
- A Jobs screen: what is queued, running, failed; cancel and retry.
- A mock provider that speaks the Ollama HTTP API, usable in tests without Docker and through `docker compose --profile mock`.

## Non-goals (all phase 4b unless noted)

- Provider settings UI, API key, `safeStorage`, the real Ollama instance.
- The result dialog for a single image (review tags before accepting). In 4a a single file is analysed like a batch of one.
- Skipping already analysed files by fingerprint; "analyse everything not yet analysed"; starting from an asset selection.
- Image2Prompt.
- A stored image description, a suggested asset type, view and style as fields of their own. Decided with the owner: only tags are stored; view and style arrive as tags.
- The Compose profile `ai`. The owner already runs Ollama on host port 11434; AssetForge does not ship its own.
- `waiting_remote` behaviour, remote job IDs, polling (phase 5). The status value exists, nothing sets it.
- Pausing the queue, job priorities, per-batch grouping, progress within a job.

## Anti-goals

- A re-analysis that removes or changes a manual tag.
- A job that is lost, or runs twice at the same time, because the app closed or crashed.
- A provider call inside a database transaction or inside the workspace's serial queue, blocking the UI for seconds.
- Provider URLs, response bodies, cause messages or absolute paths in a stored job error or in anything sent to the renderer.
- Asset management that fails or stalls because no provider is reachable.
- Explanatory text in the layout; a second button look; colour literals outside the theme tokens.

## Constraints

- All rules of `CLAUDE.md` and `ReadMe.md`. In particular: `core` and `contracts` depend on no concrete provider, database or Electron; providers get no database access and no workspace paths; decoding runs in the worker pool of `packages/media`; short transactions; one `BUTTON` look, tokens only, tooltips instead of text.
- Jobs live in the workspace database (one SQLite file per workspace, one writer). There is no cross-workspace queue.
- The renderer has no push channel from the main process today, and this design does not add one.

## Approaches

1. **General job table in the workspace database, scheduler inside the Electron main process** — chosen by the owner. Job types are pluggable handlers; phase 5 reuses the queue. The single-writer rule holds. Analysis is HTTP waiting, so it does not block the main event loop; image encoding stays in the existing worker pool.
2. **Scheduler in a process of its own.** A crashing job cannot take the app down, but two processes on one database or everything proxied through messages, for work that is almost only waiting. Rejected.
3. **No general jobs, only an "analysis run with items" table.** Fastest, but phase 5 needs jobs anyway and it would be built twice. Rejected.

## Design

### Packages

- `packages/jobs` (new): the scheduler. Depends on `core` (port types) and `contracts`. No Electron, no SQLite, no HTTP.
- `packages/providers` (new): `createOllamaVision`, an implementation of the core port `VisionProvider` over the Ollama HTTP API. Depends on `core` and `contracts`. Uses the global `fetch`, injectable for tests.
- `packages/core`: ports `JobRepository`, `VisionProvider`, `ModelImageSource`; use cases for enqueueing, listing, cancelling, retrying, clearing; the analysis steps; the analysis prompt.
- `packages/persistence`: table `job`, `JobRepository`, one Drizzle migration.
- `packages/media`: a worker job that returns a JPEG for the model.
- `apps/desktop`: wiring, IPC, Jobs screen, AI chip colour, Analyse actions.
- `docker/mock-provider/` and `compose.yaml` (new).

### Job model

Table `job`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | UUID |
| `type` | text | `vision.analyze_file` is the only type in 4a |
| `resource_class` | text | `cpu`, `io`, `local_gpu`, `remote_api` (check constraint) |
| `status` | text | `queued`, `running`, `waiting_remote`, `succeeded`, `failed`, `cancelled`, `retry_wait` (check constraint) |
| `file_id` | text, nullable, FK → `file.id` | the subject of the job; null for types without a file |
| `payload` | text | JSON, validated per type by a Zod schema that carries a `version`; `{ "version": 1 }` for the analysis |
| `dedupe_key` | text, nullable | see below |
| `attempt` | integer | number of started runs |
| `run_after` | text, nullable | ISO time before which a `retry_wait` job is not started |
| `error_code` | text, nullable | a `JobErrorCode` |
| `error_message` | text, nullable | the fixed message of that code |
| `created_at`, `started_at`, `finished_at`, `updated_at` | text | ISO; `started_at` is the start of the latest run |

Indexes: `(status, resource_class, created_at, id)`; a partial unique index on `dedupe_key` where `status in ('queued','running','waiting_remote','retry_wait')`.

`dedupe_key` for the analysis is `vision.analyze_file:<file id>`: a file has at most one active analysis job.

`JobErrorCode` (in `contracts`), each with one fixed English message defined next to it:

| Code | Meaning | Retried |
| --- | --- | --- |
| `provider_unreachable` | connection refused, DNS, reset | yes |
| `provider_timeout` | no answer within the timeout | yes |
| `provider_unavailable` | HTTP 5xx or 429 | yes |
| `provider_rejected` | any other HTTP 4xx (includes 401 and unknown model) | no |
| `invalid_response` | the answer is not the expected JSON or contains no valid tag | yes |
| `file_unavailable` | the file is gone, not complete, not an analysable image, or the storage is unreachable | no |
| `internal_error` | anything unexpected | no |

Status transitions:

```text
queued ──claim──▶ running ──ok──────────────▶ succeeded
                     │──retryable, attempts left──▶ retry_wait ──run_after reached──▶ running
                     │──not retryable / attempts used──▶ failed
                     │──cancel requested──▶ cancelled
                     └──app closes or crashes──▶ queued        (type policy `requeue`)
queued | retry_wait ──cancel──▶ cancelled
failed | cancelled ──retry──▶ queued   (attempt reset to 0, error cleared)
```

There is no separate attempt table (ReadMe §10 lists `Job / JobAttempt`): a job keeps a counter and the error of its latest run. *(My call: an attempt history is added when a job type needs it, at the latest for paid jobs in phase 5; §10 is updated to say so.)*

Attempts: at most 3 runs per job. Delay before the second run 5 s, before the third 30 s. A run that was interrupted by closing the app does not count as an attempt.

### Scheduler (`packages/jobs`)

```ts
interface JobHandler {
  resourceClass: ResourceClass;
  /** What happens to a job found `running` when a workspace opens. `fail` is for paid work with an unclear outcome. */
  onInterrupted: 'requeue' | 'fail';
  /** Resolves on success; throws `JobError(code)` otherwise. Must stop soon after `signal` aborts. */
  run(job: Job, signal: AbortSignal): Promise<void>;
}

createScheduler(options: {
  jobs: JobRepository;
  handlers: Record<string, JobHandler>;
  limits: Record<ResourceClass, number>;   // DEFAULT_LIMITS = { cpu: 2, io: 2, local_gpu: 1, remote_api: 2 }
  now(): Date;
  setTimer / clearTimer;                    // injectable for tests
}): {
  start(): Promise<void>;   // recovers interrupted jobs, then begins claiming
  wake(): void;             // call after enqueue, retry or cancel
  cancel(jobId: string): Promise<void>;
  stop(): Promise<void>;    // aborts running jobs, waits for them, puts them back to `queued`
}
```

- Event-driven: the scheduler looks for work on `start`, on `wake`, when a job ends and when a timer for the earliest `run_after` fires. No periodic polling of the table.
- Claiming is first in, first out by `created_at`, then `id`, per resource class, up to that class's limit. A `retry_wait` job whose time has come competes like a queued one, by its `created_at`.
- `start` handles rows found `running`: `requeue` types go back to `queued` with `attempt` reduced by one; `fail` types become `failed` with `internal_error`. A job whose `type` has no handler stays `queued` and is never claimed.
- Cancelling a running job aborts its signal; whatever the handler then does, the job ends `cancelled`, unless it had already succeeded.
- A handler that throws anything other than `JobError` ends the job as `failed` / `internal_error`; the cause is logged to the console of the main process, never stored.
- After `stop` resolves, the scheduler performs no further repository call.

One scheduler exists per open workspace. The desktop host creates and starts it after a workspace opened and stops it before the workspace closes, is switched, is removed, and on quit. *(Builder's choice how to hook this into the existing handlers; the requirement is that no job touches a database that is closing or closed.)* Two facts of the existing code bind that choice: `WorkspaceManager.doOpen` closes the previous workspace before the new one can fail, so the scheduler must be stopped before `open` is called at all; and `stop()` must never be awaited from inside `exclusive`, because a job may be waiting for that queue.

### Analysis job (`vision.analyze_file`)

Resource class `local_gpu` (limit 1), `onInterrupted: 'requeue'`.

Ports in `core`:

```ts
interface VisionProvider {
  /** Throws `JobError` with a provider code. `image` is a JPEG. */
  analyzeImage(r: { image: Uint8Array; prompt: string; schema: unknown; signal: AbortSignal }): Promise<unknown>;
}
interface ModelImageSource {
  /** A JPEG of the image, longest edge at most 1024 px, EXIF-oriented; null when it cannot be produced. */
  jpeg(absolutePath: string): Promise<Uint8Array | null>;
}
```

Steps of one run. None of them holds the workspace's serial queue (`WorkspaceManager.exclusive`) while it decodes or waits: reads go through `read`, and the write of step 3 is one synchronous database transaction like the existing tag writes.

1. **Read.** Load the file. It must exist, be `complete`, have a previewable MIME type (`PREVIEWABLE_MIME_TYPES`) and a checksum; otherwise `file_unavailable`. Remember its `sha256` and `relativePath`. Produce the JPEG through `ModelImageSource`, outside the queue. If that yields `null`, load the file again: when its `relativePath` changed meanwhile (the file was assigned or moved while it was read), repeat step 1 once with the new path; otherwise, or when the second try yields `null` too, `file_unavailable`.
2. **Ask.** Call `VisionProvider.analyzeImage` with the prompt and the JSON schema. No database or storage access happens during the call.
3. **Write.** Parse the answer with Zod as `{ tags: string[] }`. Clean every tag with the existing `normalizeTagName` / `cleanTagText`; drop invalid ones and duplicates; keep at most 20. None left → `invalid_response`. Then, in one transaction: verify the file still exists, is complete and has the remembered `sha256` (otherwise `file_unavailable`, nothing written); delete all `ai` assignments of the file; insert an `ai` assignment for every new tag that the file does not carry manually; write the file's analysis record (below); reindex the file's asset. If the signal aborted before the transaction, nothing is written.

**Analysis record.** A new table `file_analysis`, one row per file (primary key `file_id`, FK → `file.id`): `sha256` (the content that was analysed), `provider` (`ollama`), `model`, `prompt_version`, `analysed_at`. Step 3 inserts or replaces it. It is the provenance ReadMe §6 asks for (source, model, time) and survives `jobs:clearFinished`; 4b builds the fingerprint skip on it. Nothing reads it in 4a except tests. The model name reaches the handler from the host's provider configuration. *(My call; a review status is not stored, 4b decides whether the result dialog needs one.)*

A tag the owner removed can come back when the same file is analysed again: an analysis is a fresh suggestion and nothing remembers a rejection. In 4a a file is only analysed again when the owner asks for it.

The prompt lives in `core` as a constant with `ANALYSIS_PROMPT_VERSION = 1`. It asks for 8 to 15 short English tags, lower case, covering what is shown, materials, dominant colours, exactly one view tag (for example `front view`, `side view`, `three-quarter view`, `top view`, `close-up`) and exactly one style tag (for example `photorealistic`, `stylized`, `concept art`, `line drawing`, `pixel art`). *(My call: English tags, like the UI. The exact wording is the builder's; 4b tunes it against the real model.)*

`ModelImageSource` is implemented in `packages/media`: a new worker job kind that decodes the source with the same byte and pixel limits as previews and returns JPEG bytes (quality 85, longest edge 1024, EXIF-oriented, alpha flattened onto white). It is not cached: a file is analysed rarely. *(My call: JPEG rather than the cached WebP preview, because JPEG is accepted by every Ollama version.)*

### Ollama adapter (`packages/providers`)

`createOllamaVision({ baseUrl, model, timeoutMs = 120_000, fetch? }): VisionProvider`

- `POST {baseUrl}/api/chat` with `{ model, stream: false, format: <schema>, options: { temperature: 0 }, messages: [{ role: 'user', content: <prompt>, images: [<base64>] }] }`.
- The answer's `message.content` is parsed as JSON and returned; not JSON → `invalid_response`.
- Maps failures to the codes of the table above. Honours the signal; an abort caused by the caller's signal is rethrown as an abort, an abort caused by the timeout is `provider_timeout`.
- No authentication header in 4a.

Configuration in 4a comes from two environment variables read once at start by the desktop host: `ASSETFORGE_VISION_BASE_URL` (default `http://127.0.0.1:11500`, the mock) and `ASSETFORGE_VISION_MODEL` (default `mock-vision`). The base URL must be `http:` or `https:` without user info, otherwise the default is used and a warning is logged. This is a seam, replaced by stored provider settings in 4b; it gets no UI. `.env.example` documents both.

### Mock provider

`docker/mock-provider/server.mjs`: plain Node, no dependencies, with a small type declaration beside it so tests can import it.

- `startMockProvider({ port = 11500, host = '127.0.0.1', delayMs = 0, failures = [] }) → { url, close(), requests }`; started with defaults from the environment (`MOCK_PORT`, `MOCK_HOST`, `MOCK_DELAY_MS`) when run directly.
- `GET /api/tags` lists the model `mock-vision`. `POST /api/chat` answers in Ollama's shape; the content is `{"tags":[…]}` with tags chosen deterministically from a fixed vocabulary by a hash of the first image's bytes: six subject/material/colour tags, one view tag, one style tag. A request without an image, or for another model, gets HTTP 400 / 404 as Ollama would.
- `failures` (in-process only) scripts the next answers: an HTTP status, `'invalid'` (content that is not the schema), or `'hang'` (never answers). Used by the tests.
- `compose.yaml` gets one service under profile `mock`: `node:22-alpine`, the file mounted read-only, `MOCK_HOST=0.0.0.0` inside the container, published as `127.0.0.1:11500:11500`, `MOCK_DELAY_MS` passed through (default 0). No volumes.

### Tags: manual wins

One rule replaces "a manual and an AI assignment of one tag coexist" for files and assets: **an owner carries a tag at most once.**

- Analysis never inserts an `ai` assignment for a tag the file carries manually (step 3 above).
- Adding a tag by hand to an owner that carries it as `ai` turns it into a manual one (the `ai` row is deleted in the same transaction). This is how the owner adopts a suggestion. The batch `files:addTagMany` does the same per file.
- Removing a tag by hand removes it whatever its origin. `files:removeTagMany` likewise; its comment "AI tags stay" and the tests that pin it change.
- The primary keys stay as they are; no migration for the tag tables. Search, filters and suggestions already treat both origins alike and keep doing so: an AI tag is found by `tagNames`, by full-text search and in suggestions.

### IPC

| Channel | Request | Response |
| --- | --- | --- |
| `analysis:enqueue` | `{ fileIds: FileIds }` (1–1000, distinct) | `{ enqueued: number, skipped: { fileId, reason }[] }` with reason `not_found`, `not_analysable` (not complete or not a previewable image) or `already_queued` |
| `jobs:list` | `{ limit, offset, status?: JobStatus }` | `{ items: JobView[], total }`, newest `created_at` first |
| `jobs:summary` | `{}` | `{ queued, running, waiting, failed, cancelled, succeeded, changes }` |
| `jobs:cancel` | `{ jobId }` | `{}`; a finished job is left alone |
| `jobs:cancelAll` | `{}` | `{ cancelled: number }` — every queued, waiting and running job |
| `jobs:retry` | `{ jobId }` | `{}`; `invalid_operation` unless the job is failed or cancelled, or its file already has an active job |
| `jobs:retryFailed` | `{}` | `{ retried: number }` — every failed or cancelled job whose file has no active job |
| `jobs:clearFinished` | `{}` | `{ removed: number }` — deletes succeeded, failed and cancelled rows |

`JobView`: `id`, `type`, `status`, `attempt`, `fileId`, `fileName` (original name, null when there is no file), `errorCode`, `errorMessage`, `createdAt`, `startedAt`, `finishedAt`, `runAfter`.

In the summary, in "active" and in every "waiting" of this document, waiting means `retry_wait` and `waiting_remote` together. `jobs:summary.changes` is a counter kept in memory by the host that rises whenever a job of the open workspace changes status. `analysis:enqueue` is not all-or-nothing: valid files are enqueued, the rest reported. All channels fail with `no_workspace_open` like the existing ones.

### Renderer

**AI tag colour.** Two new theme tokens `--color-ai` (a violet that is clearly apart from the cyan accent, at least 4.5:1 on `--color-bg` and `--color-surface`; proposed `#b9a3ff`) and a class constant `AI_CHIP` in `ui.ts` (border and text in that colour). `TagChip` uses it when `tag.origin === 'ai'` and the chip is neither a filter chip nor a matched chip; the chip then has the tooltip `AI tag` and its remove button the name `Remove AI tag <name>`. The image icon that marks image tags stays. Matched-tag chips in the asset gallery and project list carry no origin and stay as they are.

**Starting an analysis.**
- File menu (tile, table row, detail dialog "More"): `Analyse`, only for complete previewable images.
- `FileBrowser` selections: an `Analyse` button in the selection bar of the inbox and of the asset Files tab; disabled with the tooltip of the existing "none eligible" pattern when the selection holds no analysable image.
- After `analysis:enqueue` the existing `ResultStrip` shows `<n> queued, <m> skipped`, with the skipped files and their reason as its failure list. Nothing else happens on that screen.

**Job state in the shell.** While a workspace is open the shell polls `jobs:summary` every 2 s. The navigation gets a fourth entry `Jobs` with a count of active jobs (queued + running + waiting) beside it when that is above zero. When `changes` moved and the number of succeeded jobs rose since the last poll, mounted file lists reload (stale-while-loading, as `usePagedList` already does) and an open file detail dialog shows the fresh record, so new AI tags appear without navigating.

**Jobs screen.** A `Page` titled `Jobs` with the total as count. A table through `usePagedList` (endless, newest first): Job (`Analyse image`), File, Status, Attempt, Created, Error. A status filter in the filter bar. Row actions as icon buttons with tooltips: Cancel (queued, running, waiting), Retry (failed, cancelled). Page actions: `Cancel all`, `Retry failed`, `Clear finished`, each disabled when it has nothing to act on. The list reloads when `changes` moved. Status labels come from `labels.ts`; a waiting job shows `Retrying` with the time in its tooltip. The file name is plain text in 4a (no link).

### Error handling

- A job failure is data in the job row, not an IPC error. IPC errors of the new channels use the existing codes.
- `JobError` carries only a `JobErrorCode`; the stored message is the fixed text of that code.
- An unreachable provider: the job waits and retries twice, then fails with `provider_unreachable`. Everything else in the app is unaffected. With limit 1 a batch of many files fails one by one, each after about 35 s; "Cancel all" ends that at once. *(My call: no circuit breaker in 4a. If it annoys in use, 4b adds "stop the queue after N consecutive unreachable failures".)*
- A storage that is unreachable makes step 1 fail with `file_unavailable` (not retried); the existing storage banner is unaffected.

### Documentation

- `ReadMe.md`: §6 (only tags are stored; view and style as tags; Image2Prompt as a planned, unsaved function), §14 (profile `ai` not shipped; mock on port 11500; the two environment variables), §10 (no `JobAttempt` table yet; `file_analysis`), §17 (phase 4 split into 4a/4b), §18 (first vision model decided: `qwen3.5:9b`, changeable as a setting, arrives with 4b).
- `docs/backlog.md`: anything deferred during the build.

## Testing

- **Scheduler** (plain Vitest, in-memory `JobRepository` fake, fake clock): FIFO per class; limits hold with mixed classes; retry delays 5 s / 30 s and failure after the third run; non-retryable codes fail at once; cancel of queued, waiting and running jobs; a handler that ignores the abort still ends `cancelled`; `start` requeues or fails interrupted jobs per policy without consuming an attempt; `stop` puts running jobs back and makes no later repository call; an unknown type is never claimed; a thrown non-`JobError` becomes `internal_error`.
- **Repository** (Electron's Node): the migration; claim order; the partial unique index (second active job for one file is refused, a new one after the first finished is allowed); summary counts; `clearFinished`.
- **Analysis record**: written with the tags, replaced by a second analysis, untouched by a failed or cancelled run.
- **Tags**: analysis replaces earlier AI tags and leaves manual ones; a tag carried manually is not added as AI; adding by hand converts an AI tag; removing by hand removes an AI tag; the search index and the `tagNames` filter find AI tags.
- **Analysis steps**: every `file_unavailable` cause; a file moved during step 1 is read again from its new path; a changed checksum between step 1 and 3 writes nothing; an abort before step 3 writes nothing; tag cleaning (invalid, duplicate, more than 20, none left).
- **Adapter** against the in-process mock: request shape, success, each status class, invalid content, timeout, caller abort.
- **Media**: the JPEG job (size, orientation, alpha, limits, undecodable source → null), run against the Electron ABI like the existing Sharp tests.
- **Acceptance** (the phase criterion, desktop package, real database, in-process mock with a delay): enqueue a batch; cancel all while it runs; stop the scheduler and close the workspace mid-batch, reopen, and the remaining jobs finish; retry the cancelled ones; at the end every file has AI tags and every manual tag set before is still there and still manual.
- **Renderer** (jsdom): AI chip look, tooltip and names; Analyse in menu and selection bar including the disabled case and the result strip; navigation count; Jobs screen rows, filter, actions and their disabled states; reload of a file list when succeeded jobs rise. `theme.test.ts` keeps guarding literals.

## Left to the builder

- File and function names, the internal shape of the scheduler, how the host hooks the scheduler into workspace open/close.
- The exact prompt text and the mock's vocabulary.
- The shade of `--color-ai` within the stated contrast rule.
- Whether `changes` is delivered to screens through context or props.
