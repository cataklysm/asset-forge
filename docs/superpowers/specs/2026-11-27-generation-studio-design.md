# Generation studio (phase 5a) — design

Status: draft for the owner's approval, 2026-11-27.

## Intent

The owner finds a picture of an interesting person and wants to use it as the template for a 3D model. From that one picture they generate A-poses in several views, one run after the other, each with a slightly different prompt. They keep nearly every result ("you never know") and delete only the useless ones. A good result is upscaled to 4K and becomes the high-resolution reference.

Keeping prompt and parameters only makes sense when the result also stays linked to the picture it was made from (owner condition, 2026-11-27). The chain source → pose → 4K version must be traceable in both directions.

The owner has credit at venice.ai, which offers several image-to-image models; that is the first image provider.

## Goals

- From one image file, start an image edit (source image + prompt) against a Venice provider entry, as a persistent job; several can be queued while the owner keeps working.
- Every result is stored at once as a file in the asset of its source, with role `generated`. There is no accept step; an unwanted result is deleted through the existing trash.
- Upscale any image file by 2× or 4× the same way.
- A generation record keeps provider, model, prompt, effective parameters, the input file and the output file, and survives the trash and a purge of either file.
- The link is visible from the result to the source and from the source to its results.
- A paid request with an unclear outcome is never sent again by the app on its own.

## Non-goals

- The prompt library with versions and variables (ReadMe §7.1) — the next piece. Until then the prompt is plain text on the generation, and the studio offers the prompts used recently.
- Text-to-image without a source, several input images (`/image/multi-edit`), masks and inpainting, Venice's `enhance_prompt` and `transparent_background`.
- Starting generations for many files at once.
- Cost tracking, budgets or limits. Venice does not report the cost of a request.
- Other image providers (RunPod, ComfyUI) and other capabilities.
- A workspace-wide generations screen, a "generated" marker or filter in the file lists and the gallery.
- Moving waiting generation jobs to another provider (`jobs:reroute` stays analysis-only).

## Anti-goals

- A generation that is charged twice because the app repeated it without the owner asking.
- A result file without a generation record, or a record that loses its prompt or its source reference when a file is deleted.
- The API key leaving the main process, reaching another origin than the entry's, or entering the generation record, a job, a log or the database.
- Any automated test or agent calling the real Venice API.

## Constraints

- `CLAUDE.md`: use cases in `core`, adapters behind ports, validated IPC, fixed error messages, streams instead of Base64 over IPC, short transactions, providers without access to the DB or workspace paths.
- Three status concepts stay apart: the generation has its own outcome and does not depend on its job row, which `jobs:clearFinished` may delete.
- UI rules: no explanatory text in the layout (tooltips through `title`), buttons from `ui.ts`, tokens only, labels in `labels.ts`.
- Venice API as documented on 2026-11-26 (to be verified again when the adapter is written): base URL `https://api.venice.ai/api/v1`, bearer key, all calls synchronous.
  - `POST /image/edit`: `image` (file, at most 25 MB, 65 536 to 33 177 600 pixels), `prompt`, `model`, `aspect_ratio`, `resolution` (`1K` | `2K` | `4K`), `output_format`, `safe_mode`; answers the raw image; header `x-venice-is-content-violation`. Marked experimental. No seed, steps or strength.
  - `POST /image/upscale`: `image`, `scale` (2 | 4); answers a PNG.
  - `GET /models?type=inpaint`: the edit models with `model_spec.constraints` (`aspectRatios`, `resolutions`, `defaultResolution`, `promptCharacterLimit`) and `pricing`.
  - Errors: 400, 401, 402 (insufficient balance), 413, 422 (content violation), 429, 500, 503.

## Approaches

1. **Generation as a persistent job (chosen by the owner).** Each edit and each upscale is one job in the existing queue, class `remote_api`, lane = provider entry. Poses can be queued one after the other, a result that has arrived survives closing the dialog or the app, failures show on the Jobs screen. Costs a job type, the generation tables and outcome rules.
2. **A direct request like Image2Prompt.** The dialog waits, one request at a time. Quicker to build, but closing the dialog during the wait loses a paid result, nothing can be queued, and batch upscaling later would need the job path anyway. Rejected.

## Design

### Provider entries

A provider entry gets a `kind`: `ollama` (capability `vision`) or `venice` (capabilities `image_edit` and `upscaling`). `provider-settings.json` becomes version 3; existing entries become `ollama`. The limit of 10 entries covers both kinds.

A `venice` entry has name, base URL, timeout, API key (same per-entry key file and origin binding as today) and a default edit model (`editModel`, nullable); it has no tagging or prompt model. Its base URL must be `https`, or `http` on a loopback address (the mock). The Providers section in Settings asks for the kind when an entry is created and prefills `https://api.venice.ai/api/v1` for Venice; the kind of an existing entry cannot be changed.

The analysis dialogs offer only `ollama` entries, the studio only `venice` entries; "used last" is kept per capability group. In the environment mode there is no image provider.

### Port and adapter

A core port `ImageProvider`:

- `listEditModels(signal)` → `{ name, aspectRatios, resolutions, defaultResolution, promptCharacterLimit, price }[]` (each constraint nullable when the provider does not state it; `price` is display text or null).
- `editImage({ image, model, prompt, aspectRatio, resolution, safeMode, signal })` → `{ stream, mimeType }`.
- `upscaleImage({ image, scale, signal })` → `{ stream, mimeType }`.

The adapter `packages/providers/src/venice-image.ts` sends the image as a multipart file, asks for PNG, streams the answer (capped at 100 MiB) and maps errors to job error codes (below). The provider gateway builds it per entry like the vision adapter. `providers:listImageModels { providerId, refresh }` mirrors `providers:listModels`, with the same 10 s bound and cache rules.

The image sent is the original file when it is JPEG, PNG or WebP of at most 25 MB; otherwise a full-size lossless rendition from the media worker pool. A picture outside Venice's pixel bounds, or still over 25 MB, is refused before anything is sent (`This image cannot be sent to the provider`).

### Data (migration `0013`)

`generation`: `id`, `kind` (`edit` | `upscale`), `status` (`pending` | `succeeded` | `failed` | `cancelled`), `error_code` (nullable), `provider_id`, `provider_name`, `provider_kind`, `model` (null for upscale), `prompt` (null for upscale), `parameters` (JSON, validated and versioned: `{ v: 1, aspectRatio, resolution, safeMode }` or `{ v: 1, scale }`), `job_id` (nullable, no foreign key), `created_at`, `finished_at`.

`generation_input` and `generation_output`: `generation_id` (cascade), `position`, `file_id` (`set null`), `sha256`, `original_name`. One row each today; the tables are the seam for several inputs or variants. Purging a file sets `file_id` to null and leaves checksum and name; the trash changes nothing. A succeeded generation row is never deleted by the app in this piece; a failed or cancelled one only by the owner (`generations:remove`).

`pending` covers a queued, running or waiting job; the live job status travels on the `Generation` record as `jobStatus` (null when the job row is gone) and is display only.

`prompt` is the resolved prompt of ReadMe §7.2; a reference to a prompt version joins when the library exists.

### Job and outcome

Job type `image.generate`, class `remote_api` (two at a time per provider), payload `{ v: 1, generationId }`, `onInterrupted: 'fail'`.

The handler: read the input (checksum compared with the record) → call the provider → import the answer through `importStream` into the inbox → write the output row and `succeeded` in one transaction → move the file into the asset the source belongs to at that moment, with role `generated` (it stays in the inbox when the source has none or the move fails). The result is named after the source: `<source name> edit <n>.png`, `<source name> <scale>x.png`.

Outcome rules, by whether the request may have been charged:

| Case | Job error code | Automatic retry | Pauses the lane |
| --- | --- | --- | --- |
| connection refused, DNS failure (nothing sent) | `provider_unreachable` | yes | after 3 in a row |
| 429, 503 | `provider_unavailable` | yes | after 3 in a row |
| timeout, connection lost after sending, 500, app stopped while `running` | `provider_outcome_unknown` (new) | no | no |
| 401, 403 | `provider_unauthorized` | no | at once |
| 402 | `provider_insufficient_balance` (new) | no | at once |
| 422 or the content-violation header | `provider_content_refused` (new) | no | no |
| 400, 413 | `provider_rejected` | no | no |
| unreadable or oversized answer | `provider_outcome_unknown` | no | no |
| input missing, trashed or changed | `file_unavailable` | no | no |

A content-violation answer stores no file. The pause gate, today tied to `local_gpu`, also covers `remote_api` lanes; the banner line of an image provider offers Resume and Settings, not Move jobs. Retryability is decided by the codes the generation handler throws: it never throws `provider_timeout` or `invalid_response`, so the global retry rule and the analysis stay as they are.

The generation's final state is written where the job ends, not only in the handler. `JobHandler` gets an optional `settled(job, outcome)` that the scheduler calls in the transaction that ends a job without a further attempt: success, final failure (also after the last retry), cancel (queued or running) and recovery. For a handler with `onInterrupted: 'fail'` the scheduler also fails a running job when it is stopped (workspace switch, quit) instead of releasing it, and stop and recovery use the handler's `interruptedCode` (`provider_outcome_unknown` here, `internal_error` by default).

The owner's explicit repeat is `generations:retry` (below); `jobs:retry` on a generation job does the same. `jobs:retryFailed` leaves generation jobs out: a paid request is only ever repeated one at a time. Cancelling sets the generation to `cancelled`; a running request is aborted, and whether it was charged is unknown.

The fixed job error messages become neutral where they name the analysis, and each new code gets one (`The provider may have processed this request; it was not repeated`, `The provider account has no balance left`, `The provider refused this content`).

### Channels

- `generations:start` — `{ kind: 'edit', fileId, providerId?, model, prompt, aspectRatio?, resolution?, safeMode }` or `{ kind: 'upscale', fileId, providerId?, scale }` → the generation. The file must be a complete raster image outside the trash. `prompt` is 1 to 8000 characters after trimming and at most the model's limit; `aspectRatio` and `resolution` must be among the model's values when it states them. The checks use the entry's cached model list and load it within the 10 s bound when there is none; when it cannot be loaded the start is refused with the provider's error code, so nothing is queued against a provider that is down. An upscale whose result would exceed the app's image pixel limit is refused. Without `providerId` the image provider used last, otherwise the first; none answers `provider_not_configured`.
- `generations:forFile` — `{ fileId }` → `{ madeBy: Generation | null, results: Generation[] }`: the generation that produced this file, and the generations that used it as input (newest first, at most 200). A `Generation` carries its fields plus `inputs` and `outputs` as `{ fileId | null, name, sha256, trashed }`. Generations whose output is in the trash or purged stay in both lists and are marked.
- `generations:retry` — `{ generationId }` → the generation, `pending` again with a new job. Only for `failed` or `cancelled`, and it works when the old job row was cleared; the input must still be usable.
- `generations:remove` — `{ generationId }` → nothing. Only for `failed` or `cancelled`; a succeeded generation answers `invalid_operation`.
- `generations:recentPrompts` → the 20 most recent distinct edit prompts of the workspace.

Progress reaches the renderer through the existing jobs polling (`jobs:summary.changes`).

### Renderer

**Entry points.** `Generate from image` and `Upscale` (2×, 4×) in the file menu and the file detail dialog, for one complete raster image outside the trash; blocked with a tooltip when no image provider exists.

**Studio dialog** (follows the window size like the image viewer, stays open for a series):

```text
+----------------------+---------------------------+----------------------+
| Source               | Provider [Venice  ready v]| Results (newest      |
|                      | Model    [qwen-image-…  v]|  first)              |
|   [ source image ]   | Prompt                    | [tile] [tile] [tile] |
|                      | [                       ] | [tile] [queued] …    |
|                      | [recent v]                |                      |
|                      | Aspect [auto v] Res [1K v]| selected result:     |
|                      | [x] Safe mode             |  [ large preview ]   |
|                      | [ Generate ]              |  Open  Upscale  Use  |
|                      |                           |  settings  Delete    |
+----------------------+---------------------------+----------------------+
```

- The provider select shows each image entry with its state, as `ProviderSelect` does; the model select lists the entry's edit models with the default preselected and the price, when known, in the tooltip. Aspect ratio and resolution appear only with the values the model states.
- `Generate` queues a run and leaves the form as it is; it can be pressed again at once.
- A result tile shows queued, running, failed or cancelled (the message in the tooltip, with Retry and Remove), the thumbnail, or a trashed or deleted mark with the name. A selected result shows large beside the source, with Open (file detail dialog), Upscale, `Use settings` (copies its prompt and parameters into the form) and Delete (trash).
- Safe mode is on by default; the last choice is remembered per app.

**File detail dialog.** In the details column: `Generated from` with the source as a link (the name and a deleted mark when it was purged), the provider, model, parameters and the prompt (copy button); and `Results` listing the files made from this one, each a link. Opening the studio on a file with results shows them.

**Jobs screen and banner.** Generation jobs show their own type label; the provider column and filter work unchanged.

### Mock provider

`docker/mock-provider` gets the Venice-shaped endpoints under `/api/v1` (`GET /models?type=inpaint` with two edit models of different constraints, `POST /image/edit`, `POST /image/upscale`), answering a deterministic PNG whose size follows the request, and fixed prompts that trigger 402, 422 with the violation header, 429, 500 and a slow answer.

### Documentation

ReadMe (§7.2, §8, §9.3, §15.2, §17 and the IPC list), `docs/backlog.md`, `CLAUDE.md` project state.

## Testing

- Core: start validation (file state, prompt and parameter limits, provider choice); the handler for every row of the outcome table; the result lands in the source's asset or the inbox; checksum mismatch; purge keeps name and checksum on the record; `generations:retry` reuses the generation, also without the old job row; remove refuses a succeeded one; `jobs:retryFailed` skips generation jobs; the `settled` paths (cancel while queued, last retry, stop while running).
- Persistence: migration `0013` on an existing database; `set null` on file removal.
- Providers: the Venice adapter against the mock — request shape, bearer only to its origin, streamed answer with the cap, every error mapping, `listEditModels`.
- Jobs: `remote_api` lane pause and resume; an interrupted `running` generation job fails with `provider_outcome_unknown` on recovery and is not requeued.
- Desktop: settings upgrade v2 → v3; kind rules; IPC validation; end to end against the mock from `generations:start` to a linked file.
- Renderer (jsdom): the studio (gate, model constraints, queueing twice, tile states, Use settings, Delete), the details column in both directions, menu entries and their blocked state.

Not covered by any automated check: the real Venice API, its models and prices.

## Left to the builder

- How the result file id is tied to the generation so that a crash between import and commit leaves at worst an unlinked file in the inbox and a generation with `provider_outcome_unknown`, never a linked half-written file.
- The numbering in result names and what happens on a name clash.
- The exact layout of the studio and of the details block, following the image viewer and `ui.ts`.
- Whether image providers get their own model-list type or share one with a discriminator.
