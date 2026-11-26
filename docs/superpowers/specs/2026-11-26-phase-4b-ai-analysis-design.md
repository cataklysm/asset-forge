# Phase 4b — AI analysis with the owner's Ollama — design

Date: 2026-11-26. Second half of phase 4 (ReadMe §6, §8, §9.3, §15.2, §15.3, §16, §17). Builds on phase 4a (`2026-11-26-phase-4a-jobs-design.md`): the job queue, the scheduler, the `vision.analyze_file` job, the Ollama-compatible adapter and the mock provider exist.

## Intent

The owner wants to tag their images with the vision model that runs on their own Ollama instance, which sits behind an API-key gateway. They want to choose the model themselves, per function and per run, because models differ in speed and quality and they want to compare them. For a single image they want to see what the model proposes and drop tags before anything is written; for many images the AI tag colour is enough. They do not want to pay for the same analysis twice, and they want a text that describes an image precisely enough to be used as a generation prompt, without that text being stored anywhere.

## Goals

- Provider settings in the app: base URL, API key, timeout, a default model for tagging and a default model for Image2Prompt. No model is built in.
- The model list comes from the server; the model can be changed at every start.
- The API key is stored only through Electron `safeStorage` and never leaves the main process again.
- A single image is analysed into a stored **proposal** that waits until the owner accepts (all or some tags) or discards it, also across restarts.
- Batch analysis from a file selection, from one asset, or from "everything the current filter shows", through one start dialog that shows what will be skipped.
- Fingerprint skip: content already analysed with the chosen model and the current prompt version is skipped unless the owner asks for a re-analysis.
- Image2Prompt: a descriptive text for one image, shown and copyable, never stored.
- The analysis queue pauses itself when the provider is down or refuses the key, instead of burning through every job.

## Non-goals

- Multi-select in the asset gallery. "From an asset selection" means the one selected asset; several assets go through the filter. *(My call.)*
- More than one provider, a provider list, capabilities other than vision, a cost limit, per-provider concurrency settings. The resource class stays `local_gpu` with limit 1.
- A stored image description, a stored prompt, a history of proposals, a review status on tags.
- One AI tag set per model. A file has one AI tag set; a new analysis replaces it.
- Shipping or starting Ollama; pulling, loading or unloading models; `keep_alive` control.
- The two backlog items marked "before paid providers" (cancel without a scheduler, `workspace:remove` restarting the scheduler). Local analysis is free; they stay in the backlog.
- Changing the tagging prompt or the 20-tag cap.

## Anti-goals

- The API key in the repository, a test, a log line, a job row, a job payload, `file_analysis`, an error message, or any IPC response.
- The API key sent to a host other than the one it was entered for.
- A silent plaintext fallback when `safeStorage` cannot encrypt.
- A model the owner did not choose being used for a request.
- An analysis that changes a manual tag, a workflow step or an asset status.
- An automated test or agent that calls the owner's real gateway (host port 11434).

## Constraints

- Architecture rules of `CLAUDE.md`: `core` and `contracts` know no Electron and no concrete provider; the key is decrypted only in the desktop host and handed to the adapter per request.
- UI rules: no explanatory text in the layout (tooltips through `title`), every button from `ui.ts`, tokens only.
- `AssetForgeError` and `JobError` messages are fixed texts; no cause, URL, path or body in them.
- Short DB transactions; nothing network-bound inside one.
- One row per file in `file_analysis` stays: it is the provenance of the AI tags the file carries now.

## Approaches

**Where a waiting proposal lives.** (a) A new table next to `file_analysis`; the job succeeds as soon as the proposal is stored. (b) A new job status "waiting for review". (c) A state column on `file_analysis`. Chosen with the owner: the proposal belongs to the file, not to the job — (a). It keeps the technical job status apart from the owner's decision, jobs never stay open indefinitely, and `file_analysis` keeps describing the tags that are actually on the file (with (c), a discarded proposal would overwrite that provenance).

**Where settings and key live.** (a) App-wide in `userData`: a settings file plus the key encrypted by `safeStorage` in `userData/credentials/` (ReadMe §9.3). (b) Per workspace in the database. Chosen: (a). A workspace database is copied and backed up; a secret does not belong there, and the key is tied to the machine anyway.

**How Image2Prompt runs.** (a) A direct, cancellable request without a job. (b) A job. Chosen: (a). A job would have to keep the text in the job table, which the owner explicitly does not want. The cost: it does not pass through the scheduler's `local_gpu` limit, so it can overlap with one running analysis; Ollama queues requests itself.

**How the model reaches a job.** (a) In the job payload, chosen at enqueue. (b) Read from the settings when the job runs. Chosen: (a). The owner picks the model per start, and a queued batch must not change its model because a setting changed in between.

## Design

### 1. Provider settings and the key

App-level, independent of any workspace.

- **Settings file** `userData/provider-settings.json`, its own module, written atomically. Not `settings.json`: that file is owned and rewritten by the workspace registry. Content: `{ version: 1, vision: { baseUrl: string | null, timeoutSeconds: number, taggingModel: string | null, promptModel: string | null } }`. `timeoutSeconds` 10–600, default 120. An unreadable file is renamed aside (same pattern as the registry) and treated as empty.
- **Base URL**: the rule of 4a's `vision-config.ts` (http or https, no user info, no query, no fragment, also not a bare `?`/`#`). Private and loopback addresses are allowed on purpose; this is the owner's own server.
- **Key** in `userData/credentials/vision-api-key`, the bytes `safeStorage.encryptString` returns. Never written when `safeStorage.isEncryptionAvailable()` is false: saving a key then fails with the new `AssetForgeError` code `credential_store_unavailable`; URL and models can still be saved. A file that cannot be decrypted counts as "no key".
- **The key is bound to the origin it was entered for.** When a save changes the origin (scheme, host, port) of the base URL and carries no new key, the stored key is deleted.
- The key is sent as `Authorization: Bearer <key>` and only by the adapter, only to the configured base URL; redirects are already refused (4a). No key → no header.
- **Environment override** for development and tests: when `ASSETFORGE_VISION_BASE_URL` is set, it and `ASSETFORGE_VISION_MODEL` (both functions) replace the stored settings, no key is sent, and the settings screen is read-only. The 4a defaults (`http://127.0.0.1:11500`, `mock-vision`) no longer apply when the variable is unset: without stored settings the provider is simply not configured.
- Settings take effect for the next request; no restart. Saving settings resumes a paused queue (§6).

IPC (no open workspace needed):

| Channel | Request | Response |
| --- | --- | --- |
| `settings:getVision` | `{}` | `{ baseUrl, timeoutSeconds, taggingModel, promptModel, hasApiKey, fromEnvironment, canStoreKey }` |
| `settings:setVision` | `{ baseUrl, timeoutSeconds, taggingModel, promptModel, apiKey? }` — `apiKey` absent: keep, `null`: delete, string (1–500 chars): replace | the same view as `getVision` |
| `settings:listVisionModels` | `{ refresh?: boolean }` | `{ ok: true, models: { name, vision: boolean \| null }[] } \| { ok: false, code: JobErrorCode }` |

`listVisionModels` uses the *stored* settings (the screen saves before it tests). The main process caches the list until settings change or `refresh` is true.

### 2. Models

- The adapter gains `listModels`: `GET /api/tags`, then `POST /api/show` per model for its `capabilities` (at most 100 models, 4 at a time, 10 s each, responses capped like every other one). `vision` is `true`/`false` when the server reports capabilities, `null` when it does not (older servers, a failed or blocked `show`); a failing `show` never fails the list. The owner's gateway is known to pass `/api/tags`.
- Models with `vision: false` are shown but cannot be chosen. `true` first, then `null`, by name.
- No model name appears in code as a default. A request without a model is impossible by type: the model is a required argument of every provider call.
- A model name is 1–200 characters, stored and sent verbatim.
- The request body stays as in 4a (no `think` field); only `message.content` is read. *(My call: the owner's gateway disables thinking for `qwen3.5:9b`; a model that answers with thinking still puts its answer in `content`.)*

### 3. Provider port

`VisionProvider` (core port) changes to per-call models and gains two methods; the adapter instance no longer binds a model:

```ts
interface VisionProvider {
  analyzeImage(r: { image: Uint8Array; prompt: string; schema: unknown; model: string; signal: AbortSignal }): Promise<unknown>;
  describeImage(r: { image: Uint8Array; prompt: string; model: string; signal: AbortSignal }): Promise<string>;
  listModels(signal: AbortSignal): Promise<{ name: string; vision: boolean | null }[]>;
}
```

The host owns a `VisionGateway` with `current(): VisionProvider | null` that builds the adapter from the settings in force (base URL, timeout, key provider). `null` means not configured. Handlers and IPC handlers ask the gateway at the moment they need it.

New `JobErrorCode`s, both not retryable, with fixed messages: `provider_unauthorized` (HTTP 401 or 403) and `provider_not_configured` (no base URL, or the gateway returns `null`). Every provider failure also writes one main-console line with the code and, if there is one, the HTTP status — never the URL, a header or the body.

### 4. Analysis jobs, fingerprint, proposals

**Payload v2**: `{ version: 2, model: string, mode: 'apply' | 'propose' }`. v1 rows left in a queue (`{ version: 1 }`) still run: mode `apply` with the tagging default model at run time, `provider_not_configured` if there is none. The dedupe key stays `vision.analyze_file:<fileId>`: one active analysis per file.

**Fingerprint.** A file counts as *analysed with model M* when its content hash, the provider id, M and `ANALYSIS_PROMPT_VERSION` equal either its `file_analysis` row or its waiting proposal. Checked at enqueue; the new skip reason is `already_analysed`. `force: true` at enqueue bypasses it — that is the deliberate re-analysis.

**Proposal table** (migration `0007`): `file_analysis_proposal` with `file_id` (primary key, FK `file.id`), `sha256`, `provider`, `model`, `prompt_version`, `tags` (JSON array of `{ name, displayName }`, already cleaned, at most 20), `created_at`. One per file; a new proposal replaces the old one.

**Handler.**
- Mode `apply`: as in 4a, with the payload's model in `file_analysis`. It also deletes a waiting proposal of the file in the same transaction (the newer result wins).
- Mode `propose`: same request and cleaning; instead of touching tags it stores the proposal (same `complete` + `sha256` check as `apply`, else `file_unavailable`). Tags and `file_analysis` stay untouched.

**Accept / discard** (core use cases, each one short transaction):
- `acceptProposal(fileId, names)`: `names` is a non-empty subset of the proposal's normalised tag names. It applies exactly these tags with the rules of `apply` (replace the file's AI tags, manual wins, reindex), writes `file_analysis` from the proposal, deletes the proposal. If the file's hash no longer equals the proposal's, the proposal is deleted and the call fails with `invalid_operation`.
- `discardProposal(fileId)`: deletes it. Idempotent.

**Targets.** One discriminated union says what to analyse:

```ts
type AnalysisTarget =
  | { kind: 'files'; fileIds: string[] }            // 1–1000, as today
  | { kind: 'fileFilter'; filter: FileListFilter }   // the filter part of files:list (scope, query, tagNames, role, kind)
  | { kind: 'asset'; assetId: string }
  | { kind: 'assetFilter'; filter: AssetListFilter } // the filter part of assets:list
```

For `asset` the files are all analysable files of the asset. For `assetFilter` they are the analysable files of the matching assets; when the filter has `fileRole` or `fileKind`, only the files that themselves have that role or kind (the owner filtered to those files). `query` and `tagNames` select assets and do not narrow the files. Analysable is 4a's `isAnalysable`.

IPC (workspace needed):

| Channel | Request | Response |
| --- | --- | --- |
| `analysis:preview` | `{ target, model }` | `{ analysable, alreadyAnalysed, alreadyQueued, notAnalysable }` |
| `analysis:enqueue` (replaces 4a's shape) | `{ target, model, mode, force }` | `{ enqueued, skipped: { notFound, notAnalysable, alreadyQueued, alreadyAnalysed } }` |
| `analysis:getProposal` | `{ fileId }` | `{ proposal: { model, createdAt, stale, tags: { name, displayName }[] } \| null, job: JobView \| null }` |
| `analysis:acceptProposal` | `{ fileId, names }` | `{}` |
| `analysis:discardProposal` | `{ fileId }` | `{}` |

- `mode: 'propose'` is accepted only for a `files` target with exactly one id, and it implies `force`.
- The enqueue result carries counts, not a per-file list: a filter target can cover a whole workspace.
- Filter targets are resolved in the main process by a keyset-paged repository enumeration; jobs are inserted in chunks of at most 500 per transaction. The whole id set is never held by the renderer and never sent over IPC.
- `getProposal.job` is the file's active or latest analysis job (for the dialog's running/failed state); `stale` is true when the file's hash differs from the proposal's.
- `FileRecord` gains `hasProposal: boolean`; `files:list` gains the optional filter `hasProposal`. It is a list filter only and not part of `FileListFilter` in a target: while the proposal toggle is on, `Analyse all` is disabled (a batch over waiting proposals would silently replace what the owner is about to review).

### 5. Image2Prompt

- `analysis:describe` `{ requestId: uuid, fileId, model }` → `{ ok: true, text } | { ok: false, code: JobErrorCode | 'cancelled' | 'busy' }`; `analysis:cancelDescribe` `{ requestId }` → `{}`.
- Main process: 1024 px JPEG from the media pool (as for analysis), `describeImage` with `IMAGE_PROMPT` (a constant in core: one English paragraph that describes subject, materials, colours, lighting, view and style precisely enough to recreate the image; no preamble, no list). One request at a time (`busy` otherwise). Aborted by `cancelDescribe`, by closing the workspace and on quit.
- The text is trimmed and cut at 4000 characters. It is not stored, not logged and not part of any job.

### 6. Queue pause

- Consecutive job runs of a resource class that end with a "provider is down" code are counted: `provider_unreachable`, `provider_unavailable` (5xx and 429 — what a gateway answers when the Ollama behind it is down) and `provider_timeout`. A success or any other outcome resets the count. At **3** the class pauses; the pause reason is the last code. One run ending with `provider_unauthorized` or `provider_not_configured` pauses it at once.
- A paused class claims nothing: `queued` jobs stay queued, `retry_wait` jobs keep their attempt count and wait. Running jobs finish. The job that tripped the pause follows its normal path (retry or failed).
- The pause belongs to the app session, not to one scheduler instance: the job host holds it and hands it to every scheduler it creates, so closing, opening or switching a workspace keeps the queue paused. It ends only through Resume, through saving the vision settings, or with the app (it is not persisted; a restart starts unpaused).
- `jobs:summary` gains `paused: { reason: JobErrorCode } | null` (for `local_gpu`); new channel `jobs:resume` `{}` → `{}`. Saving the vision settings also resumes.

### 7. Renderer

**Settings screen** (new navigation entry `Settings`): base URL, API key (write-only field; shows only whether one is stored, with a Remove button), timeout, a model select for tagging and one for Image2Prompt, `Save`, and `Test connection` (saves, then loads the model list; the outcome is shown as the list or as the error's fixed message). Read-only when `fromEnvironment`. When `canStoreKey` is false the key field is disabled with a tooltip.

**Model select** (shared component): the server's model list with non-vision models disabled, a refresh button, and the fitting default preselected. Used by the settings screen and the three dialogs.

**Not configured**: when no base URL is stored, or the function's dialog has no selectable model, the start buttons are disabled with a tooltip, and the dialogs offer a button to the settings screen.

**Start dialog** (batch; opened by Analyse on more than one file, by Analyse on an asset, and by "Analyse all"): model select (tagging default), the counts from `analysis:preview` (to analyse, already analysed with this model, already queued, not analysable; refreshed when the model changes), a checkbox "Analyse again" (`force`), `Start`. Start enqueues with mode `apply`, closes, and shows the counts in the existing result strip.

**Result dialog** (single image; opened by Analyse on exactly one file — menu, selection of one, file detail dialog — and by "Review tags" on a file with a proposal). It opens on top of the file detail dialog. States, driven by `analysis:getProposal` and the jobs context:
- nothing yet: model select, `Analyse`;
- queued/running: status, `Cancel`;
- failed: the fixed error message, `Analyse` again;
- proposal: the proposed tags as toggle chips in the AI colour (all on), the model it came from, `Accept` (disabled with none on), `Discard`, and model select + `Analyse again`; a stale proposal can only be discarded or redone.
Closing the dialog changes nothing. This replaces 4a's behaviour where a single file's result strip appeared behind the detail dialog.

**Prompt dialog** (Image2Prompt; file menu and file detail dialog, images only): model select (prompt default), `Generate`, the text in a read-only field, `Copy`. Closing cancels a running request.

**Where the entries are:**
- file menu, file selection bars (inbox, asset Files tab), file detail dialog: `Analyse` (one file → result dialog, several → start dialog), `Image to prompt` (one file);
- inbox and asset Files tab toolbars: `Analyse all` (`fileFilter` of the current list) and a toggle that filters to files with a waiting proposal;
- asset gallery toolbar: `Analyse all` (`assetFilter` of the current filter); the selection panel of the selected asset and the asset screen: `Analyse` (`asset`);
- a file with a waiting proposal shows a marker in the AI colour on its tile, its table row and in the detail dialog (tooltip only).

**Pause banner** in the app shell (next to the storage banner): the pause reason's fixed message, `Resume`, and for `provider_unauthorized` / `provider_not_configured` a button to the settings screen.

### 8. Mock provider and tests

- `docker/mock-provider` gains: an optional required bearer key (`MOCK_API_KEY`; 401 without it), `/api/show` with capabilities (one vision model, one non-vision model, one without capabilities), a plain-text answer for a chat request without `format`, and it must never log the `Authorization` value.
- Automated tests run only against the in-process mock or stubs. `safeStorage` is behind a small port so tests use a fake; one test proves the key bytes on disk are not the plaintext and that nothing is written when encryption is unavailable.
- Tests that must exist: the key never appears in a job row, a payload, `provider-settings.json`, an IPC response or a captured log; the key is dropped when the origin changes; `Authorization` goes only to the configured origin; no request is made without a chosen model; fingerprint skip and `force`; propose → accept a subset / discard / stale; a proposal survives reopening the workspace; `apply` removes a waiting proposal; v1 payload still runs; pause after three unreachable runs, immediate pause on 401, resume, attempts kept; describe is cancellable and leaves no trace in the database; a filter target larger than one chunk.
- The real gateway is checked by the owner in the running app (enter URL and key, test connection, pick a model, analyse one image, accept, run a small batch, Image2Prompt). No agent does this.

### 9. Documentation

`ReadMe.md` §6, §8, §9.3, §14, §15.2, §16, §17, §18 (the "first model" decision becomes "no built-in model; the owner chooses"), `docs/backlog.md` (resolve the circuit-breaker entry, the provider-cause debug line and the "replaced by the 4b result dialog" section), `.env.example`, and the phase paragraph in `CLAUDE.md`.

## Left to the builder

- Module and component names, file layout, the exact SQL of the target enumeration and of `analysis:preview`.
- The wording of `IMAGE_PROMPT`, tooltips and the fixed error messages (English, short).
- How the model list cache and the proposal marker are refreshed in the renderer (the jobs context's `resultToken` is available).
- Whether `settings:*` handlers live beside the workspace handlers or in their own module.

## My calls (not decided by the owner)

- No multi-select in the asset gallery; "asset selection" is the selected asset.
- Resource class stays `local_gpu`, limit 1, also when the base URL is not local.
- Pause thresholds: three consecutive runs ending unreachable, unavailable (5xx/429) or timed out; one `provider_unauthorized` or `provider_not_configured`. The pause lasts for the app session across workspace switches and is not persisted.
- An asset filter with a file role or file kind analyses only the files of that role or kind.
- `Analyse all` is disabled while the list is filtered to waiting proposals.
- A discarded proposal leaves no trace, so the file counts as not analysed again.
- A waiting proposal counts as "analysed" for the skip.
- Image2Prompt bypasses the scheduler and may overlap one running analysis.
- A key is deleted when the base URL's origin changes without a new key.
- The environment variables override stored settings and make the settings screen read-only; without them and without settings nothing is configured (no mock default).
- No `think` field in requests.
- Timeout is a setting (10–600 s, default 120).
