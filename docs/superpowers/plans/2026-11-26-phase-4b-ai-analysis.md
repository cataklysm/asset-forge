# Phase 4b — AI analysis with the owner's Ollama — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provider settings with an API key in `safeStorage`, a model chosen by the owner per function and per run, stored tag proposals for single images, batch analysis by selection/asset/filter with fingerprint skip, Image2Prompt, and a queue that pauses when the provider is down.

**Architecture:** Task 1 fixes every contract, port and shared signature and leaves the repository green with throwing stubs. Six lanes with disjoint files then run in parallel worktrees, a second wave integrates the main process while three dialogs are built, a third wires the renderer and writes the docs. The controller cherry-picks each lane, runs typecheck and the full suite after each integration, and pushes.

**Tech Stack:** TypeScript, Zod, better-sqlite3 + Drizzle (migration `0007`), Electron `safeStorage`, React + Tailwind tokens, Vitest (+ jsdom).

**Spec:** `docs/superpowers/specs/2026-11-26-phase-4b-ai-analysis-design.md` (binding; section numbers below refer to it).

## Global Constraints

- The API key never appears in the repository, a test fixture, a log line, a job row, a job payload, `file_analysis`, `file_analysis_proposal`, `provider-settings.json`, an error message or any IPC response. Tests use the literal `test-key-not-real`.
- No agent and no test sends a request to host port 11434, starts/stops/removes Docker containers, or launches the app. Tests use stubs or the in-process mock server.
- No model name is a default anywhere in production code. The model is a required argument of every provider call.
- `core` and `contracts` import no Electron, no database, no provider. `safeStorage` is touched only in `apps/desktop/src/main`, behind `SecretCodec`.
- `AssetForgeError` / `JobError` messages are fixed texts: no cause, URL, path, header or body.
- UI: no explanatory text in the layout (tooltips through `title`), every button from `ui.ts` (`BUTTON`, `ICON_BUTTON`, `BUTTON_INLINE`), tokens only, AI colour through the existing `ai` token; `test/theme.test.ts` must stay green.
- Everything in the repository is English. Commit messages are conventional, without attribution lines. Lane agents commit once in their worktree and do not push.
- No DB transaction spans a provider or file operation. Job inserts for filter targets: at most 500 per transaction.
- Exact values: timeout 10–600 s, default 120; model name 1–200 chars; API key 1–500 chars; at most 100 models, 4 `show` calls at a time, 10 s each; pause after 3 consecutive `provider_unreachable` / `provider_unavailable` / `provider_timeout`, at once on `provider_unauthorized` / `provider_not_configured`; prompt text cut at 4000 chars; proposal at most 20 tags.
- A lane that must touch a file outside its list to keep `pnpm typecheck` green makes the smallest possible change and lists it in its report.

## Review Focus

1. **The key leaves the main process or goes to the wrong host** — expect: absent from every response, row and log; deleted when the base URL's origin changes without a new key. Tests in Tasks 6 and 8.
2. **A proposal outlives its file content** (file replaced/moved between propose and accept) — expect: accept fails with `invalid_operation`, the proposal is gone, no tag is written. Tests in Tasks 2 and 3.
3. **A filter target far larger than one chunk** (1 201 files) — expect: all enqueued, three transactions, counts correct, a second run skips all as `alreadyQueued`. Tests in Tasks 2 and 3.
4. **The provider dies mid-batch behind a gateway** (502, then timeouts) — expect: pause after the third run, queued jobs untouched, attempts kept, pause survives a workspace switch, Resume continues. Tests in Tasks 5 and 8.
5. **The model list is partly unusable** (`/api/show` fails or is blocked for some models, no capabilities field) — expect: the list still loads, such models are selectable with `vision: null`, non-vision models are not. Tests in Tasks 4 and 7.

## Waves

| Wave | Tasks (parallel within a wave) |
| --- | --- |
| 0 | 1 |
| 1 | 2, 3, 4, 5, 6, 7 |
| 2 | 8, 9, 10, 11 |
| 3 | 12, 13 |

---

### Task 1: Contracts, ports and scaffold

Everything later tasks share. The repository stays green: `pnpm typecheck` and `pnpm test` pass after this task.

**Files:**
- Modify: `packages/contracts/src/jobs.ts`, `files.ts`, `ipc.ts`, the `AssetForgeError` code list; Create: `packages/contracts/src/analysis.ts`, `packages/contracts/src/settings.ts` (export both from the index)
- Modify: `packages/core/src/ports.ts`, `packages/core/src/jobs.ts` (messages of the new codes)
- Stubs: `packages/persistence/src/file-analysis-repository.ts`, the file list mapper, `packages/core/test` fakes, `packages/providers/src/ollama-vision.ts`, `apps/desktop/src/main/job-handlers.ts`, `apps/desktop/src/renderer/src/analysis.ts`
- Test: `packages/contracts/test/analysis.test.ts`, `settings.test.ts`

**Produces (exact):**

```ts
// contracts/jobs.ts
JobErrorCode += 'provider_unauthorized' | 'provider_not_configured'   // both NOT retryable
ModelNameSchema = z.string().min(1).max(200)
AnalyzeFilePayloadSchema = z.union([ z.object({ version: z.literal(1) }),
  z.object({ version: z.literal(2), model: ModelNameSchema, mode: z.enum(['apply', 'propose']) }) ])
JobSummary += paused: { reason: JobErrorCode } | null

// contracts/analysis.ts
FileListFilterSchema   // scope, query?, tagNames?, role?, kind? — extracted from the files:list request, which now extends it
AssetListFilterSchema  // typeId?, status?, projectId?, query?, tagNames?, fileRole?, fileKind? — extracted from assets:list
AnalysisTargetSchema = z.discriminatedUnion('kind', [
  { kind: 'files', fileIds: FileIdsSchema }, { kind: 'fileFilter', filter: FileListFilterSchema },
  { kind: 'asset', assetId: uuid }, { kind: 'assetFilter', filter: AssetListFilterSchema } ])
AnalysisModeSchema = z.enum(['apply', 'propose'])
AnalysisPreviewSchema = { analysable, alreadyAnalysed, alreadyQueued, notAnalysable }        // counts
EnqueueAnalysisResultSchema = { enqueued, skipped: { notFound, notAnalysable, alreadyQueued, alreadyAnalysed } }
ProposalViewSchema = { model, createdAt, stale: boolean, tags: { name, displayName }[] }
DescribeResultSchema = { ok: true, text } | { ok: false, code: JobErrorCode | 'cancelled' | 'busy' }

// contracts/settings.ts
VisionSettingsViewSchema = { baseUrl: string | null, timeoutSeconds: int 10..600, taggingModel: string | null,
  promptModel: string | null, hasApiKey: boolean, fromEnvironment: boolean, canStoreKey: boolean }
SetVisionSettingsSchema = { baseUrl: string | null, timeoutSeconds, taggingModel, promptModel,
  apiKey: z.string().min(1).max(500).nullable().optional() }      // absent keep, null delete
VisionModelSchema = { name: ModelNameSchema, vision: boolean | null }
ListModelsResultSchema = { ok: true, models: VisionModel[] } | { ok: false, code: JobErrorCode }

// contracts/files.ts
FileRecord += hasProposal: boolean;   files:list request += hasProposal?: boolean
AssetForgeError code += 'credential_store_unavailable'
```

IPC channels (spec §1, §4, §5, §6 tables, verbatim): `settings:getVision`, `settings:setVision`, `settings:listVisionModels`, `analysis:preview`, `analysis:enqueue` (new request `{ target, model, mode, force }`, new response), `analysis:getProposal`, `analysis:acceptProposal`, `analysis:discardProposal`, `analysis:describe`, `analysis:cancelDescribe`, `jobs:resume`. The three `settings:*` channels must work without an open workspace.

```ts
// core/ports.ts
interface VisionProvider {
  analyzeImage(r: { image: Uint8Array; prompt: string; schema: unknown; model: string; signal: AbortSignal }): Promise<unknown>;
  describeImage(r: { image: Uint8Array; prompt: string; model: string; signal: AbortSignal }): Promise<string>;
  listModels(signal: AbortSignal): Promise<{ name: string; vision: boolean | null }[]>;
}
interface AnalysisFingerprint { provider: string; model: string; promptVersion: number }
interface Proposal extends AnalysisFingerprint { fileId: string; sha256: string; tags: { name: string; displayName: string }[]; createdAt: string }
// FileAnalysisRepository gains:
propose(r: Proposal): boolean                       // false unless the file is complete with this sha256; replaces an older proposal
getProposal(fileId: string): (Proposal & { stale: boolean }) | null
acceptProposal(r: { fileId: string; sha256: string; tags: { name; displayName; newId }[]; now: string }): boolean
                                                    // false = stale or gone (a stale proposal is deleted); true = tags applied as `apply` does,
                                                    // file_analysis written from the proposal, proposal deleted
discardProposal(fileId: string): void
// apply(...) additionally deletes the file's proposal in its transaction.
interface AnalysisTargetReader {
  page(r: { target: AnalysisTarget; fingerprint: AnalysisFingerprint; mimeTypes: readonly string[]; afterId: string | null; limit: number }):
    { fileId: string; analysable: boolean; analysed: boolean }[]      // keyset by file id, ascending; unknown ids of a 'files' target are absent
  count(r: { target: AnalysisTarget; fingerprint: AnalysisFingerprint; mimeTypes: readonly string[] }): AnalysisPreview
}
// latest analysis job of a file, for analysis:getProposal:
JobRepository.latestForFile(fileId: string, type: string): Job | null
```

`analysed` follows spec §4 (the fingerprint equals the `file_analysis` row or the waiting proposal, with the file's current hash). `mimeTypes` is the previewable list core already uses for `isAnalysable`. For `assetFilter`, `fileRole` / `fileKind` narrow the files (spec §4 Targets).

- [ ] **Step 1:** Write contract tests: v1 and v2 payloads parse, v2 without model fails; each target kind parses, a `files` target with 0 or 1001 ids fails; `SetVisionSettingsSchema` accepts absent / `null` / string key and refuses an empty or 501-char key and timeouts 9 and 601; the new job codes are not retryable.
- [ ] **Step 2:** Run them — expect failures. Implement the contracts and ports above.
- [ ] **Step 3:** Keep the tree green with stubs, each marked `// phase 4b stub: Task N`:
  - new repository, fake and adapter methods throw `new Error('not implemented')`; `hasProposal` is mapped as `false`; `paused` as `null`;
  - the signatures that cross lanes take their final shape now, so wave 1 changes bodies only and no lane edits `index.ts` or `job-host.ts`: `createOllamaVision` takes the options of Task 4 (no `model`; `apiKey`, `onFailure` accepted and ignored for now) and `createAnalyzeFileHandler` the deps of Task 3 (`vision: () => VisionProvider | null`, `defaultModel: () => string | null`); the host wires `vision: () => adapter` and `defaultModel: () => config.model` from the unchanged `readVisionConfig`; the handler passes `defaultModel()` to `analyzeImage` for every payload until Task 3;
  - `analysis:enqueue` handler: a `files` target with mode `apply` goes to 4a's `enqueueAnalysis` and its result is mapped to the new counts (`alreadyAnalysed: 0`); anything else and every other new channel throws `AssetForgeError('invalid_operation')`;
  - renderer `startAnalysis` sends `{ target: { kind: 'files', fileIds }, model: TEMP_MODEL, mode: 'apply', force: true }` with `export const TEMP_MODEL = 'unset'` (removed in Task 12) and builds its strip title from the counts.
- [ ] **Step 4:** `pnpm typecheck` and `pnpm test` green. Commit `feat(contracts): define the phase 4b contracts and ports`.

---

### Task 2: Persistence — proposals, fingerprint, target enumeration (wave 1)

**Files:** Modify `packages/persistence/src/schema.ts`, `file-analysis-repository.ts`, `job-repository.ts`, the file list repository; Create migration `0007` (`pnpm --filter @assetforge/persistence db:generate`), `packages/persistence/src/analysis-target-reader.ts`; Tests in `packages/persistence/test/`.

**Consumes:** the ports of Task 1. **Produces:** their SQLite implementations; `FileRecord.hasProposal` and the `hasProposal` filter of `files:list` backed by the table.

Table `file_analysis_proposal`: `file_id` text primary key → `file.id`, `sha256`, `provider`, `model`, `prompt_version` int, `tags` text (JSON), `created_at`; all not null. Migration is additive; `DERIVED_DATA_VERSION` unchanged.

- [ ] **Step 1 (tests first):**
  - `propose` stores, replaces an older proposal, returns false for a missing / not complete / different-hash file and writes nothing; tags and `file_analysis` untouched.
  - `getProposal().stale` is true after the file's `sha256` changed.
  - `acceptProposal`: applies exactly the given tags as AI tags (replaces older AI tags, a manual tag stays manual and is not duplicated), writes `file_analysis` with the proposal's fingerprint, deletes the proposal, reindexes the asset, changes no workflow step and no asset status; returns false and deletes the proposal when the hash differs; returns false when there is none.
  - `apply` deletes a waiting proposal. `discardProposal` twice does not throw.
  - Reader `page` / `count` for each target kind: `files` (unknown ids absent), `fileFilter` (inbox scope + query + tag + role + kind), `asset`, `assetFilter` (with `fileRole` only files of that role; with `tagNames` all files of matching assets). `analysed` true for a matching `file_analysis` row, for a matching proposal, false for another model, another prompt version or a changed hash. `count.alreadyQueued` counts files with an active job. Paging: 1 201 files, limit 500 → 500, 500, 201, no duplicates.
  - `files:list` with `hasProposal: true`; `hasProposal` on records. `latestForFile` returns the newest job of a type.
  - Migration test: `0006` → `0007` keeps existing rows.
- [ ] **Step 2:** Implement; each write is one synchronous transaction. Reuse the filter SQL of the existing list repositories rather than copying it.
- [ ] **Step 3:** `pnpm --filter @assetforge/persistence test`, `pnpm typecheck`. Commit `feat(persistence): store tag proposals and enumerate analysis targets`.

---

### Task 3: Core — enqueue by target, proposals, handler v2, describe (wave 1)

**Files:** Modify `packages/core/src/analysis.ts` (split into `analysis-*.ts` files if it passes ~300 lines), `packages/core/test/` fakes and tests.

**Consumes:** Task 1 ports. **Produces:**

```ts
enqueueAnalysis(s, r: { target: AnalysisTarget; model: string; mode: 'apply' | 'propose'; force: boolean }): Promise<EnqueueAnalysisResult>
previewAnalysis(s, r: { target: AnalysisTarget; model: string }): Promise<AnalysisPreview>
getProposal(s, fileId): Promise<{ proposal: ProposalView | null; job: JobView | null }>
acceptProposal(s, r: { fileId: string; names: string[] }): Promise<void>      // invalid_operation: no proposal, stale, empty or foreign names
discardProposal(s, fileId): Promise<void>
createAnalyzeFileHandler(deps: { session; vision: () => VisionProvider | null; images; provider: string; defaultModel: () => string | null }): JobHandler
describeImage(deps: { session; vision: () => VisionProvider | null; images }, r: { fileId: string; model: string; signal: AbortSignal }): Promise<string>
IMAGE_PROMPT: string;  MAX_PROMPT_TEXT = 4000;  ENQUEUE_CHUNK = 500
```

- [ ] **Step 1 (tests first, against the in-memory fakes — implement the fakes' new methods here):**
  - enqueue: payload is `{ version: 2, model, mode }`; `propose` with anything but a one-id `files` target → `invalid_operation`; `propose` ignores the fingerprint; `apply` without `force` skips analysed files as `alreadyAnalysed`, with `force` enqueues them; counts for `notFound` (ids of a `files` target the reader did not return), `notAnalysable`, `alreadyQueued`; a 1 201-file filter target enqueues all in three `enqueue` calls of ≤ 500.
  - handler: v2 `apply` writes `file_analysis` with the payload's model; v2 `propose` stores a proposal and leaves tags alone; v1 uses `defaultModel()`, and fails with `provider_not_configured` when it is null; `vision()` null → `provider_not_configured`; the model passed to `analyzeImage` is the payload's; zero clean tags still `invalid_response`; `propose` returning false → `file_unavailable`.
  - accept: a subset is applied, names are compared normalised, a name not in the proposal → `invalid_operation`; repository `false` → `invalid_operation`.
  - describe: returns trimmed text cut at 4000; empty text → `JobError('invalid_response')`; not analysable file → `file_unavailable`; aborted signal rethrows the reason; nothing is written to any repository (assert the fakes saw no write).
- [ ] **Step 2:** Implement. Provider calls and JPEG reads stay outside transactions.
- [ ] **Step 3:** `pnpm --filter @assetforge/core test`, `pnpm typecheck` (adapt `job-host.ts` minimally if the handler's deps break it, and report it). Commit `feat(core): analyse by target with proposals and a chosen model`.

---

### Task 4: Provider adapter and mock (wave 1)

**Files:** Modify `packages/providers/src/ollama-vision.ts`, `packages/providers/test/`, `docker/mock-provider/server.mjs` and its test, `.env.example`.

**Produces:**

```ts
createOllamaVision(options: { baseUrl: string; apiKey?: () => string | null; timeoutMs?: number;
  fetch?: typeof fetch; onFailure?: (code: JobErrorCode, status: number | null) => void }): VisionProvider
```

- [ ] **Step 1 (tests first):**
  - `Authorization: Bearer test-key-not-real` on chat, tags and show when `apiKey()` returns a string; no header when it returns null or is absent; the key is read per request.
  - 401 and 403 → `provider_unauthorized`; `onFailure` receives code and status and nothing else (assert its arguments; assert no test output contains the key).
  - `analyzeImage` sends the call's `model`; `describeImage` sends no `format` and returns `message.content` as text; missing/non-string content → `invalid_response`.
  - `listModels`: `GET /api/tags` then `POST /api/show` per model; capabilities with `vision` → true, without → false, no `capabilities` field or a failing `show` (500, timeout, 404) → null and the list still resolves; 101 models → only 100 are asked; never more than 4 `show` calls in flight; all responses pass the existing 1 MiB cap; `redirect: 'manual'` on every request.
  - Mock: with `MOCK_API_KEY` set, a request without the bearer gets 401; `/api/show` serves one vision model, one non-vision model and one without capabilities; a chat without `format` answers plain text; the mock's log never contains the `Authorization` value.
- [ ] **Step 2:** Implement; share one capped, timed request helper between the three calls.
- [ ] **Step 3:** `pnpm --filter @assetforge/providers test`, the mock's test, `pnpm typecheck`. Commit `feat(providers): authenticate, list models and describe images`.

---

### Task 5: Scheduler pause (wave 1)

**Files:** Create `packages/jobs/src/pause-gate.ts`; Modify `packages/jobs/src/scheduler.ts`, index, `packages/jobs/test/`.

**Produces:**

```ts
interface PauseGate {
  reason(rc: ResourceClass): JobErrorCode | null;
  record(rc: ResourceClass, outcome: JobErrorCode | 'ok' | 'other'): void;   // 'other' = cancelled, released, non-provider error
  resume(rc: ResourceClass): void;
}
createPauseGate(options: { threshold?: number /* 3 */; onChange?: () => void }): PauseGate
SchedulerOptions += pause?: PauseGate
```

- [ ] **Step 1 (tests first, injected clock and timers, no sleeps):** three consecutive runs ending `provider_unreachable` / `provider_unavailable` / `provider_timeout` (mixed) pause the class with the last code; a success in between resets; `provider_unauthorized` and `provider_not_configured` pause at once; a paused class claims neither `queued` nor due `retry_wait` jobs, another class keeps running; the tripping job follows its normal path and keeps its attempt; `resume` + `wake` continues; the same gate handed to a second scheduler instance is still paused; `onChange` fires on pause and on resume only.
- [ ] **Step 2:** Implement: `pass()` skips a class with a reason; `settle` records the outcome.
- [ ] **Step 3:** `pnpm --filter @assetforge/jobs test`, `pnpm typecheck`. Commit `feat(jobs): pause a resource class when the provider is down`.

---

### Task 6: Settings store, credential store, vision gateway (wave 1)

**Files:** Create in `apps/desktop/src/main/`: `vision-settings.ts`, `secret-codec.ts`, `vision-gateway.ts`, `settings-handlers.ts`; Modify `vision-config.ts` only by exporting its URL rule for reuse — `readVisionConfig` and its defaults stay until Task 8 removes them; Tests in `apps/desktop/test/`. Do **not** edit `index.ts`, `ipc.ts`, `job-host.ts` (Task 8 wires).

**Produces:**

```ts
interface SecretCodec { available(): boolean; encrypt(text: string): Buffer; decrypt(data: Buffer): string }
createSafeStorageCodec(): SecretCodec                       // the only import of electron's safeStorage
createVisionSettingsStore(o: { userData: string; secrets: SecretCodec; env: NodeJS.ProcessEnv }): {
  view(): VisionSettingsView; save(input: SetVisionSettings): VisionSettingsView;
  baseUrl(): string | null; timeoutMs(): number; apiKey(): string | null;
  defaults(): { taggingModel: string | null; promptModel: string | null }; onChange(listener: () => void): void }
createVisionGateway(o: { settings: VisionSettingsStore; create: typeof createOllamaVision; log: (line: string) => void }): {
  current(): VisionProvider | null; models(refresh: boolean, signal: AbortSignal): Promise<ListModelsResult> }
createSettingsHandlers(store, gateway)                       // settings:getVision / setVision / listVisionModels
```

Files: `userData/provider-settings.json` (`{ version: 1, vision: {…} }`, atomic write, renamed aside when unreadable) and `userData/credentials/vision-api-key`.

- [ ] **Step 1 (tests first, fake `SecretCodec`, temp dirs):**
  - round trip of URL, timeout, models; an invalid base URL (user info, query, fragment, bare `?`, `ftp:`) is refused with `invalid_operation` and nothing is written; a corrupt file is renamed and reads as empty; `settings.json` of the registry is never touched.
  - key: stored bytes differ from the plaintext and the plaintext is nowhere under `userData`; `view()` and `save()` results contain no key, only `hasApiKey`; absent keeps, `null` deletes, a string replaces; `available() === false` + a key → `credential_store_unavailable`, no file, URL not saved either; undecryptable file → `hasApiKey: false`.
  - origin rule: changing scheme, host or port without a key deletes the key; changing only the path keeps it; changing origin with a new key stores the new one.
  - env: with `ASSETFORGE_VISION_BASE_URL` set → `fromEnvironment: true`, both models from `ASSETFORGE_VISION_MODEL`, `apiKey()` null even if a key file exists, `save` → `invalid_operation`. Without env and without a file: `baseUrl` null.
  - gateway: `current()` null without a base URL; a new adapter after a settings change; the adapter gets `apiKey` as a function; model list cached until a change or `refresh`; a `JobError` from `listModels` becomes `{ ok: false, code }`, no URL → `provider_not_configured`; the failure log line holds only code and status.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `pnpm --filter @assetforge/desktop test vision-settings` (and the other new files), `pnpm typecheck`. Commit `feat(desktop): store provider settings and the API key`.

---

### Task 7: Renderer foundation — provider context, model select, settings screen (wave 1)

**Files:** Create `apps/desktop/src/renderer/src/provider-context.tsx`, `components/ModelSelect.tsx`, `screens/SettingsScreen.tsx`; Modify `nav.ts` (view `settings`), `AppShell.tsx` (nav entry `Settings`, provider wrapped next to `JobsProvider`), `WorkspaceShell.tsx` (route); Tests in `apps/desktop/test/renderer/`.

**Produces:**

```ts
useProvider(): { settings: VisionSettingsView | null; models: ListModelsResult | null; loading: boolean;
  reload(): Promise<void>; refreshModels(): Promise<void>; save(input: SetVisionSettings): Promise<VisionSettingsView> }
ModelSelect(props: { purpose: 'tagging' | 'prompt'; value: string | null; onChange(model: string | null): void; disabled?: boolean })
```

`ModelSelect` preselects nothing itself; callers initialise `value` from `settings.taggingModel` / `promptModel`. It lists vision models first, then unknown, by name; non-vision models are disabled options; a refresh `ICON_BUTTON`; a list error shows the error's fixed message. Outside a provider `useProvider` returns the empty state.

- [ ] **Step 1 (jsdom tests first, `window.api` mocked):** the screen loads and shows the stored values; the key field is always empty and write-only, shows that a key is stored and a Remove button that sends `apiKey: null`; Save sends no `apiKey` when the field is empty; Test connection saves first, then calls `settings:listVisionModels { refresh: true }`; `fromEnvironment` makes every control disabled; `canStoreKey: false` disables the key field with a `title`; the two model selects exclude non-vision models; a value no longer in the list stays visible as the current value; no button outside `ui.ts` classes.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `pnpm --filter @assetforge/desktop test renderer/settings`, `theme.test`, `pnpm typecheck`. Commit `feat(ui): add provider settings and the model select`.

---

### Task 8: Main-process integration (wave 2, after 2–6)

**Files:** Modify `apps/desktop/src/main/index.ts`, `composition.ts`, `ipc.ts`, `job-host.ts`, `job-handlers.ts`; Create `describe-controller.ts`; Tests `apps/desktop/test/analysis-acceptance.test.ts` (extend), `jobs-ipc.test.ts`, new `settings-ipc.test.ts`, `describe.test.ts`.

**Consumes:** everything of Tasks 2–6. **Produces:** all Task 1 channels answered for real; no `phase 4b stub` left in `packages/` or `apps/desktop/src/main`.

- The job host takes the gateway and one `PauseGate` created once per app session; every scheduler it creates gets that gate; `jobs:summary.paused` reads `gate.reason('local_gpu')`; `jobs:resume` and every settings change call `gate.resume('local_gpu')` and wake.
- `createDescribeController`: one request at a time (`busy`), `cancel(requestId)`, `cancelAll()` called from `workspaceClosing` and on quit; a cancelled request answers `{ ok: false, code: 'cancelled' }`.
- `settings:*` are registered so they answer without an open workspace.
- `readVisionConfig` and the 4a defaults (`http://127.0.0.1:11500`, `mock-vision`) are removed; the settings store is the only source (test: no env, no file → `current()` is null and a job fails `provider_not_configured`).

- [ ] **Step 1 (tests first, in-process mock with `MOCK_API_KEY=test-key-not-real`):**
  - end to end: save settings with key → list models → preview → enqueue `apply` for a `fileFilter` → jobs succeed, AI tags written, `file_analysis.model` is the chosen model; a second enqueue skips all as `alreadyAnalysed`; `force` runs them again.
  - propose → `getProposal` shows tags and the job → reopen the workspace → still there → accept a subset → only those tags, proposal gone.
  - key hygiene: the key string occurs in no IPC response of the whole test, in no row of `job`, `file_analysis`, `file_analysis_proposal`, not in `provider-settings.json`, not in the captured main log; the mock received it only on its own origin.
  - wrong key → the first job fails `provider_unauthorized`, `jobs:summary.paused.reason` says so, the other jobs stay `queued`; closing and reopening the workspace keeps the pause; saving the right key resumes and the queue drains.
  - mock stopped → pause after three runs; `jobs:resume` continues.
  - a queued v1 job runs with the tagging default.
  - describe: returns text; `cancelDescribe` → `cancelled`; a second request while one runs → `busy`; closing the workspace cancels; the database is byte-identical in `job` / `file_analysis` row counts before and after.
  - `settings:getVision` without a workspace works; `analysis:*` without one → `no_workspace_open`.
- [ ] **Step 2:** Implement the wiring; delete every stub of Task 1 on the main side.
- [ ] **Step 3:** `pnpm typecheck`, `pnpm test`, `pnpm --filter @assetforge/desktop build`. Commit `feat(desktop): wire settings, proposals, describe and the queue pause`.

---

### Task 9: Start dialog (wave 2, after 7)

**Files:** Create `apps/desktop/src/renderer/src/components/AnalysisStartDialog.tsx`; Test `apps/desktop/test/renderer/analysis-start-dialog.test.tsx`.

```ts
AnalysisStartDialog(props: { open: boolean; target: AnalysisTarget | null; onClose(): void; onStarted(result: EnqueueAnalysisResult): void })
```

- [ ] **Step 1 (tests first):** opens with the tagging default selected; calls `analysis:preview` with target and model and again when the model changes (a stale answer is ignored); shows the four counts; `Start` is disabled without a model, while the preview loads, and when nothing would be enqueued (`analysable - alreadyAnalysed - alreadyQueued === 0` and "Analyse again" off); the checkbox sends `force: true`; Start sends mode `apply`, then calls `onStarted` and `onClose` and refreshes the jobs context; a rejected enqueue shows the error's message and keeps the dialog open; a double click sends one request; not configured → a button that navigates to `settings`.
- [ ] **Step 2:** Implement with the shared `Dialog` (`size: 'form'`) and `ModelSelect`.
- [ ] **Step 3:** test file, `theme.test`, `pnpm typecheck`. Commit `feat(ui): add the analysis start dialog`.

---

### Task 10: Result dialog (wave 2, after 7)

**Files:** Create `components/AnalysisResultDialog.tsx`; Test `test/renderer/analysis-result-dialog.test.tsx`.

```ts
AnalysisResultDialog(props: { open: boolean; file: FileRecord | null; onClose(): void; onChanged(): void })
```

States and controls exactly as spec §7 "Result dialog". It reloads `analysis:getProposal` when the jobs context's `changeToken` moves; it must render above an open file detail dialog.

- [ ] **Step 1 (tests first):** nothing yet → model select + `Analyse` sends `{ target: files[1], model, mode: 'propose', force: true }`; queued/running job → status and `Cancel` (`jobs:cancel`); failed job without proposal → its `errorMessage` and `Analyse`; proposal → all chips on in the AI chip style, toggling one off and `Accept` sends only the remaining names, `Accept` disabled with none on; `Discard` calls `analysis:discardProposal`; stale proposal → `Accept` disabled, Discard and Analyse again available; accept/discard call `onChanged`; closing sends nothing; a job that finishes while open switches to the proposal without user action; not configured or no selectable model → `Analyse` disabled with a `title` and a button that navigates to `settings`.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** test file, `theme.test`, `pnpm typecheck`. Commit `feat(ui): add the tag proposal dialog`.

---

### Task 11: Prompt dialog (wave 2, after 7)

**Files:** Create `components/PromptDialog.tsx`; Test `test/renderer/prompt-dialog.test.tsx`.

```ts
PromptDialog(props: { open: boolean; file: FileRecord | null; onClose(): void })
```

- [ ] **Step 1 (tests first):** opens with the prompt default; `Generate` sends `analysis:describe` with a fresh `requestId`; while running the button is disabled and a Cancel button sends `analysis:cancelDescribe`; the text appears in a read-only field; `Copy` writes exactly the text to the clipboard; `{ ok: false, code }` shows the code's fixed message, `cancelled` shows nothing; closing while running cancels; reopening shows no old text; the text is kept in component state only (no `localStorage`, no context); not configured or no selectable model → `Generate` disabled with a `title` and a button that navigates to `settings`.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** test file, `theme.test`, `pnpm typecheck`. Commit `feat(ui): add the image to prompt dialog`.

---

### Task 12: Renderer wiring (wave 3, after 8–11)

**Files:** Modify `renderer/src/analysis.ts`, `file-actions.ts`, `jobs-context.tsx`, `AppShell.tsx`, `screens/InboxScreen.tsx`, `screens/AssetsScreen.tsx`, the asset selection panel and asset screen, `AssetFilesTab.tsx`, `FileBrowser` (toolbar, tile and row marker), `FileDetailDialog`, `labels.ts`; Tests in `test/renderer/`.

- [ ] **Step 1 (tests first):**
  - `Analyse` on one file (menu, selection of one, detail dialog) opens the result dialog; on several opens the start dialog with a `files` target; `Image to prompt` appears for one analysable image only.
  - after the start dialog's `onStarted` the existing result strip shows the counts (enqueued and each skip reason that is not zero).
  - `Analyse all` in inbox and Files tab passes the list's current `fileFilter` (scope, query, tags, role, kind); in the gallery the current `assetFilter`; the asset panel and asset screen pass `{ kind: 'asset' }`.
  - the proposal toggle sends `hasProposal: true` and disables `Analyse all`; a file with `hasProposal` shows the marker (tile, row, detail dialog) with a `title`; "Review tags" opens the result dialog; lists reload after accept/discard.
  - pause banner: shown when `summary.paused`, with the reason's fixed message and `Resume` (`jobs:resume`); a Settings button for the two configuration reasons; gone after resume.
  - not configured (no base URL): Analyse entries are disabled with a `title`.
  - `TEMP_MODEL` no longer exists (`grep` is part of the verification); the 4a strip-behind-the-dialog path is gone.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `pnpm typecheck`, `pnpm test`, `pnpm --filter @assetforge/desktop build`. Commit `feat(ui): start analyses by selection, asset and filter`.

---

### Task 13: Documentation (wave 3)

**Files:** `ReadMe.md` (§6, §8, §9.3, §14, §15.2, §16, §17, §18), `docs/backlog.md`, `.env.example`. (`CLAUDE.md` is git-ignored; the controller updates it.)

- [ ] **Step 1:** Describe what exists after Tasks 1–12, read from the code, not from this plan: settings and key storage, the origin rule, the model choice without a built-in model (§18: decision replaced), proposals, fingerprint and `force`, targets, Image2Prompt, the pause, the env override, the new mock options.
- [ ] **Step 2:** Backlog: remove the circuit-breaker entry, the provider debug line entry and the "Replaced by the phase 4b result dialog" section; add what the spec's non-goals and "My calls" leave open (no gallery multi-select, Image2Prompt outside the scheduler, pause not persisted, the two "before paid providers" items stay).
- [ ] **Step 3:** Commit `docs: describe phase 4b`.

---

## After the last task

Final whole-branch review on the most capable model, one fix wave, one scoped re-review; `pnpm typecheck`, `pnpm test`, desktop build on the final tree. Then the owner checks the real gateway in the running app (spec §8) before or after the merge, as they prefer.
