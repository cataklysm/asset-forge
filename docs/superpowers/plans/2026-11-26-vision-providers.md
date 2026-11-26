# Several Vision Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Several named Ollama-compatible provider entries side by side, chosen in the three analysis dialogs with their state visible, jobs bound to their provider with a pause per provider, and waiting jobs movable to another provider.

**Architecture:** Provider entries live at app level in `provider-settings.json` version 2 with one `safeStorage` key file per entry; a gateway keeps one adapter per entry. A job carries a generic *lane* (column `job.provider_id`); repository claim, scheduler limit, retry timer and pause gate all work per resource class and lane, so `packages/jobs` knows lanes and nothing about providers. Analysis jobs use the provider id as their lane and carry a copy of the provider name in payload v4; moving jobs is one transaction over the waiting rows of a lane.

**Tech Stack:** TypeScript, Zod, Drizzle + better-sqlite3, Electron (`safeStorage`), React, Vitest (+ jsdom).

**Spec:** `docs/superpowers/specs/2026-11-26-vision-providers-design.md`

## Global Constraints

- Everything in the repository is English. No attribution lines in commits. Implementers commit, they do not push.
- Never launch the app, never touch Docker, never call anything on port 11434. Tests use the in-process mock (`startMockProvider` from `docker/mock-provider/server.mjs`) and the key literals `test-key-not-real` and `test-key-not-real-2`. No real key in code, tests, logs or fixtures.
- A key never appears in IPC, logs, job rows, the database or the settings file. A request gets the key only for the entry it runs for and only while that entry's origin equals the origin its adapter was built for.
- Fixed messages only; never a URL, path or cause text in a message, a log line or a job row. Provider failures are logged with code, HTTP status and the provider id. New messages, exact:
  - `The provider name must have 1 to 60 characters` (`validation_failed`)
  - `A provider with this name already exists` (`invalid_operation`)
  - `No more than 10 providers` (`invalid_operation`)
  - `This provider does not exist` (`not_found`)
  - `This provider still has active jobs; move or cancel them first` (`invalid_operation`)
  - `Jobs cannot be moved onto the same provider` (`invalid_operation`)
  - Existing, unchanged: the base URL message, the "set by the environment" message, `credential_store_unavailable`, `JOB_ERROR_MESSAGES`.
- Values: provider name 1–60 after trim, unique regardless of case; at most `MAX_PROVIDERS = 10`, zero allowed; timeout 10–600 s, default 120; environment entry id `environment`, name `Environment`; the entry made by the upgrade is named `Ollama`; model list bound `min(entry timeout, 10 s)`.
- The fingerprint is unchanged: its provider is the adapter kind `OLLAMA_PROVIDER`, never an entry id.
- `core` and `contracts` do not depend on Electron or a concrete provider; `packages/jobs` contains no identifier or text with "provider" beyond what it has today.
- UI: no explanatory text in the layout (tooltips through `title`); buttons only from `ui.ts`; tokens only; labels in `apps/desktop/src/renderer/src/labels.ts`.
- **Author's calls** (not in the spec): the core field is `Job.lane` (column `provider_id`); every job has a lane and jobs without one share the lane `null`, so limits per lane equal today's behaviour for all other job types; the `null` lane of analysis jobs can be paused, resumed and used as a move source (label `No provider`); `provider_not_configured` becomes an IPC error code; `JobView` also carries `model`.
- **Waves.** Task 1 changes contracts and ports, so the repository-wide typecheck is red until the checkpoints. Each task's gate is its own test files plus `tsc` without errors in the files it owns. Tasks of one wave run in parallel in worktrees; the controller merges and runs the checkpoint.
  - Wave 1: Task 1.
  - Wave 2: Tasks 2, 3, 4, 5, 6, 8. **Checkpoint A** (after 2–5): tests and typecheck of `contracts`, `core`, `persistence`, `jobs`, `providers` green.
  - Wave 3: Tasks 7, 9, 10. **Checkpoint B**: `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build` green.
  - Wave 4: Task 11.
- Commands: `pnpm --filter @assetforge/<package> test <file>` (no `--`), `pnpm --filter @assetforge/<package> typecheck`, `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/persistence db:generate`. Known flaky test (re-run once): `inbox.test.tsx > filters and scroll offset survive navigation`.

## Review Focus

- A crash between the steps of the version 1 → 2 upgrade, and a leftover or orphaned key file at start: the old key ends on the upgraded entry only while that entry still has the origin it was entered for; otherwise it is deleted. Tests in Task 6.
- An entry is deleted and a new one created for another address while jobs of the old id wait in a workspace: they fail `provider_not_configured`, never run against the new entry, and no request carries the other entry's key. Tests in Tasks 6 and 7.
- A stopped pod that accepts the connection and never answers: `providers:listModels` answers `provider_timeout` within the bound, and the dialog shows `not reachable` instead of `checking` forever. Tests in Tasks 4 and 8.
- A provider selected in an open dialog is deleted, or its state answer arrives after the user switched to another provider: the dialog falls back to an existing entry, and a late answer never overwrites the model list of the entry now selected. Tests in Tasks 8 and 9.
- Moving jobs while the source lane is running one: the running job finishes on its old provider and is not counted; `moved` equals the rows changed; a second click moves 0. Tests in Tasks 2 and 10.

---

### Task 1: Contracts, ports and the in-memory job repository

**Files:**
- Create: `packages/contracts/src/provider-ref.ts`
- Modify: `packages/contracts/src/settings.ts`, `jobs.ts`, `errors.ts`, `ipc.ts`, `index.ts`; `packages/contracts/test/jobs.test.ts`, `settings.test.ts`, the IPC schema test; `packages/core/src/jobs.ts`, `ports.ts`, `errors.ts`; `packages/core/test/memory-jobs.ts` and its test

**Interfaces — produces (contracts):**
- `provider-ref.ts` (imports nothing from `jobs.ts`): `ENVIRONMENT_PROVIDER_ID = 'environment'`, `PROVIDER_NAME_MAX = 60`, `MAX_PROVIDERS = 10`, `ProviderIdSchema = z.union([z.uuid(), z.literal('environment')])`, `ProviderNameSchema = z.string().trim().min(1).max(60)`.
- `settings.ts`: remove `VisionSettingsViewSchema` and `SetVisionSettingsSchema`; keep the timeout constants, `VisionModelSchema`, `ListModelsResultSchema`. Add
  - `ProviderViewSchema { id: ProviderIdSchema, name: ProviderNameSchema, baseUrl: z.string(), timeoutSeconds, taggingModel: ModelNameSchema.nullable(), promptModel: ModelNameSchema.nullable(), hasApiKey: z.boolean() }`
  - `ProviderListSchema { providers: z.array(ProviderViewSchema).max(10), lastUsedId: ProviderIdSchema.nullable(), fromEnvironment: z.boolean(), canStoreKey: z.boolean() }`
  - `SaveProviderSchema { id: ProviderIdSchema.optional(), name: z.string().max(200), baseUrl: z.string().max(2000), timeoutSeconds, taggingModel, promptModel, apiKey: z.string().min(1).max(500).nullable().optional() }` (the host applies the name and URL rules)
- `jobs.ts`:
  - payload v4 in the union: `{ version: 4, model, mode, prompt: AnalyzeFilePromptSchema.nullable(), providerName: ProviderNameSchema }`
  - `analysisJobFields(payload: unknown): { providerName: string | null; model: string | null }` (v4 name; model of v2–v4; nulls otherwise or when unparseable)
  - `JobViewSchema` gains `providerId: ProviderIdSchema.nullable()`, `providerName: z.string().nullable()`, `model: ModelNameSchema.nullable()`
  - `PausedProviderSchema { providerId: ProviderIdSchema.nullable(), providerName: z.string().nullable(), reason: JobErrorCodeSchema }`; `JobSummarySchema.paused: z.array(PausedProviderSchema)`
  - `WaitingByProviderSchema { providerId: ProviderIdSchema.nullable(), providerName: z.string().nullable(), waiting: z.number().int().min(0) }`
- `errors.ts`: `ErrorCodeSchema` gains `provider_not_configured`.
- `ipc.ts`: remove the three `settings:*` channels. Add or change:
  - `providers:list` `{}` → `ProviderListSchema`; `providers:save` `SaveProviderSchema` → `ProviderViewSchema`; `providers:delete` `{ id: ProviderIdSchema }` → `z.object({})`; `providers:listModels` `{ providerId: ProviderIdSchema, refresh: z.boolean().optional() }` → `ListModelsResultSchema`
  - `analysis:preview`, `analysis:enqueue`, `analysis:describe`: optional `providerId: ProviderIdSchema`
  - `jobs:list`: optional `providerId: ProviderIdSchema`
  - `jobs:waitingByProvider` `{}` → `z.array(WaitingByProviderSchema)`
  - `jobs:resume` `{ providerId: ProviderIdSchema.nullable() }`
  - `jobs:reroute` `{ fromProviderId: ProviderIdSchema.nullable(), toProviderId: ProviderIdSchema, model: ModelNameSchema }` → `{ moved: z.number().int().min(0) }`

**Interfaces — produces (core):**
- `errors.ts`: `ProviderNotConfiguredError` (code `provider_not_configured`).
- `jobs.ts`: `Job.lane: string | null`, `NewJob.lane: string | null`.
- `ports.ts` `JobRepository`:
  - `claimNext(r: { resourceClass; types; now; excludeLanes?: readonly (string | null)[] })` — the oldest due job whose lane is not excluded
  - `nextRunAfter(types: readonly string[], excludeLanes?: readonly (string | null)[])`
  - `list(r: { limit; offset; status?; lane?: string })` — rows carry `providerId` (the lane), `providerName` and `model` from `analysisJobFields`
  - `waitingByLane(type: string): Promise<{ lane: string | null; waiting: number }[]>` — `queued` and `retry_wait`
  - `latestPayloadOfLane(type: string, lane: string | null): Promise<unknown | null>` — newest job of that lane in any status
  - `countActiveInLane(type: string, lane: string): Promise<number>`
  - `rerouteWaiting(r: { type: string; fromLane: string | null; toLane: string; rewrite: (payload: unknown) => unknown; now: string }): Promise<number>` — one transaction; every `queued`/`retry_wait` row: lane, rewritten payload, status `queued`, attempt 0, `runAfter` and error cleared
  - `assignLane(r: { type: string; lane: string; rewrite: (payload: unknown) => unknown | null; now: string }): Promise<number>` — every active row with lane `null`; `rewrite` answering `null` leaves the row as it is; status and attempt stay

- [ ] **Step 1: Write failing contract tests** in `packages/contracts/test/`:
  - `ProviderIdSchema` accepts a UUID and `'environment'`, refuses `''` and `'env'`.
  - v4 parses with `prompt: null` and with a prompt; v1–v3 still parse; `analysisJobFields` answers `{ providerName: 'RunPod', model: 'm' }` for v4, `{ providerName: null, model: 'm' }` for v2, both `null` for v1 and for `'x'`.
  - `jobs:summary` response with `paused: []` and with one item parses; `paused: null` is refused.
  - `jobs:reroute` refuses a missing `model` and accepts `fromProviderId: null`; `jobs:resume` refuses `{}`.
  - The `settings:getVision` channel no longer exists; `providers:save` accepts a request without `id` and without `apiKey`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/contracts test` — FAIL.
- [ ] **Step 3: Implement the contract changes** listed above. Run again — PASS; `pnpm --filter @assetforge/contracts typecheck` clean.
- [ ] **Step 4: Write failing tests for `InMemoryJobRepository`** (next to its existing test, or `packages/core/test/memory-jobs.test.ts`):
  - three jobs `a1`, `b1`, `a2` (lanes `a`, `b`, `a`): `claimNext` with `excludeLanes: ['a']` answers `b1`; with `['a', 'b']` answers `null`; with `[null]` skips a job without lane.
  - `nextRunAfter(types, ['a'])` ignores a `retry_wait` job of lane `a`.
  - `rerouteWaiting` from `a` to `b` moves a `queued` and a `retry_wait` job (attempt 0, `runAfter` null, payload from `rewrite`), leaves a `running`, a `failed` and a `cancelled` job of `a`, and answers 2; `fromLane: null` moves the jobs without lane.
  - `assignLane` sets the lane of active jobs without one, skips a row whose `rewrite` answers `null`, leaves finished rows.
  - `waitingByLane`, `countActiveInLane`, `latestPayloadOfLane`, and `list` with `lane` and with the three new view fields.
- [ ] **Step 5: Implement** the core types, the port and the in-memory repository. Run the test — PASS. (`packages/core` typecheck stays red in `analysis-enqueue.ts` until Task 5.)
- [ ] **Step 6: Commit** `feat: contracts and job ports for several vision providers`

---

### Task 2: Persistence — lane column and lane queries

**Files:**
- Create: `packages/persistence/migrations/0012_*.sql` (generated), `packages/persistence/test/migration-0012.test.ts`
- Modify: `packages/persistence/src/schema.ts`, `job-repository.ts`; `packages/persistence/test/job-repository.test.ts`

**Interfaces:**
- Consumes: the `JobRepository` port and `analysisJobFields` of Task 1.
- Produces: column `job.provider_id` (text, nullable), index `job_provider_id_status_idx` on (`provider_id`, `status`); the SQLite implementation of every port method of Task 1.

- [ ] **Step 1: Write the failing migration test** following `migration-0010.test.ts`: a database at `0011` with one `queued` and one `succeeded` job; after migrating both have `provider_id` null, the queued one is still claimed by `claimNext`, and the index exists.
- [ ] **Step 2: Write failing repository tests** — the same cases as Task 1 Step 4 against SQLite, plus:
  - `rerouteWaiting` whose `rewrite` throws on the second row changes no row (one transaction).
  - a job that is `running` in the source lane is untouched and not counted; a second `rerouteWaiting` answers 0.
  - `enqueue` stores the lane; `retry` keeps lane and payload.
- [ ] **Step 3: Run** `pnpm --filter @assetforge/persistence test job-repository` — FAIL.
- [ ] **Step 4: Implement.** Add the column and index to `schema.ts`, run `db:generate`, map `lane` in `toJob` and `enqueue`, implement the methods. `excludeLanes` must treat `null` separately from the string values (`IS NOT NULL` plus `NOT IN`).
- [ ] **Step 5: Run** `pnpm --filter @assetforge/persistence test` and `typecheck` — PASS.
- [ ] **Step 6: Commit** `feat: job lanes in the persistence layer`

---

### Task 3: Scheduler and pause gate per lane

**Files:**
- Modify: `packages/jobs/src/pause-gate.ts`, `scheduler.ts`; `packages/jobs/test/pause-gate.test.ts`, `scheduler.test.ts`

**Interfaces:**
- Consumes: `Job.lane`, `claimNext` with `excludeLanes`, `nextRunAfter(types, excludeLanes)`.
- Produces:
  ```ts
  interface PauseGate {
    reason(resourceClass: ResourceClass, lane: string | null): JobErrorCode | null;
    record(resourceClass: ResourceClass, lane: string | null, outcome: JobErrorCode | 'ok' | 'other'): void;
    resume(resourceClass: ResourceClass, lane: string | null): void;
    paused(resourceClass: ResourceClass): { lane: string | null; reason: JobErrorCode }[];
  }
  ```
  `createScheduler` keeps its signature. Limit, claim, retry timer and pause are per (resource class, lane): `excludeLanes` is the paused lanes plus the lanes that run `limits[class]` jobs.

- [ ] **Step 1: Write failing gate tests:** three `provider_unreachable` on lane `a` pause `a` and not `b`; `provider_unauthorized` pauses at once; an `ok` in between resets only its lane's count; `resume('local_gpu', 'a')` leaves a paused `b`; `paused('local_gpu')` lists both with their reasons; `onChange` fires on pause and resume.
- [ ] **Step 2: Write failing scheduler tests** (in-memory repository, fake timers as in the existing tests):
  - limit 1, jobs `a1`, `a2`, `b1`: `a1` and `b1` run at the same time, `a2` starts when `a1` settles.
  - lane `a` paused: `b` jobs keep running; `a` jobs stay `queued`; after `resume` and `wake` they run.
  - a `retry_wait` job in a paused lane does not arm the timer; one in a free lane does.
  - jobs without a lane behave as before (existing tests stay green unchanged, apart from the gate's new arguments).
  - a handler failing `provider_not_configured` pauses only its job's lane.
- [ ] **Step 3: Run** `pnpm --filter @assetforge/jobs test` — FAIL.
- [ ] **Step 4: Implement.** `ActiveRun` carries the lane; `pass()` loops per class: compute `excludeLanes`, claim, launch, repeat until `claimNext` answers `null`.
- [ ] **Step 5: Run** tests and `typecheck` of the package — PASS.
- [ ] **Step 6: Commit** `feat: scheduler limits and pauses per lane`

---

### Task 4: Bounded model list in the Ollama adapter

**Files:**
- Modify: `packages/providers/src/ollama-vision.ts`, `packages/providers/test/ollama-models.test.ts`

**Interfaces:**
- Produces: `LIST_MODELS_TIMEOUT_MS = 10_000`; `OllamaVisionOptions.listTimeoutMs?: number` (default `Math.min(timeoutMs, LIST_MODELS_TIMEOUT_MS)`); `listModels(signal)` rejects with `JobError('provider_timeout')` when `/api/tags` and all `/api/show` calls together exceed it. A caller abort stays what it is today.

- [ ] **Step 1: Write the failing tests** with an injected `fetch`: `/api/tags` answers at once and every `/api/show` never answers, `listTimeoutMs: 50` → rejects `provider_timeout` within 500 ms and `onFailure` gets `provider_timeout` once; a server that accepts and never answers `/api/tags` → the same; `timeoutMs: 5_000` without `listTimeoutMs` uses 5 s, `timeoutMs: 120_000` uses 10 s (assert through fake timers).
- [ ] **Step 2: Run** `pnpm --filter @assetforge/providers test ollama-models` — FAIL.
- [ ] **Step 3: Implement** one deadline for the whole call, combined with the caller's signal.
- [ ] **Step 4: Run** the package tests and typecheck — PASS.
- [ ] **Step 5: Commit** `feat: bound the whole model list request`

---

### Task 5: Core — provider on enqueue, run, move and assignment

**Files:**
- Create: `packages/core/src/analysis-payload.ts`, `packages/core/src/job-lanes.ts`, tests `packages/core/test/analysis-payload.test.ts`, `job-lanes.test.ts`
- Modify: `packages/core/src/analysis-enqueue.ts`, `analysis-handler.ts`, `jobs.ts`, `index.ts`; `packages/core/test/` tests of enqueue and handler; `packages/core/test/fakes.ts` if it builds jobs

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `rewriteForProvider(payload: unknown, to: { name: string; model: string }): AnalyzeFilePayload` — always v4 with `to.name` and `to.model`; mode and prompt kept (v1: `apply`, `prompt: null`; v2: `prompt: null`)
  - `adoptForProvider(payload: unknown, entry: { name: string; taggingModel: string | null }): AnalyzeFilePayload | null` — v4 with the payload's own model; v1 takes `entry.taggingModel`, `null` when there is none
  - `enqueueAnalysis(s, r)` and `previewAnalysis(s, r)`: `r` gains `entry: { id: string; name: string }` (preview ignores it beyond the signature); jobs get `lane: entry.id` and payload v4 with `providerName: entry.name`
  - `createAnalyzeFileHandler(deps: { session; vision: (lane: string | null) => VisionProvider | null; images; provider: string })` — `defaultModel` is removed; `vision(job.lane) === null` or a v1 payload → `JobError('provider_not_configured')`; v4 with `prompt: null` and v2 run with `ANALYSIS_PROMPT` and `LEGACY_TAG_LIMIT`
  - `rerouteJobs(s, r: { fromLane: string | null; to: { id: string; name: string }; model: string }): Promise<{ moved: number }>` — same lane → `InvalidOperationError('Jobs cannot be moved onto the same provider')`
  - `assignUnroutedJobs(s, entry: { id: string; name: string; taggingModel: string | null }): Promise<number>`
  - `listWaitingLanes(s): Promise<{ lane: string | null; payloadName: string | null; waiting: number }[]>`
  - `laneName(s, lane: string | null): Promise<string | null>` (name in the newest payload of that lane)
  - `countActiveAnalysisJobs(s, lane: string): Promise<number>`
  - `listJobs(s, r)` gains `lane?: string`

- [ ] **Step 1: Write failing tests:**
  - payload: the four versions through `rewriteForProvider` (v3 keeps its prompt object and mode `propose`; v2 becomes `prompt: null`); `adoptForProvider` for v1 with and without a tagging model, v2, v3.
  - enqueue: every job has `lane` and a v4 payload naming the entry; the fingerprint skip is unchanged for a second entry with the same model.
  - handler: `vision` is called with the job's lane; lane `x` answering `null` → `provider_not_configured` and no analysis written; a v1 payload → `provider_not_configured`; v4 `prompt: null` sends the legacy request and cuts at 20; v4 with a prompt cuts at its `maxTags` and records `promptName`.
  - lanes: `rerouteJobs` onto the same lane throws and changes nothing; from `null`; `moved` is the count; `assignUnroutedJobs` leaves a v1 row unassigned without a tagging model; `listWaitingLanes` includes a lane whose jobs are all `retry_wait` and carries the payload name; `laneName` answers `null` for a lane with only v2 rows.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/core test` — FAIL.
- [ ] **Step 3: Implement** the functions above.
- [ ] **Step 4: Run** the package tests and typecheck — PASS.
- [ ] **Step 5: Commit** `feat: analysis jobs carry their provider`

---

### Task 6: Main — provider store, gateway and `providers:*`

**Files:**
- Create: `apps/desktop/src/main/provider-store.ts`, `provider-gateway.ts`, `provider-handlers.ts`; tests `apps/desktop/test/provider-store.test.ts`, `provider-gateway.test.ts`, `provider-ipc.test.ts`
- Delete: `apps/desktop/src/main/vision-settings.ts`, `vision-gateway.ts`, `settings-handlers.ts` and their tests (`vision-settings.test.ts`, `vision-gateway.test.ts`, `settings-ipc.test.ts`) after their cases are carried over
- Untouched here: `composition.ts`, `ipc.ts`, `job-host.ts`, `job-handlers.ts`, `describe-controller.ts` (Task 7)

**Interfaces:**
- Consumes: Task 1; `usableBaseUrl` (`vision-config.ts`), `writeAtomic` (`atomic-file.ts`), `SecretCodec`, `createOllamaVision`.
- Produces:
  ```ts
  interface ProviderEntry { id: string; name: string; baseUrl: string; timeoutSeconds: number; taggingModel: string | null; promptModel: string | null }
  interface ProviderStore {
    list(): ProviderList;
    get(id: string): ProviderEntry | null;
    first(): ProviderEntry | null;
    /** A given id: that entry, else NotFoundError. Absent: the entry used last, else the first, else null. */
    resolve(id: string | undefined): ProviderEntry | null;
    /** Best effort; a failed write is swallowed. */
    markUsed(id: string): void;
    save(input: SaveProvider): ProviderView;
    delete(id: string): void;
    /** Null unless the entry exists, is not the environment entry, and its origin equals the origin of `baseUrl`. */
    apiKeyFor(id: string, baseUrl: string): string | null;
    /** Called with the entry id after every save and delete. */
    onChange(listener: (id: string) => void): void;
  }
  createProviderStore(o: { userData: string; secrets: SecretCodec; env: NodeJS.ProcessEnv }): ProviderStore
  createProviderGateway(o: { store: ProviderStore; create: typeof createOllamaVision; log: (line: string) => void }): {
    vision(id: string | null): VisionProvider | null;
    models(id: string, refresh: boolean, signal: AbortSignal): Promise<ListModelsResult>;
  }
  createProviderHandlers(store, gateway, guard: { hasActiveJobs(providerId: string): Promise<boolean> }): ProviderHandlers
  ```
- File `provider-settings.json` version 2: `{ version: 2, providers: ProviderEntry[], lastUsedId: string | null, adoptLegacyKey: { id: string; origin: string } | null }`. Key file `credentials/vision-api-key-<id>`.
- Fixed order of file operations:
  - **Upgrade** of a version 1 file with a base URL: write version 2 with one entry `Ollama` (new UUID) and `adoptLegacyKey: { id, origin }`, then rename `credentials/vision-api-key` to the entry's key file, then write the file with `adoptLegacyKey: null`. Without a base URL: write an empty version 2 and delete the legacy key file.
  - **Every start:** with `adoptLegacyKey` set, rename a present legacy key file only when the entry still exists with that origin, otherwise delete it, then clear the marker; a legacy key file without marker is deleted; a key file whose id is not in the list is deleted. Environment mode skips all of this and does not touch the stored file.
  - **Save with a changed origin:** delete the key file first, then write the settings. **Delete:** write the settings first, then delete the key file.
- Gateway: one adapter per entry, built with `apiKey: () => store.apiKeyFor(id, baseUrl)`, dropped when the store reports a change of that id; the model cache holds successes only and is per entry; a list answer that belongs to an earlier build of the entry is not cached. Log line `Vision provider <id> failed: <code>` with ` (HTTP <status>)` when there is one. `models` for an unknown id throws `NotFoundError('This provider does not exist')`.
- `providers:delete` asks `guard.hasActiveJobs` first and throws the fixed message; `providers:listModels` answers `{ ok: false, code }` for adapter failures.

- [ ] **Step 1: Write failing store tests** (with `FakeCodec`; cases of the old test carried over where they still apply):
  - upgrade: v1 with URL and key → one entry `Ollama`, `hasApiKey: true`, legacy file gone; v1 without URL → empty list, legacy key file deleted; a start with a prepared state "version 2 with marker + legacy key file" adopts the key; the same state with the entry's origin changed deletes it; a legacy key file without marker is deleted; an orphaned `vision-api-key-<uuid>` is deleted; a corrupt file is set aside → empty list.
  - save: create answers a UUID and appends; edit keeps position; name `'  '` and 61 characters → `validation_failed`; `runpod` beside `RunPod` → duplicate message, the same name on the entry itself is fine; an 11th entry → limit message; unknown id → `not_found`; unusable base URL → the existing message.
  - key: `apiKey` absent keeps, `null` deletes, a string replaces; a rename and a path change within the origin keep the key; a port change deletes it; `apiKeyFor(a, urlOfB)` and `apiKeyFor(a, oldUrlOfA)` after an origin change answer `null`; delete an entry and create one with the old URL → `hasApiKey: false`; a codec that cannot encrypt → `credential_store_unavailable` and nothing saved; the settings file never contains the key literal.
  - used last: `resolve(undefined)` answers the marked entry, the first after it was deleted, `null` for an empty list; `resolve('<unknown uuid>')` throws `not_found`; a failing write in `markUsed` does not throw.
  - environment: one entry `environment`/`Environment` with both models from `ASSETFORGE_VISION_MODEL`, `fromEnvironment: true`, `hasApiKey: false`; `save` and `delete` throw the existing message; the stored file and key files are byte-identical afterwards; `apiKeyFor('environment', url)` is `null`.
- [ ] **Step 2: Write failing gateway and handler tests:**
  - two entries with different keys against two `startMockProvider` instances requiring `test-key-not-real` and `test-key-not-real-2`: each mock's recorded requests carry only its own bearer; after entry A's address is saved to mock B's URL, mock B receives no `Authorization` from A.
  - an adapter obtained before a save answers with a key of `null` for the new origin (stale adapter); `vision('<deleted id>')` and `vision(null)` are `null`.
  - `models(id, false)` is served from the cache, `refresh: true` asks again, a failure is not cached, saving entry A clears only A's cache.
  - a log line contains the id and the code and neither the URL nor the key.
  - handlers: all four channels answer without a workspace manager; `providers:delete` with `hasActiveJobs → true` throws the fixed message and keeps the entry; requests are validated (`providers:save` with timeout 5 → `invalid_request` through the IPC layer test helper used by the old `settings-ipc.test.ts`).
- [ ] **Step 3: Run** `pnpm --filter @assetforge/desktop test provider-` — FAIL.
- [ ] **Step 4: Implement** store, gateway and handlers; delete the three old modules and their tests.
- [ ] **Step 5: Run** the three test files — PASS; `tsc` reports no error in the three new modules.
- [ ] **Step 6: Commit** `feat: provider store with one key per entry, gateway and settings channels`

---

### Task 7: Main — jobs, analysis and describe per provider

**Files:**
- Modify: `apps/desktop/src/main/job-host.ts`, `job-handlers.ts`, `describe-controller.ts`, `composition.ts`, `ipc.ts`, `index.ts` if it names the old services; `apps/desktop/test/analysis-harness.ts`, `analysis-acceptance.test.ts`, `jobs-ipc.test.ts`, `describe.test.ts`, `ipc.test.ts`, `idle-job-host.ts`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `JobHostDeps { manager; vision: (lane: string | null) => VisionProvider | null; images; provider: string; pause: PauseGate; firstEntry: () => { id: string; name: string; taggingModel: string | null } | null; limits? }`
  - `JobHost.paused(): { lane: string | null; reason: JobErrorCode }[]`, `JobHost.resume(lane: string | null): void`
  - `workspaceOpened` runs `assignUnroutedJobs` with `firstEntry()` (skipped when `null`) before the scheduler starts
  - `createDescribeController({ manager, vision: (providerId: string) => VisionProvider | null, images })`, `describe(r: { requestId; fileId; model; prompt; providerId })`
  - `createJobHandlers(manager, jobs, describe, prompts, providers: ProviderStore)`
  - `AppServices.providers: ProviderHandlers` replaces `settings`; the store's `onChange(id)` resumes only lane `id`
- Rules:
  - `analysis:preview`, `enqueue`, `describe` resolve the entry with `providers.resolve(r.providerId)` inside `manager.read`, so `no_workspace_open` wins; `null` → `ProviderNotConfiguredError` for preview and enqueue, and for describe `{ ok: false, code: 'provider_not_configured' }` as today; an accepted enqueue or describe (not `busy`) calls `providers.markUsed`.
  - `jobs:list`: `providerName` is the current entry name when the entry exists, else the row's payload copy.
  - `jobs:summary.paused` and `jobs:waitingByProvider`: name from the entry, else `laneName`/`payloadName`, else `null`.
  - `jobs:reroute`: `toProviderId` through `providers.get` → `not_found`; then `rerouteJobs`, `jobs.changed()`, `jobs.wake()`. The target's pause is not lifted.
  - `guard.hasActiveJobs`: `countActiveAnalysisJobs > 0` in the open workspace, `false` without one.

- [ ] **Step 1: Extend the harness:** `createHarness` saves provider entries through `providers:save`; a helper starts a second mock.
- [ ] **Step 2: Write failing tests:**
  - acceptance, two mocks with keys `test-key-not-real` and `test-key-not-real-2`, one entry each: files queued for A and for B are analysed by their own mock (recorded requests), run at the same time (one per lane), and neither mock ever sees the other's bearer.
  - mock A closed: lane A pauses after three failures while B's jobs finish; `jobs:summary.paused` is `[{ providerId: A, providerName: 'A', reason: 'provider_unreachable' }]`; `jobs:reroute` A → B with B's model moves the waiting jobs, they succeed on B, `moved` matches, and a second call answers 0.
  - entry A deleted from a second workspace's point of view (delete while no workspace is open, reopen): its jobs fail `provider_not_configured`, the lane is paused with the payload's name, a new entry with A's old name gets none of them, reroute from the gone id works.
  - a database with a v1, a v2 and a v3 active job and no lane: after open all three belong to the first entry with v4 payloads (v1 with its tagging model); with an empty list they stay and fail `provider_not_configured` on lane `null`; `jobs:resume { providerId: null }` resumes that lane.
  - `analysis:enqueue` without `providerId` uses the entry used last, then the first; unknown id → `not_found`; no entry → `provider_not_configured`; no workspace → `no_workspace_open` even with an unknown id; `providers.list().lastUsedId` follows an accepted enqueue and describe, not a `busy` describe.
  - `providers:delete` is refused while that entry has a queued job and passes after `jobs:cancelAll`.
  - `jobs:list` with `providerId` filters; rows show the renamed entry's current name; `jobs:reroute` onto the same id → `invalid_operation`; saving entry A resumes A and leaves a paused B paused.
  - describe runs against the chosen entry's mock with that entry's key.
- [ ] **Step 3: Run** `pnpm --filter @assetforge/desktop test analysis-acceptance jobs-ipc describe` — FAIL.
- [ ] **Step 4: Implement** the wiring.
- [ ] **Step 5: Run** all main-side tests of `apps/desktop` (everything outside `test/renderer`) — PASS; `tsc` reports no error under `src/main`.
- [ ] **Step 6: Commit** `feat: jobs, analysis and describe run per provider`

---

### Task 8: Renderer — provider context, selects, gate and Settings section

**Files:**
- Create: `apps/desktop/src/renderer/src/components/ProviderSelect.tsx`, `components/ProviderSettings.tsx`; tests `apps/desktop/test/renderer/provider-select.test.tsx`, `provider-settings.test.tsx`
- Modify: `provider-context.tsx`, `provider-gate.ts`, `components/ModelSelect.tsx`, `screens/SettingsScreen.tsx`, `labels.ts`; `test/renderer/fake-api.ts`, `provider-gate.test.tsx`, `settings.test.tsx`

**Interfaces:**
- Consumes: Task 1 channels.
- Produces:
  ```ts
  type ProviderStatus = 'checking' | 'ready' | 'unreachable' | 'unauthorized' | 'no_vision_model' | 'error';
  interface ProvidersState {
    list: ProviderList | null; loading: boolean; failed: boolean;
    models: Readonly<Record<string, ListModelsResult | undefined>>;
    reload(): Promise<void>;
    loadModels(id: string, refresh?: boolean): Promise<void>;
    /** Asks every entry with `refresh: true`, in parallel. */
    checkAll(): void;
    save(input: SaveProvider): Promise<ProviderView>;
    remove(id: string): Promise<void>;
    noteUsed(id: string): void;
  }
  useProviders(): ProvidersState                       // provider component keeps the name ProviderSettingsProvider
  providerStatus(state: ProvidersState, id: string): ProviderStatus
  defaultProviderId(state: ProvidersState): string | null     // lastUsedId when still listed, else the first
  defaultModelOf(state: ProvidersState, id: string | null, purpose: 'tagging' | 'prompt'): string | null
  providerGate(state: ProvidersState, providerId: string | null, model: string | null): { blocked: string | null; offerSettings: boolean }
  <ProviderSelect value onChange disabled? exclude? />     // options "<name> — <state>"; opening it calls checkAll
  <ModelSelect providerId purpose value onChange disabled? />
  fakeProviders(...) in fake-api.ts                    // default handlers for the four providers:* channels
  ```
- Status: no answer yet or a request running → `checking`; `ok` with at least one model whose `vision` is not `false` → `ready`; `ok` otherwise → `no_vision_model`; `provider_unreachable`, `provider_timeout`, `provider_unavailable` → `unreachable`; `provider_unauthorized` → `unauthorized`; every other code → `error`.
- Labels (in `labels.ts`): `PROVIDER_STATE_LABELS = { checking: 'checking', ready: 'ready', unreachable: 'not reachable', unauthorized: 'key refused', no_vision_model: 'no vision model', error: 'error' }`, `PROVIDER_LABEL = 'Provider'`, `NO_PROVIDER = 'No provider'`.
- An answer for entry X is stored under X only, and only when it is the latest request for X.
- Settings section: built like `PromptSettings` — list on the left in store order, editor on the right (name, base URL, API key, timeout, the two `ModelSelect`s of the entry being edited, state line), `Save`, `Delete` (through `ConfirmDialog`), `New`; read-only with `fromEnvironment`; `New` disabled at 10 entries with the limit as tooltip.

- [ ] **Step 1: Write failing tests:**
  - context/select: options show `Local — not reachable` and `RunPod — ready` from two fake answers; `checking` before the answer; opening the select sends `providers:listModels` with `refresh: true` once per entry; a slow answer for A arriving after B was requested leaves B's models untouched; an answer that never resolves keeps `checking` only until the fake rejects with `provider_timeout`, then `not reachable`.
  - `defaultProviderId`: last used; first when `lastUsedId` names no entry; `null` for an empty list.
  - gate: per selected entry — blocked with the matching label for `checking`, unreachable, unauthorized (offers Settings), a model missing from that entry's list, a model that is not a vision model; `providerId: null` → the existing not-configured message with Settings; a failed `providers:list` → `SETTINGS_LOAD_FAILED`.
  - settings: the list shows the entries in order; selecting one fills the editor; Save sends `providers:save` with `id` and without `apiKey` when the key field was not touched, with `apiKey: null` after the clear action; New then Save sends no `id`; a refused save shows the message; Delete asks first and sends `providers:delete`; environment mode shows the entry with every control disabled.
- [ ] **Step 2: Run** the four test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them — PASS; `tsc` reports no error in the files of this task. (The three dialogs do not compile until Task 9.)
- [ ] **Step 5: Commit** `feat: provider list in settings, provider select and state`

---

### Task 9: Renderer — provider in the three analysis dialogs

**Files:**
- Modify: `components/AnalysisStartDialog.tsx`, `AnalysisResultDialog.tsx`, `PromptDialog.tsx`, `AnalysisDialogs.tsx`; tests `analysis-start-dialog.test.tsx`, `analysis-result-dialog.test.tsx`, `prompt-dialog.test.tsx`, `analysis.test.tsx`

**Interfaces:**
- Consumes: Task 8.
- Behaviour, the same in all three:
  - a `ProviderSelect` before the model select; initial value `defaultProviderId`; the model starts as `defaultModelOf` for the dialog's purpose (`tagging` for the start and result dialogs, `prompt` for Image to prompt).
  - opening the dialog calls `checkAll()` once.
  - choosing another provider sets the model to that entry's default for the purpose (or none) and shows that entry's model list.
  - when the selected id leaves the list, the selection falls back to `defaultProviderId`.
  - `providerGate(state, providerId, model)` decides Start and the Settings button.
  - every request carries `providerId`; after an accepted request `noteUsed(providerId)`.

- [ ] **Step 1: Write failing tests** per dialog: the select shows both entries with states and preselects the one used last; switching swaps the model list and preselects the other entry's default; Start is disabled with `not reachable` as tooltip for a down provider and enabled after switching to the ready one; the request (`analysis:preview`/`enqueue` or `describe`) carries the selected `providerId`; an entry removed from the list while the dialog is open → the selection moves to the remaining entry; no entry → the not-configured state with the Settings button.
- [ ] **Step 2: Run** the dialog tests — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them — PASS; `tsc` reports no error in the four components.
- [ ] **Step 5: Commit** `feat: choose the provider in the analysis dialogs`

---

### Task 10: Renderer — pause banner per provider, Jobs screen and move dialog

**Files:**
- Create: `components/MoveJobsDialog.tsx`, test `apps/desktop/test/renderer/move-jobs-dialog.test.tsx`
- Modify: `components/AppShell.tsx`, `components/WorkspaceShell.tsx`, `screens/JobsScreen.tsx`, `jobs-context.tsx` if it types the summary, `labels.ts`; tests `shell.test.tsx`, `jobs-screen.test.tsx`, `jobs-context.test.tsx`, `fixtures.ts`

**Interfaces:**
- Consumes: Task 8; channels `jobs:summary`, `jobs:resume`, `jobs:waitingByProvider`, `jobs:reroute`, `jobs:list` of Task 1.
- Produces:
  - `AppShell` props `paused: PausedProvider[]`, `onResume(providerId: string | null)`, `onMove(providerId: string | null)`
  - `<MoveJobsDialog source={string | null | undefined} onClose />` — `undefined`: the source is a select over the lanes of `jobs:waitingByProvider`; otherwise fixed. Target: `ProviderSelect` without the source; model: the target's `ModelSelect`, preselecting its tagging default; the waiting count of the source; `Cancel`, `Move`.
- Labels: `MOVE_JOBS_LABEL = 'Move jobs'`, `MOVE_LABEL = 'Move'`, `MOVE_FROM = 'From'`, `MOVE_TO = 'To'`, `WAITING_COUNT = (n) => \`${n} waiting\``, `JOBS_PROVIDER_HEADER = 'Provider'`. A lane without a name shows `NO_PROVIDER` for id `null` and `Removed provider` otherwise.
- Rules: `Move` is disabled with a tooltip while the target is not `ready` (its state label), no model is chosen, the count is 0 or a request runs; after a move the dialog closes and `jobs.refresh()` runs; a refusal shows its message in the dialog. The banner shows one line per paused provider: name, the reason's message, `Resume`, `Move jobs`, and `Settings` for `provider_unauthorized` and `provider_not_configured`. Jobs screen: a `Provider` column showing name and model, a provider filter (`All providers` plus the entries) sent as `providerId`, `Move jobs` in the toolbar.

- [ ] **Step 1: Write failing tests:**
  - shell: two paused providers → two lines with their names; `Resume` on the second sends `jobs:resume { providerId: B }`; `Move jobs` opens the dialog with that source fixed; `Settings` only on the unauthorized line; `paused: []` → no banner; a line with `providerName: null` shows `Removed provider`.
  - jobs screen: the Provider column shows `RunPod` and the model; the filter sends `providerId`; `Move jobs` opens the dialog with a source select.
  - move dialog: shows `312 waiting` from `jobs:waitingByProvider`; the target select omits the source; `Move` disabled with `not reachable` for a down target and without a model; `Move` sends `{ fromProviderId, toProviderId, model }` once on a double click; a source with id `null` is sent as `null`; a refusal stays visible; a count of 0 disables `Move`.
- [ ] **Step 2: Run** the four test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them — PASS; `tsc` reports no error in the files of this task.
- [ ] **Step 5: Commit** `feat: pause banner per provider and moving waiting jobs`

---

### Task 11: Documentation

**Files:**
- Modify: `ReadMe.md` (provider settings, jobs and pause, the IPC list; §18 only if an open decision there is answered by the spec), `docs/backlog.md`

- [ ] **Step 1:** Update the ReadMe sections to the behaviour of the spec and the author's calls in Global Constraints.
- [ ] **Step 2:** In `docs/backlog.md` remove the request "Several vision providers" and add a section "Several vision providers" with what is deferred: the spec's non-goals; jobs in workspaces that are not open are not checked when an entry is deleted; unassigned jobs are assigned only on workspace open, not when the first entry is created; the key's origin binding still lives in the plaintext settings file (existing entry, now per entry); update the note on the provider id routes (`OLLAMA_PROVIDER` stays the one adapter kind).
- [ ] **Step 3: Commit** `docs: several vision providers`
