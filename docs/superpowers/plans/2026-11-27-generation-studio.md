# Generation Studio (Phase 5a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From one image file, queue image edits (source + prompt) and 2×/4× upscales against a Venice provider entry as persistent paid jobs. Each result lands at once in the source's asset with role `generated`, linked to its source by a generation record that survives trash and purge. A request with an unclear outcome is never sent again on its own.

**Architecture:** Provider entries get a `kind` (`ollama` | `venice`; `provider-settings.json` v3). A core port `ImageProvider` is implemented by `packages/providers/src/venice-image.ts`, built per entry by the gateway.

The generation record lives in its own tables (migration `0013`), independent of its job row. Job type `image.generate` (class `remote_api`, lane = entry id, payload `{ v: 1, generationId }`, `onInterrupted: 'fail'`) runs the request.

The scheduler gets a synchronous `settled` hook that the job repository calls inside the transaction ending a job. The generation's final state therefore commits together with the job's.

The handler imports the answer through `importStream` into the inbox, then links output and `succeeded` in one transaction, then moves the file into the source's asset.

**Tech Stack:** TypeScript, Zod, Drizzle + better-sqlite3, Electron (`safeStorage`), React, Vitest (+ jsdom), Node `fetch` / `FormData`.

**Spec:** `docs/superpowers/specs/2026-11-27-generation-studio-design.md`

## Global Constraints

### Repository and commits
- Everything in the repository is English. No attribution lines in commits. Implementers commit; they do not push.

### What implementers and tests must never touch
- Never launch the app.
- Never trigger "Open externally", "Show in folder" or a browser.
- Never touch Docker (no start, stop or remove).
- Never call the real Venice API or anything on port 11434.

### Test keys and the mock
- Tests start the mock in-process with `startMockProvider` from `docker/mock-provider/server.mjs`.
- Key literals are `test-key-not-real` and `test-key-not-real-2`. No real key goes in code, tests, logs or fixtures.

### Where the API key may go
- The API key never appears in IPC, logs, job rows, generation rows, the database or the settings file.
- A request carries the key only for its own entry, and only while that entry's origin equals the origin its adapter was built for.
- The Venice adapter never follows a redirect.

### Messages
- Messages are fixed strings only. Never put a URL, path, prompt or cause text in a message, a log line or a row.
- Provider failures are logged with the code, the HTTP status and the provider id.

### Job error codes (contracts)
- New codes and their messages, exact:
  - `provider_outcome_unknown` — `The provider may have processed this request; it was not repeated`
  - `provider_insufficient_balance` — `The provider account has no balance left`
  - `provider_content_refused` — `The provider refused this content`
- The existing job messages become neutral:
  - `provider_unreachable` — `The provider could not be reached`
  - `provider_timeout` — `The provider did not answer in time`
  - `provider_unavailable` — `The provider is temporarily unavailable`
  - `provider_rejected` — `The provider rejected the request`
  - `invalid_response` — `The provider returned an unusable answer`
  - `file_unavailable` — `The file is not available`
  - `provider_unauthorized` — `The provider refused the API key`
  - `provider_not_configured` — `No provider is configured`
  - `internal_error` is unchanged.

### `AssetForgeError` messages (exact)
- `validation_failed`:
  - `The prompt must have 1 to 8000 characters`
  - `The prompt is longer than this model allows`
  - `This model is not offered by the provider`
  - `This aspect ratio is not offered by the model`
  - `This resolution is not offered by the model`
  - `An image provider needs an https URL, or http on a loopback address`
- `invalid_operation`:
  - `This image cannot be sent to the provider` (spec, verbatim)
  - `Only a complete image outside the trash can be used`
  - `The upscaled image would be too large`
  - `Only a failed or cancelled generation can be retried`
  - `Only a failed or cancelled generation can be removed`
  - `The kind of a provider cannot be changed`
  - `This provider cannot generate images`
  - `This provider cannot analyse images`
- `not_found`:
  - `This generation does not exist`

### Values
| Name | Value |
| --- | --- |
| `IMAGE_GENERATE_JOB` | `'image.generate'` |
| `VENICE_DEFAULT_BASE_URL` | `'https://api.venice.ai/api/v1'` |
| `GENERATION_PROMPT_MAX` | `8000` |
| `IMAGE_INPUT_MIN_PIXELS` | `65_536` |
| `IMAGE_INPUT_MAX_PIXELS` | `33_177_600` |
| `IMAGE_INPUT_MAX_BYTES` | `25_000_000` |
| `IMAGE_ANSWER_MAX_BYTES` | `100 * 1024 ** 2` |
| `UPSCALE_MAX_PIXELS` | `100_000_000` (equals `DEFAULT_LIMITS.maxPixels` in `packages/media/src/generate.ts`) |
| `MAX_RECENT_PROMPTS` | `20` |
| `MAX_FILE_GENERATIONS` | `200` |
| `LIST_MODELS_TIMEOUT_MS` | `10_000` (existing, reused) |

### Package boundaries
- `core` and `contracts` stay free of Electron and concrete providers.
- `packages/jobs` gains no identifier mentioning providers or generations.

### UI rules
- No explanatory text in the layout; tooltips go through `title`.
- Buttons come only from `BUTTON` / `ICON_BUTTON` / `BUTTON_INLINE` / `ICON_BUTTON_INLINE` in `ui.ts`.
- Use tokens only; `test/theme.test.ts` guards this.
- Every label lives in `apps/desktop/src/renderer/src/labels.ts`.

### Author's calls (where the spec leaves a choice or is silent)

**Linking the result.** The handler runs `importStream` (inbox, complete and verified) → `GenerationRepository.succeed` (the output row and `succeeded`, one transaction guarded on `pending`) → `relocateFile` to the source's *current* asset with role `generated`.
- This is best effort: on failure the linked result stays in the inbox and the generation stays `succeeded`.
- A crash before `succeed` leaves an unlinked complete inbox file. Recovery then fails the job with `provider_outcome_unknown`.
- This reverses the spec's order "place → link" (spec line 91). Placing first would leave an *unlinked file in the asset*, while "Left to the builder" asks for at worst an unlinked file in the inbox.

**The transactional `settled` hook.**
- Signatures:
  - `JobHandler.settled?(job, outcome): void` (synchronous)
  - `JobHandler.interruptedCode?: JobErrorCode` (default `internal_error`)
  - `JobRepository.finish(id, r & { settled?: () => void })`
  - `JobRepository.cancelPending(r & { settled?: (job: Job) => void })`
- `finish` and `cancelPending` run the callback inside their transaction, and a throw rolls both back.
- `GenerationRepository.settle` is the one synchronous repository method; it changes only a `pending` row.
- A late `settled` after `succeed` is therefore a no-op.

**Core `cancelAllJobs` no longer bypasses the scheduler.** It calls `JobControl.cancelAll()`.
- A safety net `reconcileGenerations(s)` runs before every scheduler start.
- A `pending` generation whose job row is gone, or already finished, takes that job's outcome, or `provider_outcome_unknown` when the row is gone.

**Job rows.**
- A generation job has `fileId` = source file id, so the Jobs screen shows the source name.
- `dedupeKey` is `null`, so several runs per file are allowed.
- Trashing the source cancels its generation jobs through `JobControl.cancel`; the generation becomes `cancelled`.

**Result names.**
- An edit is named `<source base name> edit <n>.png`. The base name is the original name without its extension. `n` is the 1-based rank of this generation among the edit generations of the same input file, by (`created_at`, `id`).
- An upscale is named `<source base name> <scale>x.png`.
- Names need not be unique: stored paths are keyed by the file id, so a clash is harmless and allowed.

**Model lists.** Image models get their own types: `ImageModelSchema` and `ListImageModelsResultSchema`.

**"Used last."** `provider-settings.json` v3 keeps `lastUsed: { vision, image }`. `ProviderList` keeps `lastUsedId` (vision) and gains `lastUsedImageId`.

**`generations:start` result.**
- The response is `{ ok: true, generation } | { ok: false, code: JobErrorCode }`, like `analysis:describe`.
- A provider that cannot list its models is a result, not an `AssetForgeError`, because those codes are not IPC error codes (`packages/contracts/src/errors.ts:3-28`).
- Validation refusals stay `AssetForgeError`.

**Image bytes.**
- The image is held in main-process memory (≤ 25 MB) as `{ data: Uint8Array; mimeType }` and is never sent over IPC.
- The rendition is the cached lossless `full` preview (`PreviewService.get({ size: 'full' })`).
- The checksum check compares the file row's `sha256` with the input row; originals are immutable, so the file is not rehashed.

**Import failures.**
- If the import fails while the answer stream errored (over the cap, cut off), the code is `provider_outcome_unknown`.
- Any other import failure (storage) is `internal_error`.
- Both are terminal.

**Retry.**
- `JobRepository.retry` gains `excludeTypes?: readonly string[]`; `retryFailedJobs` passes `[IMAGE_GENERATE_JOB]`.
- `jobs:retry` on a generation job delegates to `retryGeneration` with the generation found by `job_id`.
- `retryGeneration` requires the entry to still exist, else `ProviderNotConfiguredError`.

**Pause.**
- The pause gate's `FATAL` set gains `provider_insufficient_balance`.
- `JobHost.paused()` covers `local_gpu` and `remote_api`, and `resume(lane)` resumes the lane in both.
- `PausedProviderSchema` gains `kind`, derived from the class: `remote_api` → `venice`. The banner hides Move jobs for `venice`.

**Provider store.**
- `ProviderStore.resolve(id, kind = 'ollama')` and `first(kind = 'ollama')` keep today's callers unchanged.
- Given the wrong kind, `resolve` throws `This provider cannot analyse images` or `This provider cannot generate images`.
- The Move jobs dialog offers only `ollama` targets. Deleting a `venice` entry with active generation jobs is refused like an `ollama` one.

**Safe mode.** The choice is remembered in `localStorage` key `assetforge.studio.safeMode` (try/catch; default `true`).

**Opening the studio.** The studio is a dialog mounted once by a `StudioProvider` (`studio-context.tsx`) beside `JobsProvider`. Entry points call `useStudio().open(file)`.

### Waves
Task 1 changes contracts and ports, so the repository-wide typecheck is red until the checkpoints. Each task's gate is its own test files plus `tsc` clean in the files it owns. Tasks of one wave run in parallel in worktrees.

| Wave | Tasks | Gate |
| --- | --- | --- |
| 1 | Task 1 | — |
| 2 | Tasks 2, 3, 4, 5, 6, 7 | **Checkpoint A** after 2–5: tests and typecheck of `contracts`, `core`, `persistence`, `jobs`, `providers` green |
| 3 | Tasks 8, 9, 10 | **Checkpoint B**: `pnpm typecheck`, `pnpm test`, `pnpm --filter @assetforge/desktop build` green |
| 4 | Task 11 | — |

### Commands
- `pnpm --filter @assetforge/<package> test <file>` (no `--`), `pnpm --filter @assetforge/<package> typecheck`, `pnpm test`, `pnpm typecheck`.
- `pnpm --filter @assetforge/persistence db:generate` generates the migration.
- Known flaky test (re-run once): `inbox.test.tsx > filters and scroll offset survive navigation`.

## Review Focus

1. **Never charged twice by the app.** None of these is ever requeued:
   - a running generation job on stop (workspace switch, quit);
   - one found `running` on recovery;
   - a timeout, a 500 or a cut answer;
   - `jobs:retryFailed`.

   Only `provider_unreachable` and `provider_unavailable` are retried automatically. Tests in Tasks 3, 5 and 8.
2. **Late cancel after the result was committed.** A cancel or stop arriving after `succeed` leaves the generation `succeeded` with its output, even though the job row ends `cancelled`. Tests in Tasks 2, 3 and 5.
3. **Crash between import and link.** A complete inbox file without an output row, plus a generation failed `provider_outcome_unknown` after recovery. Never an output row pointing at a pending or failed file. Tests in Task 5.
4. **The key.**
   - Never in the multipart body, a log line, a job or generation row, or an IPC answer.
   - Never sent to another origin: a redirect is not followed, and an entry whose URL changed gets a new adapter.

   Tests in Tasks 4, 6 and 8.
5. **Purge and trash.** Purging the source or the result keeps both generation rows with `fileId: null`, the name and the checksum. A purge deletes the source's job rows, after which the generation still has its final status (`reconcileGenerations`). The trash only sets `trashed: true`. Tests in Tasks 2 and 5.

---

### Task 1: Contracts, ports, in-memory repositories, labels and the studio stub

**Files:**
- Create:
  - `packages/contracts/src/generations.ts`
  - `packages/core/test/memory-generations.ts` and `packages/core/test/memory-generations.test.ts`
  - `apps/desktop/src/renderer/src/components/GenerationStudio.tsx` (stub: renders `null`, final props)
- Modify (contracts):
  - `packages/contracts/src/provider-ref.ts`, `settings.ts`, `jobs.ts`, `ipc.ts`, `index.ts`
  - `packages/contracts/test/` (jobs, settings, IPC schema tests)
- Modify (core):
  - `packages/core/src/jobs.ts`, `ports.ts`, `index.ts`
  - `packages/core/test/memory-jobs.ts`, `memory-jobs.test.ts`, `fakes.ts` (`WorkspaceDatabase.generations`)
- Modify (desktop):
  - `apps/desktop/src/renderer/src/labels.ts`
  - `apps/desktop/test/renderer/fake-api.ts` (default answers for the new channels)
- String-only updates of the neutral job messages:
  - `apps/desktop/test/analysis-acceptance.test.ts`
  - `apps/desktop/test/renderer/analysis-result-dialog.test.tsx`
  - `apps/desktop/test/renderer/jobs-screen.test.tsx`
  - `packages/jobs/test/scheduler.test.ts`

**Interfaces — produces (contracts):**
- **`provider-ref.ts`**
  - `ProviderKindSchema = z.enum(['ollama', 'venice'])`
  - `VENICE_DEFAULT_BASE_URL`
- **`settings.ts`**
  - `ProviderViewSchema` gains `kind: ProviderKindSchema` and `editModel: ModelNameSchema.nullable()`. A `venice` view has `taggingModel` and `promptModel` null; an `ollama` view has `editModel` null.
  - `ProviderListSchema` gains `lastUsedImageId: ProviderIdSchema.nullable()`.
  - `SaveProviderSchema` gains `kind: ProviderKindSchema.optional()` and `editModel: ModelNameSchema.nullable().optional()`.
  - `ImageModelSchema { name: ModelNameSchema, aspectRatios: z.array(z.string().min(1).max(20)).max(50).nullable(), resolutions: <same>.nullable(), defaultResolution: z.string().min(1).max(20).nullable(), promptCharacterLimit: z.number().int().positive().nullable(), price: z.string().max(200).nullable() }`
  - `ListImageModelsResultSchema = { ok: true, models: z.array(ImageModelSchema).max(200) } | { ok: false, code: JobErrorCodeSchema }`
- **`jobs.ts`**
  - The three new codes; the messages of Global Constraints; `RETRYABLE` unchanged.
  - `IMAGE_GENERATE_JOB`
  - `ImageGeneratePayloadSchema = z.object({ v: z.literal(1), generationId: z.uuid() })`
  - `PausedProviderSchema` gains `kind: ProviderKindSchema`.
- **`generations.ts`**
  - The constants of Global Constraints.
  - `GenerationKindSchema = z.enum(['edit', 'upscale'])`
  - `GenerationStatusSchema = z.enum(['pending', 'succeeded', 'failed', 'cancelled'])`
  - `UpscaleScaleSchema = z.union([z.literal(2), z.literal(4)])`
  - `EditParametersSchema { v: z.literal(1), aspectRatio: z.string().nullable(), resolution: z.string().nullable(), safeMode: z.boolean() }`
  - `UpscaleParametersSchema { v: z.literal(1), scale: UpscaleScaleSchema }`
  - `GenerationParametersSchema` (union of the two)
  - `GenerationFileSchema { fileId: IdSchema.nullable(), name: z.string(), sha256: z.string(), trashed: z.boolean() }`
  - `GenerationSchema { id, kind, status, errorCode: JobErrorCodeSchema.nullable(), providerId: ProviderIdSchema, providerName: z.string(), providerKind: ProviderKindSchema, model: ModelNameSchema.nullable(), prompt: z.string().nullable(), parameters: GenerationParametersSchema, jobId: z.uuid().nullable(), jobStatus: JobStatusSchema.nullable(), createdAt: z.string(), finishedAt: z.string().nullable(), inputs: z.array(GenerationFileSchema), outputs: z.array(GenerationFileSchema) }`
  - `StartGenerationSchema`, a discriminated union on `kind`:
    - `{ kind: 'edit', fileId: IdSchema, providerId: ProviderIdSchema.optional(), model: ModelNameSchema, prompt: z.string().max(20000), aspectRatio: z.string().min(1).max(20).optional(), resolution: z.string().min(1).max(20).optional(), safeMode: z.boolean() }`
    - `{ kind: 'upscale', fileId, providerId?, scale: UpscaleScaleSchema }`
  - `StartGenerationResultSchema = { ok: true, generation } | { ok: false, code: JobErrorCodeSchema }`
- **`ipc.ts`**

  | Channel | Request | Response |
  | --- | --- | --- |
  | `providers:listImageModels` | `{ providerId: ProviderIdSchema, refresh: z.boolean().optional() }` | `ListImageModelsResultSchema` |
  | `generations:start` | `StartGenerationSchema` | `StartGenerationResultSchema` |
  | `generations:forFile` | `{ fileId: IdSchema }` | `{ madeBy: GenerationSchema.nullable(), results: z.array(GenerationSchema).max(200) }` |
  | `generations:retry` | `{ generationId: IdSchema }` | `GenerationSchema` |
  | `generations:remove` | `{ generationId: IdSchema }` | `z.object({})` |
  | `generations:recentPrompts` | `{}` | `{ prompts: z.array(z.string()).max(20) }` |

**Interfaces — produces (core):**
- **`jobs.ts`**
  - `JobOutcome = { status: 'succeeded' } | { status: 'failed'; errorCode: JobErrorCode } | { status: 'cancelled' }`
  - `JobHandler` gains:
    - `interruptedCode?: JobErrorCode`
    - `settled?(job: Job, outcome: JobOutcome): void`, documented as: runs inside the transaction ending the job; synchronous; a throw rolls the end back.
  - `JobControl` gains `cancelAll(): Promise<number>` (cancels every pending job and aborts every running one; answers how many).
- **`ports.ts`**
  - `JobRepository` changes:
    - `finish(id, r: { status; errorCode; now; settled?: () => void })`
    - `cancelPending(r: { id?; now; settled?: (job: Job) => void })`
    - `retry(r: { id?; now; excludeTypes?: readonly string[] })`
  - `GenerationFileRef { fileId: string; sha256: string; originalName: string }`
  - `NewGeneration { id; kind; providerId; providerName; providerKind; model: string | null; prompt: string | null; parameters: GenerationParameters; createdAt }`
  - `GenerationRow` = the `Generation` DTO.
  - `GenerationRepository`:
    ```ts
    create(r: { generation: NewGeneration; input: GenerationFileRef; job: NewJob }): Promise<void>; // generation, input row and job in one transaction; job_id set
    get(id: string): Promise<GenerationRow | null>;
    byJob(jobId: string): Promise<GenerationRow | null>;
    madeBy(fileId: string): Promise<GenerationRow | null>;
    resultsOf(fileId: string, limit: number): Promise<GenerationRow[]>; // newest first
    editRank(id: string): Promise<number>;
    succeed(r: { id: string; output: GenerationFileRef; now: string }): Promise<boolean>; // guarded `pending`
    settle(r: { id: string; outcome: JobOutcome; now: string }): boolean; // SYNC, guarded `pending`; a `succeeded` outcome on a still pending row becomes failed `internal_error`
    requeue(r: { id: string; job: NewJob; now: string }): Promise<boolean>; // guarded failed|cancelled; inserts the job, status pending, error/finished cleared, job_id replaced; one transaction
    remove(id: string): Promise<boolean>; // guarded failed|cancelled
    recentPrompts(limit: number): Promise<string[]>; // distinct edit prompts, newest use first
    reconcile(now: string): Promise<number>;
    ```
  - `WorkspaceDatabase.generations: GenerationRepository`
  - `ImageInput { data: Uint8Array; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }`
  - `ImageProvider`:
    ```ts
    listEditModels(signal: AbortSignal): Promise<ImageModel[]>;
    editImage(r: { image: ImageInput; model: string; prompt: string; aspectRatio: string | null; resolution: string | null; safeMode: boolean; signal: AbortSignal }): Promise<{ stream: Readable; mimeType: string }>;
    upscaleImage(r: { image: ImageInput; scale: 2 | 4; signal: AbortSignal }): Promise<{ stream: Readable; mimeType: string }>;
    ```
    Failures are `JobError` with the codes of the outcome table.
  - `ImageProviderDirectory`:
    ```ts
    resolve(id: string | undefined): { id: string; name: string } | null; // throws as ProviderStore.resolve with kind 'venice'
    exists(id: string): boolean;
    adapter(id: string): ImageProvider | null;
    models(id: string, signal: AbortSignal): Promise<ListImageModelsResult>; // cached, else loaded within the 10 s bound
    markUsed(id: string): void;
    ```
  - `GenerationImageSource.read(file: { absolutePath: string; mimeType: string; sha256: string; sizeBytes: number }, signal: AbortSignal): Promise<ImageInput | null>`. It answers the original when it is JPEG, PNG or WebP and ≤ `IMAGE_INPUT_MAX_BYTES`, else the lossless rendition when it is ≤ that size, else `null`.
- The in-memory `GenerationRepository` and the job repository extensions in `packages/core/test/`.

**Interfaces — produces (renderer):**
- **`labels.ts`**
  - Provider kinds:
    - `PROVIDER_KIND_LABELS: Record<ProviderKind, string> = { ollama: 'Ollama', venice: 'Venice' }`
    - `PROVIDER_KIND_LABEL = 'Kind'`
    - `EDIT_MODEL_LABEL = 'Edit model'`
    - `PROVIDER_STATE_LABELS` gains `no_edit_model: 'no edit model'`
  - Studio entry points and the dialog's own title:
    - `GENERATE_LABEL = 'Generate from image'`
    - `GENERATE_TITLE = 'Edit this image with an image model'`
    - `UPSCALE_LABEL = 'Upscale'`
    - `UPSCALE_SCALE_LABELS = { 2: '2×', 4: '4×' }`
    - `NO_IMAGE_PROVIDER_TITLE = 'Add an image provider in Settings first'`
    - `STUDIO_TITLE = 'Studio'`
  - Form fields:
    - `PROMPT_LABEL = 'Prompt'`
    - `RECENT_PROMPTS_LABEL = 'Recent'`
    - `ASPECT_LABEL = 'Aspect'`
    - `RESOLUTION_LABEL = 'Resolution'`
    - `SAFE_MODE_LABEL = 'Safe mode'`
    - `GENERATE_BUTTON = 'Generate'`
  - Results:
    - `RESULTS_LABEL = 'Results'`
    - `USE_SETTINGS_LABEL = 'Use settings'`
    - `OPEN_LABEL = 'Open'`
    - `RETRY_LABEL = 'Retry'`
    - `REMOVE_LABEL = 'Remove'`
    - `TRASHED_MARK = 'In the trash'`
    - `DELETED_MARK = 'Deleted'`
    - `GENERATION_STATUS_LABELS: Record<GenerationStatus | 'running', string>`
  - Details column:
    - `GENERATED_FROM_LABEL = 'Generated from'`
    - `COPY_PROMPT_TITLE = 'Copy prompt'`
    - `PARAMETERS_LABEL = 'Parameters'`
  - Jobs screen: `JOB_TYPE_LABELS: Record<string, string> = { 'vision.analyze_file': 'Analysis', 'image.generate': 'Generation' }`

  Reuse existing labels where one already has the wording.
- `GenerationStudio.tsx`: `export interface GenerationStudioProps { file: FileRecord; onClose(): void; onOpenFile(fileId: string): void }`, with `export function GenerationStudio(props): JSX.Element | null` returning `null`.

**Steps:**
- [ ] **Step 1: Write failing contract tests.**
  - `StartGenerationSchema`:
    - accepts edit without `providerId`, `aspectRatio` and `resolution`;
    - refuses `scale: 3`;
    - refuses an edit without `safeMode`.
  - `GenerationSchema` parses with `fileId: null` in `outputs` and with `jobStatus: null`.
  - Every code in `JobErrorCodeSchema` has a message, and none contains `analysis`.
  - `isRetryableJobError` is false for the three new codes.
  - `ProviderViewSchema` refuses a missing `kind`.
  - `PausedProviderSchema` requires `kind`.
  - `ListImageModelsResultSchema` accepts all-null constraints.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/contracts test` — FAIL. Implement; run again — PASS; `typecheck` clean.
- [ ] **Step 3: Write failing in-memory tests** (`memory-generations.test.ts`, `memory-jobs.test.ts`):
  - `settle` after `succeed` answers `false` and changes nothing.
  - `finish` with `settled` runs it once, only when the row changed.
  - `cancelPending` calls `settled` per cancelled job.
  - `retry({ excludeTypes: ['image.generate'] })` skips those rows.
  - `requeue` refuses a `succeeded` row.
  - `remove` refuses `pending`.
  - `editRank` orders by (`createdAt`, `id`).
  - `reconcile` takes the finished job's outcome, and `provider_outcome_unknown` for a missing job.
- [ ] **Step 4: Implement** the core types, ports, in-memory repositories, labels, `fake-api.ts` defaults, the stub and the four string-only test updates. Run the core tests above — PASS. The core typecheck stays red in use cases until Task 5.
- [ ] **Step 5: Commit** `feat: contracts and ports for the generation studio`

---

### Task 2: Persistence — migration 0013 and the generation repository

**Files:**
- Create:
  - `packages/persistence/migrations/0013_*.sql` (generated)
  - `packages/persistence/src/generation-repository.ts`
  - `packages/persistence/test/migration-0013.test.ts`, `generation-repository.test.ts`
- Modify:
  - `packages/persistence/src/schema.ts`, `job-repository.ts`, `open-database.ts`, `index.ts`
  - `packages/persistence/test/job-repository.test.ts`

**Interfaces:**
- Consumes: Task 1 ports.
- Produces:
  - Table `generation`:
    - columns: `id` pk, `kind`, `status`, `error_code`, `provider_id`, `provider_name`, `provider_kind`, `model`, `prompt`, `parameters` (JSON text), `job_id` (no FK), `created_at`, `finished_at`;
    - CHECKs on `kind`, `status` and `provider_kind`;
    - indexes `generation_job_id_idx` and `generation_created_at_idx`.
  - Tables `generation_input` and `generation_output`:
    - columns: `generation_id` (FK cascade), `position` int, `file_id` (FK `file.id` `on delete set null`), `sha256`, `original_name`;
    - pk (`generation_id`, `position`);
    - index on `file_id`.
  - `createGenerationRepository(db)`. Rows join `file` for `trashed` (`deleted_at is not null`) and `job` for `jobStatus`. `parameters` is parsed with `GenerationParametersSchema`; a row that fails to parse throws.
  - `JobRepository` changes:
    - the `settled` callbacks run inside the existing transactions;
    - `excludeTypes` in `retry`;
    - `list` rows of `image.generate` take `providerName` and `model` from `generation` joined on `job_id`.

**Steps:**
- [ ] **Step 1: Write the failing migration test** following `migration-0012.test.ts`. A database at `0012` with a file and a job, migrated: the three tables and indexes exist, and the old rows are untouched.
- [ ] **Step 2: Write failing repository tests:**
  - `create` writes the generation, the input row and the job atomically, and a duplicate job id leaves no generation.
  - `succeed` then `settle({ outcome: cancelled })` leaves `succeeded` with its output.
  - Inside `jobs.finish(..., settled)`, a `settle` that throws rolls the job back to `running`.
  - Purging the result file (`files.purge`) leaves the output with `fileId: null`, the name and the sha.
  - Purging the source deletes its job rows, keeps the input row, and `reconcile` sets a pending generation to `provider_outcome_unknown`.
  - Trashing marks `trashed: true`.
  - `resultsOf` is newest first and capped at its limit; `madeBy` answers the generation of an output.
  - `recentPrompts(20)` is distinct and skips upscales.
  - `requeue` replaces `job_id` and clears `error_code` and `finished_at`.
  - `remove` cascades the input and output rows.
  - `retry({ excludeTypes })` and `cancelPending({ settled })` work against SQLite.
- [ ] **Step 3: Run** `pnpm --filter @assetforge/persistence test generation-repository` — FAIL.
- [ ] **Step 4: Implement.**
  - Add the tables in `schema.ts` and run `db:generate`.
  - `settle` uses the synchronous drizzle calls (`.run()`) so it can run inside the job repository's `db.transaction`. It is the same connection, so no nested transaction is needed.
  - Wire `generations` into `openWorkspaceDatabase`.
- [ ] **Step 5: Run** `pnpm --filter @assetforge/persistence test` and `typecheck` — PASS.
- [ ] **Step 6: Commit** `feat: generation tables and repository`

---

### Task 3: Scheduler — settled hook, fail on stop, cancel all, balance pause

**Files:**
- Modify: `packages/jobs/src/scheduler.ts`, `pause-gate.ts`; `packages/jobs/test/scheduler.test.ts`, `pause-gate.test.ts`

**Interfaces:**
- Consumes: `JobHandler.settled`, `interruptedCode`, `JobControl.cancelAll`, the repository callbacks.
- Produces:
  - `createScheduler` keeps its signature; the `Scheduler` interface includes `cancelAll`.
  - `settled(job, outcome)` is passed to `finish` on success, on final failure (not retryable, or the last attempt), on cancel of a running job, on fail-on-stop and on recovery. It is passed to `cancelPending` for queued cancels and for `cancelAll`.
  - It is not called on `scheduleRetry` or `release`.
  - When stopping, a handler with `onInterrupted: 'fail'` gets `finish(failed, interruptedCode ?? 'internal_error')` instead of `release`. `recover()` uses the same code.
  - `FATAL` gains `provider_insufficient_balance`.

**Steps:**
- [ ] **Step 1: Write failing tests** (in-memory repository, fake timers):
  - A `fail` handler running at `stop()` ends `failed` with its `interruptedCode`, `settled` is called once, and it is not requeued on the next `start()`.
  - A `requeue` handler running at stop is still released (existing behaviour).
  - Recovery of a `running` `fail` job uses `interruptedCode`, and `settled` gets `{ status: 'failed', errorCode }`.
  - A retryable failure on attempts 1 and 2 does not call `settled`; attempt 3 does.
  - Cancel while queued and while running each call `settled({ status: 'cancelled' })` once.
  - A handler resolving after `cancel` was requested but after it settled: `settled` gets `cancelled`, and the generation guard is exercised in Task 5.
  - `cancelAll` answers pending + running and settles each.
  - Gate: one `provider_insufficient_balance` on (`remote_api`, `a`) pauses at once; `provider_outcome_unknown` and `provider_content_refused` reset the count.
  - Two `remote_api` jobs in lane `a` run at once with limit 2, and a third waits.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/jobs test` — FAIL.
- [ ] **Step 3: Implement.** Dispatch `settled` by `handlers[job.type]`; a missing hook passes no callback.
- [ ] **Step 4: Run** the package tests and typecheck — PASS.
- [ ] **Step 5: Commit** `feat: settled hook and fail-on-stop in the scheduler`

---

### Task 4: Mock provider Venice endpoints and the Venice adapter

**Files:**
- Create: `packages/providers/src/venice-image.ts`, `packages/providers/test/venice-image.test.ts`
- Modify: `packages/providers/src/index.ts`, `docker/mock-provider/server.mjs` (plus its README if it lists endpoints), `packages/providers/test/mock-provider.test.ts`

**Interfaces:**
- Consumes: `ImageProvider`, `ImageModel`, `JobError`, `IMAGE_ANSWER_MAX_BYTES`.
- Produces — mock:
  - Endpoints under `/api/v1`, all behind `MOCK_API_KEY` as today:
    - `GET /models?type=inpaint` with `mock-edit` (aspect ratios `1:1`, `16:9`, `9:16`; resolutions `1K`, `2K`, `4K`; default `1K`; `promptCharacterLimit: 1500`; a pricing object) and `mock-edit-basic` (no constraints, no pricing);
    - `POST /image/edit` and `POST /image/upscale` (multipart).
  - The answer is a deterministic PNG built with `node:zlib`. For an edit the long edge is 64/128/256 px for 1K/2K/4K, shaped by the aspect ratio. For an upscale it is the input PNG's IHDR size × `scale` (32 × 32 base for other formats).
  - Exported trigger prompts:
    - `MOCK_PROMPT_NO_BALANCE = 'mock:402'`
    - `MOCK_PROMPT_VIOLATION = 'mock:422'` (also sets `x-venice-is-content-violation: true`)
    - `MOCK_PROMPT_BUSY = 'mock:429'`
    - `MOCK_PROMPT_FAIL = 'mock:500'`
    - `MOCK_PROMPT_SLOW = 'mock:slow'` (answers after 30 s or on close)
    - `MOCK_PROMPT_VIOLATION_OK = 'mock:violation-200'` (200 with the header)
  - The handle gains `imageRequests: { path: string; authorization: string | null; fields: Record<string, string>; fileBytes: number }[]`.
- Produces — adapter: `createVeniceImage(o: { baseUrl: string; timeoutMs: number; apiKey: () => string | null; onFailure?: (code: JobErrorCode, status: number | null) => void; fetch?: typeof fetch }): ImageProvider`.
  - The multipart body has `image` (Blob with the input's type), `prompt`, `model`, `aspect_ratio` / `resolution` when not null, `output_format: 'png'` and `safe_mode` for an edit; `image` and `scale` for an upscale.
  - `redirect: 'manual'`; a 3xx is `provider_rejected`.
  - The answer is streamed through a counting `Transform` that errors with `JobError('provider_outcome_unknown')` past the cap.
  - `listEditModels` is bounded by `min(timeoutMs, LIST_MODELS_TIMEOUT_MS)`. A list timeout is `provider_timeout`, and malformed constraints become `null`. `price` is the display text of the pricing USD value, else `null`.
  - Error mapping for edit and upscale:
    - `ECONNREFUSED`, `ENOTFOUND` or `EAI_AGAIN` in the cause chain → `provider_unreachable`
    - any other fetch failure, a timeout, a 500 or a cut stream → `provider_outcome_unknown`
    - 401 or 403 → `provider_unauthorized`
    - 402 → `provider_insufficient_balance`
    - 422, or the header on any status → `provider_content_refused`
    - 400 or 413 → `provider_rejected`
    - 429 or 503 → `provider_unavailable`
    - any other 4xx → `provider_rejected`

**Steps:**
- [ ] **Step 1: Write failing mock tests:**
  - both models are listed;
  - an edit at `16:9`/`2K` answers a PNG of 128 × 72;
  - an upscale ×4 of a 64 × 64 PNG answers 256 × 256;
  - each trigger prompt answers its status;
  - a wrong key answers 401.
- [ ] **Step 2: Write failing adapter tests** against the in-process mock:
  - request shape (fields, `output_format`, file size) and `Authorization: Bearer test-key-not-real`;
  - the body never contains the key;
  - a redirect to a second mock on another port never receives the header;
  - every row of the error mapping (unreachable via a closed port; outcome-unknown via `timeoutMs: 100` on `mock:slow`);
  - a 200 with the violation header;
  - the cap with an injected `fetch` streaming 101 MiB;
  - `listEditModels` maps both models, the bound gives `provider_timeout`;
  - `onFailure` gets only the code and the status.
- [ ] **Step 3: Run** `pnpm --filter @assetforge/providers test venice-image` — FAIL.
- [ ] **Step 4: Implement.** The Venice docs cannot be re-checked here (no network), so leave a single line in the adapter header noting the 2026-11-26 shape it follows.
- [ ] **Step 5: Run** the package tests and typecheck — PASS.
- [ ] **Step 6: Commit** `feat: Venice image adapter and mock endpoints`

---

### Task 5: Core — generation use cases and the `image.generate` handler

**Files:**
- Create: `packages/core/src/generations.ts`, `packages/core/src/generation-handler.ts`; tests `packages/core/test/generations.test.ts`, `generation-handler.test.ts`
- Modify: `packages/core/src/jobs.ts` (use-case bodies), `index.ts`; `packages/core/test/jobs.test.ts`

**Interfaces:**
- Consumes: Task 1; `importStream`, `relocateFile`, `measureFile`, `isPreviewable`.
- Produces:
  ```ts
  interface GenerationDeps { providers: ImageProviderDirectory; control: JobControl }
  startGeneration(s, d: GenerationDeps, input: StartGeneration): Promise<StartGenerationResult>
  listGenerationsForFile(s, fileId): Promise<{ madeBy: Generation | null; results: Generation[] }>
  retryGeneration(s, d: GenerationDeps, generationId): Promise<Generation>
  removeGeneration(s, generationId): Promise<void>
  recentGenerationPrompts(s): Promise<string[]>
  reconcileGenerations(s): Promise<number>
  generationNames: { edit(sourceName: string, n: number): string; upscale(sourceName: string, scale: 2 | 4): string }
  createImageGenerateHandler(deps: { session; providers: ImageProviderDirectory; images: GenerationImageSource }): JobHandler
  ```
  - `startGeneration` checks, in order:
    1. The file exists (else `not_found`).
    2. The file is complete, outside the trash and `isPreviewable`.
    3. The dimensions, measured on demand, lie within the pixel bounds.
    4. The entry is resolved: a given id of another kind is refused, and no entry at all is `ProviderNotConfiguredError`.
    5. For an edit, the trimmed prompt is 1–8000 characters; then the model list (`{ ok: false, code }` is returned as is); then the model, the prompt limit, the aspect ratio and the resolution.
    6. For an upscale, the result's pixels against `UPSCALE_MAX_PIXELS`.

    It then creates the generation, the input row and the job (`type: IMAGE_GENERATE_JOB`, `resourceClass: 'remote_api'`, `fileId`, `lane: entry.id`, payload v1, `dedupeKey: null`), calls `markUsed` and `control.wake()`, and answers `{ ok: true, generation }`.
  - Handler (`resourceClass: 'remote_api'`, `onInterrupted: 'fail'`, `interruptedCode: 'provider_outcome_unknown'`). It loads the generation; when it is missing or not `pending` it is `internal_error`. Then:
    1. The input must still be complete, untrashed and of the same sha, else `file_unavailable`. `images.read` answering `null` is `file_unavailable`.
    2. No adapter is `provider_not_configured`.
    3. Edit or upscale.
    4. `importStream` with the name from `generationNames`.
    5. `succeed`.
    6. A best-effort `relocateFile(source's current assetId, 'generated')`.

    `settled` calls `generations.settle`.
  - `cancelAllJobs` uses `control.cancelAll()`.
  - `retryFailedJobs` passes `excludeTypes: [IMAGE_GENERATE_JOB]`.

**Steps:**
- [ ] **Step 1: Write failing tests** (in-memory repositories, a fake `ImageProvider` and `GenerationImageSource`):
  - **Start refusals and choices:**
    - pending, failed and trashed files; an SVG; 200 × 200 pixels;
    - a prompt that is blank or of 8001 characters; 1501 characters for `mock-edit`;
    - an unknown model, aspect ratio or resolution;
    - a model without constraints accepts any aspect ratio;
    - a models result `{ ok: false, code: 'provider_unreachable' }` is answered and nothing is queued;
    - an `ollama` id; no entry;
    - without an id, the entry used last;
    - an upscale ×4 of 6000 × 5000 → `The upscaled image would be too large`.
  - **Handler, one test per outcome row:**
    - success: the file is named `face edit 1.png`, the second one `face edit 2.png`, an upscale `face 4x.png`; it lands in the source's asset with role `generated`, or in the inbox when the source has none;
    - the source moved to another asset meanwhile → the result goes to the new one;
    - `relocateFile` throwing leaves the result linked in the inbox;
    - a checksum mismatch and a trashed input are `file_unavailable`;
    - content refused stores no file;
    - a stream error during import is `provider_outcome_unknown` and the generation stays without output.
  - **Crash between import and link:** simulate by a `succeed` that throws once. The inbox has the complete file, there is no output row, and after recovery (`settled` with the interrupted code) the generation is `failed` `provider_outcome_unknown`.
  - **Late cancel:** `settled({ status: 'cancelled' })` after `succeed` leaves `succeeded`.
  - **`retryGeneration`:**
    - reuses the id, works after `clearFinishedJobs`, and gives a new `jobId`;
    - refuses `succeeded` and `pending`;
    - refuses a trashed input (`file_unavailable` as `InvalidOperationError` with `Only a complete image outside the trash can be used`);
    - refuses a deleted entry.
  - `removeGeneration` refuses `succeeded`.
  - `retryFailedJobs` skips a failed generation job and requeues a failed analysis job.
  - `cancelAllJobs` delegates to `cancelAll`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/core test generation` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @assetforge/core test` and `typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: generation use cases and job handler`

---

### Task 6: Main — provider store v3, gateway image adapters, `providers:listImageModels`

**Files:**
- Modify: `apps/desktop/src/main/provider-store.ts`, `provider-gateway.ts`, `provider-handlers.ts`; `apps/desktop/test/provider-store.test.ts`, `provider-gateway.test.ts`, `provider-ipc.test.ts`
- Untouched here: `composition.ts`, `ipc.ts`, `job-host.ts`, `job-handlers.ts` (Task 8)

**Interfaces:**
- Consumes: Task 1. The adapter factory is typed structurally as `ImageAdapterFactory = (o: { baseUrl; timeoutMs; apiKey; onFailure }) => ImageProvider`, which is what `createVeniceImage` of Task 4 accepts.
- Produces:
  - **`ProviderEntry`** gains `kind` and `editModel`.
  - **File format.** `provider-settings.json` v3: `{ version: 3, providers: [...], lastUsed: { vision, image }, adoptLegacyKey }`. Version 2 is upgraded in memory to `kind: 'ollama'`, `editModel: null` and `lastUsed.vision = lastUsedId`, and written atomically on the first write.
  - **Save rules.**
    - A create without `kind` makes an `ollama` entry.
    - A changed kind is refused with `The kind of a provider cannot be changed`.
    - A `venice` URL must be `https`, or `http` on `localhost`, `127.0.0.0/8` or `::1`, else the new validation message.
    - `venice` ignores tagging and prompt models (stored null); `ollama` stores `editModel` null.
    - The limit of 10 counts both kinds.
    - The environment mode lists only the environment `ollama` entry, and `lastUsedImageId` is null.
  - **Store API.**
    - `resolve(id, kind = 'ollama')` and `first(kind = 'ollama')`.
    - `markUsed(id)` writes the slot of the entry's kind.
  - **Gateway.**
    - `image(id: string | null): ImageProvider | null`, which is null for missing and non-`venice` entries. `vision(id)` is null for `venice`.
    - `imageModels(id, refresh, signal): Promise<ListImageModelsResult>` follows the cache and generation rules of `models`.
    - `createProviderGateway` gains `createImage: ImageAdapterFactory`.
  - **Handlers.** `providers:listImageModels` in `ProviderHandlers` follows the existing `providers:listModels` handler: the 10 s bound, `PROVIDER_NOT_FOUND`, and `This provider cannot generate images` for an `ollama` id.

**Steps:**
- [ ] **Step 1: Write failing tests.**
  - The v2 → v3 upgrade keeps ids, keys and the vision last-used.
  - A crash after the in-memory upgrade (no write) reads the same.
  - The kind rules; the https and loopback rule (`http://127.0.0.1:11500/api/v1` is accepted, `http://example.com` refused).
  - `resolve(undefined, 'venice')` answers the last used image entry, else the first `venice` entry.
  - `resolve(ollamaId, 'venice')` throws.
  - Editing a `venice` entry's URL to another origin drops its adapter, and `apiKeyFor` answers null for the old origin.
  - `imageModels` against the mock: cached; `refresh` reloads; a failure is not cached.
  - IPC validation of `providers:listImageModels`.
  - No answer contains `test-key-not-real`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test provider-` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three test files and `tsc` on the owned files — PASS.
- [ ] **Step 5: Commit** `feat: provider kinds and image model lists`

---

### Task 7: Renderer — provider kinds in Settings, context and the analysis dialogs

**Files:**
- Modify:
  - `apps/desktop/src/renderer/src/provider-context.tsx`, `provider-choice.ts`, `provider-gate.ts`
  - `components/ProviderSettings.tsx`, `ProviderSelect.tsx`, `MoveJobsDialog.tsx`
  - tests `apps/desktop/test/renderer/provider-settings.test.tsx`, `provider-select.test.tsx`, `provider-gate.test.tsx`, `move-jobs-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 1 labels and contracts.
- Produces:
  - **Context (`ProvidersState`).** It gains `imageModels: Record<string, ListImageModelsResult | 'checking'>`. Image entries are checked through `providers:listImageModels`.
    - `providerStatus` answers `no_edit_model` for an empty image list.
    - `defaultProviderId(state, kind = 'ollama')`.
    - `defaultEditModelOf(state, id): string | null` (the entry's `editModel` when listed, else the first).
  - **Choice hooks.** `useProviderChoice('tagging' | 'prompt', …)` offers only `ollama` entries. `useImageProviderChoice(opening: string | null): ProviderChoice` offers only `venice` entries.
  - **Gate.** `imageProviderGate(state, id, model): ProviderGate`.
  - **`ProviderSelect`** gains an optional `kind` prop (default `ollama`).
  - **Settings.**
    - A kind select only when creating; Venice prefills `VENICE_DEFAULT_BASE_URL`.
    - A `venice` entry shows `Edit model` instead of the tagging and prompt models.
    - The kind is shown read-only on an existing entry.
  - **Move jobs.** `MoveJobsDialog` targets only `ollama` entries.

**Steps:**
- [ ] **Step 1: Write failing tests:**
  - creating a Venice entry sends `kind: 'venice'` and the prefilled URL;
  - editing does not offer the kind;
  - the analysis dialogs' provider select lists no Venice entry;
  - a Venice entry's state shows `no edit model` for an empty list;
  - a late image-list answer for a deselected entry is ignored;
  - Move jobs offers no Venice target.
- [ ] **Step 2: Run** the four test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them and `tsc` on the owned files — PASS.
- [ ] **Step 5: Commit** `feat: provider kinds in the renderer`

---

**Checkpoint A** (after Tasks 2–5 are merged): `pnpm --filter @assetforge/{contracts,core,persistence,jobs,providers} test` and `typecheck` are green.

---

### Task 8: Main — generation IPC, job host wiring, jobs channel changes, end to end

**Files:**
- Create:
  - `apps/desktop/src/main/generation-handlers.ts`, `generation-image-source.ts`
  - tests `apps/desktop/test/generation-ipc.test.ts`, `generation-acceptance.test.ts`
- Modify:
  - `apps/desktop/src/main/composition.ts`, `ipc.ts`, `job-host.ts`, `job-handlers.ts`
  - `apps/desktop/test/idle-job-host.ts`, `jobs-ipc.test.ts`, `analysis-harness.ts` (if it builds the host)

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `createGenerationHandlers(manager, jobs: JobHost, directory: ImageProviderDirectory)` for the five `generations:*` channels. They run through `manager.read`, so `no_workspace_open` comes first.
  - `createImageProviderDirectory(store, gateway): ImageProviderDirectory`
  - `createGenerationImageSource(previews: PreviewService): GenerationImageSource`. It reads the original into memory only when it is ≤ 25 MB and JPEG, PNG or WebP; otherwise it uses `previews.get({ sha256, sourcePath, size: 'full' })` and that PNG's size.
  - `JobHost`:
    - The handler map gains `[IMAGE_GENERATE_JOB]`.
    - `reconcileGenerations(session)` runs before `created.start()`; a failure is logged and does not block.
    - `paused(): { lane, reason, resourceClass }[]` covers `local_gpu` and `remote_api`.
    - `resume(lane)` resumes both classes.
    - `cancelAll()` delegates to the scheduler (0 without one).
  - **`jobs:summary.paused`.** Its items carry `kind` (`remote_api` → `venice`), and the provider name comes from the store.
  - **`jobs:retry`** on an `image.generate` job calls `retryGeneration` with the generation `byJob`.
  - **Provider delete guard** counts active jobs of both types in the lane.
  - **Composition** passes `createVeniceImage` to the gateway.

**Steps:**
- [ ] **Step 1: Write failing IPC tests:**
  - every channel's validation, plus `no_workspace_open`;
  - `generations:start` against an unreachable entry answers `{ ok: false, code: 'provider_unreachable' }` and no job exists;
  - `jobs:retryFailed` leaves a failed generation job;
  - `jobs:retry` on it requeues the same generation;
  - `jobs:summary.paused` lists a Venice lane after one 402 with `kind: 'venice'`, and `jobs:resume` clears it;
  - no response anywhere contains `test-key-not-real`.
- [ ] **Step 2: Write failing end-to-end tests** (real SQLite, real scheduler, in-process mock; follow `providers-acceptance.test.ts`):
  - import a PNG into an asset, start an edit, wait until the job succeeds;
  - the new file is complete in that asset with role `generated` and named `<base> edit 1.png`;
  - `generations:forFile` on the source lists it under `results`, and on the result answers `madeBy`;
  - an upscale ×2 of the result;
  - `mock:500` ends `failed` `provider_outcome_unknown` after one request (`imageRequests.length === 1`);
  - `mock:429` is retried and the third failure ends it;
  - `mock:slow` interrupted by `workspaceClosing()` → reopened → `failed` `provider_outcome_unknown`, and the mock saw exactly one request;
  - trashing and purging the source keeps the result's `madeBy` with `fileId: null` and the name.
- [ ] **Step 3: Run** `pnpm --filter @assetforge/desktop test generation` — FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `pnpm --filter @assetforge/desktop test` — PASS, with only the known flaky test allowed one re-run.
- [ ] **Step 6: Commit** `feat: generation channels and job host wiring`

---

### Task 9: Renderer — the studio dialog

**Files:**
- Create:
  - `apps/desktop/src/renderer/src/studio-state.ts`
  - `components/StudioForm.tsx`, `components/StudioResults.tsx`
  - tests `apps/desktop/test/studio-state.test.ts`, `apps/desktop/test/renderer/generation-studio.test.tsx`
- Modify: `components/GenerationStudio.tsx` (replaces the stub, same props)

**Interfaces:**
- Consumes: Tasks 1 and 7 (`useImageProviderChoice`, `imageProviderGate`, `ProviderSelect kind="venice"`, `defaultEditModelOf`), `useJobs()` changes, `Dialog`, `ImageStage` or `CoverImage` for the large previews, `ModelSelect`.
- Produces:
  - `studio-state.ts`:
    - `StudioForm { providerId; model; prompt; aspectRatio: string | null; resolution: string | null; safeMode: boolean }`
    - `formFromGeneration(g: Generation, form: StudioForm): StudioForm` (Use settings; an upscale copies nothing but the provider)
    - `constrain(form, model: ImageModel | null): StudioForm` (drops values the model does not state; resolution defaults to `defaultResolution`)
    - `readSafeMode(): boolean`, `writeSafeMode(v: boolean): void`
    - `tileState(g: Generation): 'queued' | 'running' | 'failed' | 'cancelled' | 'ready' | 'trashed' | 'deleted'`
  - **Layout.** `GenerationStudio` has three columns: source, form, results. Its size follows the window like `FileDetailDialog`.
  - **Data flow.** Results come from `generations:forFile`, reloaded when the jobs change counter moves. Recent prompts come from `generations:recentPrompts`.
  - **Generate** sends `generations:start` and keeps the form; `{ ok: false, code }` shows `JOB_ERROR_MESSAGES[code]` in the button's `title`.
  - **Tiles.**
    - Failed or cancelled: Retry and Remove.
    - Selected ready result: Open (`onOpenFile`), Upscale 2×/4×, Use settings and Delete (`files:trashMany`).
    - The price appears in the model option's `title`.

**Steps:**
- [ ] **Step 1: Write failing pure tests:**
  - `constrain` with `mock-edit` and `mock-edit-basic`;
  - `formFromGeneration` copies prompt, model, aspect ratio, resolution and safe mode;
  - `readSafeMode` defaults to `true` and survives a throwing `localStorage`;
  - `tileState` for each status and for `trashed` and `fileId: null` outputs.
- [ ] **Step 2: Write failing jsdom tests** (`fake-api.ts`):
  - without an image provider, Generate is disabled with a `title`;
  - aspect and resolution selects show only the model's values;
  - Generate twice sends two starts and the prompt stays;
  - tiles for queued, running, failed (with the message in `title`, Retry, Remove), trashed and deleted;
  - Use settings fills the form;
  - Delete calls `files:trashMany`;
  - opening on a file with results shows them newest first;
  - the safe mode toggle persists.
- [ ] **Step 3: Run** both — FAIL. Implement. Run — PASS; `theme.test.ts` green.
- [ ] **Step 4: Commit** `feat: generation studio dialog`

---

### Task 10: Renderer — entry points, details block, Jobs label, banner

**Files:**
- Create:
  - `apps/desktop/src/renderer/src/studio-context.tsx`
  - `components/GenerationDetails.tsx`
  - test `apps/desktop/test/renderer/generation-details.test.tsx`
- Modify:
  - `apps/desktop/src/renderer/src/file-actions.ts`
  - `components/FileDetailDialog.tsx`, `AssetFilesTab.tsx`, `AppShell.tsx`, `WorkspaceShell.tsx`
  - `screens/InboxScreen.tsx`, `screens/JobsScreen.tsx`
  - tests `file-dialog.test.tsx`, `jobs-screen.test.tsx`, `shell.test.tsx`

**Interfaces:**
- Consumes: Task 1 (labels, the `GenerationStudio` props), Task 7 (`useProviders`, `defaultProviderId(state, 'venice')`).
- Produces:
  - **`studio-context.tsx`.** `StudioProvider` mounts `GenerationStudio` once, inside `WorkspaceShell` beside `JobsProvider`. `useStudio(): { open(file: FileRecord): void; upscale(file: FileRecord, scale: 2 | 4): Promise<void>; blocked: string | null }`, where `blocked` is `NO_IMAGE_PROVIDER_TITLE` without a `venice` entry.
  - **File menu.** `FileActionContext` gains `studio?: ReturnType<typeof useStudio>`. Its menu items are `Generate from image`, `Upscale 2×` and `Upscale 4×`, only for a complete `isPreviewable` file outside the trash, and disabled with `blocked` as `title`. The asset Files tab, the inbox and the detail dialog pass it; the trash does not.
  - **`GenerationDetails { fileId }`** in the `FileDetailDialog` details column:
    - `Generated from` with a `Link` to the source, or its name plus `DELETED_MARK` when purged;
    - provider, model, parameters and the prompt with a copy icon button;
    - `Results` with a `Link` per output file.

    A link opens that file in the dialog.
  - **Jobs screen.** The type column uses `JOB_TYPE_LABELS`.
  - **Banner.** It shows Move jobs only for `kind === 'ollama'`; Resume and Settings stay for `venice`.

**Steps:**
- [ ] **Step 1: Write failing tests:**
  - the menu entries for a PNG; none for an SVG or a trashed file;
  - the blocked entries without a Venice entry carry the `title`;
  - Upscale 4× sends `generations:start` with `scale: 4`;
  - the details block in both directions, the purged source mark and the copy button;
  - the Jobs screen label `Generation`;
  - the banner line of a paused Venice lane has Resume and Settings but no Move jobs.
- [ ] **Step 2: Run** them — FAIL. Implement. Run — PASS; `theme.test.ts` green.
- [ ] **Step 3: Commit** `feat: studio entry points and generation details`

---

**Checkpoint B** (after Tasks 8–10 are merged): `pnpm typecheck`, `pnpm test` and `pnpm --filter @assetforge/desktop build` are green.

---

### Task 11: Documentation

**Files:**
- Modify: `ReadMe.md` (§7.2, §8, §9.3, §15.2, §17 and the IPC channel list), `docs/backlog.md`
- Untouched: `CLAUDE.md` (the controller updates the project state)

**Steps:**
- [ ] **Step 1: Update the ReadMe.**
  - §7.2: the generation record (fields, `parameters` v1, the resolved prompt, no prompt version yet).
  - §8: provider kinds, `ImageProvider`, the Venice adapter.
  - §9.3: the `image.generate` job, the outcome table, `settled`, `onInterrupted: 'fail'` with `interruptedCode`, the `remote_api` pause and the `jobs:retryFailed` exclusion.
  - §15.2: the key and origin rule for image entries, no redirect.
  - §17: phase 5a done, the prompt library next.
  - The IPC list: the five `generations:*` channels and `providers:listImageModels`.
- [ ] **Step 2: Add backlog entries.**
  - The Venice API shape is unverified (no network during the build).
  - Venice `/image/edit` is experimental.
  - Trashing a source aborts a running paid request.
  - Result names may repeat after a removal.
  - A failed import of a paid answer leaves a failed inbox row.
  - Upscale ignores Venice's own upscale limits beyond the pixel bounds.
  - No workspace-wide generations screen.
- [ ] **Step 3: Commit** `docs: generation studio in ReadMe and backlog`

