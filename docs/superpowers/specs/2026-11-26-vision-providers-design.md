# Several vision providers — design

Status: draft for the owner's approval, 2026-11-26.

## Intent

The owner analyses images with a local Ollama on their own graphics card. That card is needed for other work, so the local provider is often not running; at those times a container with Ollama on RunPod (or a similar host) takes over, also to try much larger models. Today exactly one provider can be configured, so switching means: open the settings, change the address and key, go back to the asset, start again — and jobs already waiting simply fail against whatever is configured at that moment.

The owner wants several providers defined side by side, chosen where an analysis is started, with the state of the chosen provider visible at a glance, and waiting jobs that can be moved to another provider instead of being cancelled and started again.

## Goals

- Several named provider entries exist side by side, each with its own address, API key, timeout and default models.
- The three analysis dialogs (start dialog, single-image result dialog, Image to prompt) carry a provider select beside the model and prompt selects. It preselects the provider used last and shows whether each provider is reachable (owner decisions, 2026-11-26).
- A job belongs to the provider it was started for. One provider being down pauses only its own jobs; jobs of other providers keep running.
- Waiting jobs of a provider can be moved to another provider and model in one step, from the pause banner and from the Jobs screen, with or without a pause (owner decision, 2026-11-26).

## Non-goals

- A second kind of provider (OpenAI-compatible, vLLM, llama.cpp server, RunPod serverless). Every entry speaks the Ollama API (owner decision, 2026-11-26: "Ollama for now"). The entry keeps room for a kind later; none is stored today.
- Keeping an API key when the address changes: a key stays bound to the origin it was entered for and is deleted when the origin changes (owner decision, 2026-11-26).
- Automatic failover: the app never moves jobs or switches the provider by itself.
- Starting, stopping or loading anything on a provider (pods, Ollama model load control).
- A configurable number of parallel analyses per provider. Each provider runs one analysis at a time.
- Moving a job that is running, or single jobs picked from the list; moving is "all waiting jobs of one provider".
- Polling provider reachability in the background. It is checked when a dialog or the settings ask.
- Recording which provider entry produced a stored analysis. The stored model name stays the record.
- Paid providers and their safeguards.

## Anti-goals

- An API key reaching an origin it was not entered for: by an edited address, by a stale adapter, by moving jobs, or by a job whose provider entry was deleted and recreated.
- A job silently running against another provider than the one shown for it.
- A provider that is down blocking the analyses of a provider that is up.
- Losing the settings or the stored key the owner has today when the app is updated.
- A key in IPC, logs, job rows, the database or the settings file.

## Constraints

- `CLAUDE.md`: keys through `safeStorage` only, no plaintext fallback, decrypted per request; `core` and `contracts` free of Electron and of concrete providers; validated IPC; fixed error messages without URLs or cause texts; the pause is per app session and not persisted; provider settings are app-level (`userData`), jobs are per workspace.
- The fingerprint skip is content + provider + model + `ANALYSIS_PROMPT_VERSION`, where "provider" is the adapter kind (`OLLAMA_PROVIDER`), not an address. It stays that way: the same model through the local and the remote entry counts as already analysed; another model does not. (Author's call, stated to the owner.)
- A queued job must not change when settings or prompts are edited later (as payload v3 does for prompts).
- UI rules: no explanatory text in the layout (tooltips through `title`), buttons from `ui.ts`, tokens only, labels in `labels.ts`.

## Approaches

1. **The provider as a column of the job; the scheduler claims and pauses per provider (chosen).** A job row carries the id of its provider. The scheduler treats every provider as its own lane inside the `local_gpu` class: its own limit of one running job, its own pause state. Moving jobs is one update of the waiting rows. The scheduler stays generic (it knows a "lane key", not providers).
2. **The provider only in the job payload; the scheduler unchanged.** No schema change, but one analysis at a time over all providers, and the claim cannot skip the jobs of a paused provider: the first waiting job of a provider that is down blocks everything behind it. Rejected: it breaks the goal that one provider does not block another.
3. **No provider on the job; waiting jobs run against the provider selected last.** The simplest, and what the owner rejected: a job's model may not exist on the other provider, and what a job will do is not visible.

The owner chose "jobs keep their provider and can be moved" (option 2 of the question asked on 2026-11-26); how that is built was left to the author.

## Design

### Provider entries

Stored at app level in `userData/provider-settings.json`, version 2: a list of entries and the id of the provider used last.

An entry holds: `id` (UUID, never reused), `name` (1–60 characters, unique regardless of case), `baseUrl` (required; the existing rule: http or https, no user info, query or fragment), `timeoutSeconds` (10–600, default 120), `taggingModel` and `promptModel` (each a model name or none). At most 10 entries; none is allowed (author's call on the numbers).

- **Key.** One key file per entry, `userData/credentials/vision-api-key-<id>`, written through `safeStorage` exactly as today. Saving an entry whose origin changed deletes its key; deleting an entry deletes its key file. A request gets the key only for the entry it runs for and only while that entry's origin equals the origin the adapter was built for.
- **Upgrade.** A version 1 file with a base URL becomes one entry named `Ollama` with the stored timeout and models; the existing key file becomes that entry's key file. A version 1 file without a base URL becomes an empty list. The upgrade is written atomically; a crash in between must leave either the old state or the new one usable, and never a key without its entry. A corrupt file is set aside and replaced by an empty list, as today.
- **Environment mode.** With `ASSETFORGE_VISION_BASE_URL` set at start the list is exactly one read-only entry (fixed id `environment` — provider ids are therefore their own schema, not the UUID schema —, name `Environment`, no key sent, `ASSETFORGE_VISION_MODEL` as both defaults), and the stored entries are neither shown nor changed. Saving and deleting answer the existing "set by the environment" refusal.
- **Order.** Entries keep the order in which they were created; "the first entry" means the oldest one, and the Settings list shows the same order.
- **Used last.** Every accepted analysis request (enqueue, describe, single-image analysis) records its provider as used last, best effort, as the prompts do.

### Channels (settings)

The three `settings:*Vision*` channels are replaced; all work without a workspace:

- `providers:list` → `{ providers: ProviderView[], lastUsedId, fromEnvironment, canStoreKey }`. A `ProviderView` is the entry plus `hasApiKey`; never a key.
- `providers:save` `{ id?, name, baseUrl, timeoutSeconds, taggingModel, promptModel, apiKey? }` → the saved view. Without `id` a new entry is created. `apiKey` absent keeps the key, `null` deletes it, a string replaces it (as today). Refusals with fixed messages: an invalid or duplicate name, an unusable base URL, the limit of 10, an unknown id (`not_found`), no credential store for a key (`credential_store_unavailable`).
- `providers:delete` `{ id }`. Refused (`invalid_operation`) while the open workspace has active jobs of that provider; the owner moves or cancels them first. Jobs in workspaces that are not open cannot be checked (see "A provider that no longer exists").
- `providers:listModels` `{ providerId, refresh? }` → the existing `ListModelsResult`, cached per provider until that entry changes. This is also the reachability check: a state check always asks the provider (`refresh: true`), because a cached list would show a stopped pod as ready; the model selects use the cache. The whole call (the list and its per-model lookups together) is bounded inside the adapter by the smaller of the entry's timeout and 10 seconds and then answers `provider_timeout`, so a stopped pod answers "not reachable" in bounded time (author's call).

Saving an entry rebuilds only that entry's adapter and resumes only that provider's pause.

### Jobs

- **Schema.** Migration `0012` adds `job.provider_id` (text, nullable, indexed together with status for the claim). Analysis jobs created from now on always carry it.
- **Payload v4** is v3 plus `providerName`, a copy of the entry's name at enqueue, so a finished or orphaned job still shows a name; its `prompt` may be `null`, meaning the legacy text and limit of v1/v2. v1–v3 payloads keep running as today.
- **Jobs without a provider** (written before this change): when a workspace is opened, every active job without a provider is assigned once to the first entry (id, and the name in a v4 payload that keeps its model, mode and prompt; a v1 row gets that entry's tagging default model, and stays without a provider when there is none). So every waiting job has a lane, and what the list shows is what runs. With an empty list they stay unassigned and fail with `provider_not_configured` as today.
- **Scheduler.** A handler may declare that its jobs are claimed per lane; the lane key of a job is its `provider_id`. For such a handler the class limit (`local_gpu`: 1) holds per lane, and the claim skips lanes that are paused or full, first in first out within a lane. The claim, the running count, the timer for the next due job and the pause gate all work per resource class and lane; the gate can list its paused lanes. Its rules are unchanged (three consecutive unreachable, timeout or unavailable failures; at once on unauthorized or not configured; per app session; not persisted).
- **Run.** The handler resolves the job's provider entry at run time and uses that entry's adapter and key. The model is the one stored in the job.
- **A provider that no longer exists** (deleted while another workspace held jobs for it): its jobs fail with `provider_not_configured`, which pauses that lane at once; the banner then offers to move them. They never run against another entry.

### Channels (jobs and analysis)

- `analysis:preview`, `analysis:enqueue`, `analysis:describe` take an optional `providerId`. Absent: the provider used last, otherwise the first entry. An unknown id answers `not_found`; no entry at all answers `provider_not_configured`. As for prompts, it is resolved inside the workspace read, so `no_workspace_open` wins.
- `jobs:list` rows carry `providerId` and `providerName` (the current name of the entry, the payload's copy when the entry is gone, `null` for other job types); `jobs:list` takes an optional `providerId` filter.
- `jobs:summary.paused` becomes a list: `{ providerId, providerName, reason }[]`, empty when nothing is paused. The name of an entry that no longer exists comes from a job payload of the open workspace, else it is `null` and the renderer shows a fixed label.
- `jobs:waitingByProvider` → `{ providerId, providerName, waiting }[]`: the `queued` and `retry_wait` analysis jobs of the open workspace per provider, including providers that no longer exist. The move dialog takes its source list and counts from it.
- `jobs:resume` takes `{ providerId }`.
- `jobs:reroute` `{ fromProviderId, toProviderId, model }` → `{ moved }`. In one transaction every job of `fromProviderId` in `queued` or `retry_wait` gets the new provider, the new model and the new provider name, starts again at attempt 0 and is due at once; prompt, tag limit and mode stay (a v1 or v2 row becomes v4 with `prompt: null`, so it still runs with the legacy text). `running` jobs are not touched; `failed` and `cancelled` ones neither. `fromProviderId` may name an entry that no longer exists; `toProviderId` must exist (`not_found`) and differ (`invalid_operation`). The scheduler is woken afterwards. A moved job always runs: the "already analysed" skip is decided when jobs are queued, not when they run, so a file that was meanwhile analysed with the new model is analysed again (author's call: the same as retrying a job today; manual tags are never overwritten either way).

Image to prompt stays one request at a time over all providers (`busy`), outside the scheduler, as today. The single-image analysis is an ordinary job in mode `propose`, as today, and waits in its provider's lane behind the jobs already waiting there.

### Renderer

**Settings.** The provider section becomes a list with an in-place editor, built like the Prompts section: entries on the left, the editor (name, base URL, API key, timeout, the two model selects with a reload button, state line) on the right, `Save`, `Delete`, `New`. Deleting asks through `ConfirmDialog`. In environment mode the one entry is shown read-only.

**Dialogs.** A provider select beside the model select in the three analysis dialogs:

```text
Provider  [ Local Ollama — not reachable  ▾]   Model [ qwen3.5:9b ▾]   Prompt [ Default ▾]
            Local Ollama — not reachable
            RunPod — ready
```

- The select preselects the provider used last (else the first). Choosing another one switches the model list and preselects that entry's default model for the dialog's purpose.
- Every option shows the entry's state as text: `ready`, `checking`, `not reachable` (unreachable, timeout, unavailable), `key refused`, `no vision model`, and one generic `error` for every other failure. The states of all entries are requested in parallel when a dialog opens and again when the select is opened; nothing is polled.
- The existing provider gate (`provider-gate.ts`) is applied to the selected entry: Start is disabled with the reason as tooltip, and the Settings button is offered for the cases it is offered today. With no entry at all the dialog shows the existing "not configured" state.

**Pause banner.** One line per paused provider, naming it: reason, `Resume`, `Move jobs`, and `Settings` for unauthorized or not configured.

**Jobs screen.** A Provider column (name and model), a provider filter, and `Move jobs` in the toolbar.

**Move dialog** (shared, opened from the banner and the Jobs screen): source provider (fixed when opened from a banner, a select otherwise), target provider with state, model select of the target, the number of waiting jobs that will move, `Cancel` and `Move`. `Move` is disabled while the target is not ready or no model is chosen, with the reason as tooltip.

```text
Move jobs
From   Local Ollama            312 waiting
To     [ RunPod — ready ▾]     Model [ llama3.2-vision:90b ▾]
                                          [Cancel] [Move]
```

### Error handling

Fixed messages only; no address, key or cause text in a message, a log line or a job row. Provider failures are logged as today (code and HTTP status), with the provider's id, never its URL. New fixed messages are needed for: a duplicate provider name, the provider limit, a provider that cannot be deleted because jobs are waiting for it, and a move onto the same provider.

### Documentation

ReadMe (provider settings, jobs and pause, IPC list; §18 if an open decision is touched), `docs/backlog.md` (remove the request, add what is deferred), `CLAUDE.md` project state, the mock provider's notes if a second mock instance is needed for tests.

## Testing

- Settings store: the version 1 → 2 upgrade with and without base URL and key, and after a simulated crash between its steps; create, edit, delete; name and limit rules; a key is deleted when the origin changes and survives a rename or a path change within the origin; a key is never returned for another entry or a stale origin; environment mode; a corrupt file.
- Persistence: migration `0012` on an existing database with jobs; the claim per lane (first in first out within a lane, a paused or full lane skipped); reroute (only `queued` and `retry_wait`, attempt reset, payload rewritten for v1–v4 rows, one transaction).
- Jobs package: two lanes run in parallel with one job each; a paused lane does not stop the other; the pause rules per lane; resume of one lane.
- Core / handlers: enqueue with a provider, the fallbacks, unknown id; a job runs against its own provider's adapter with that provider's key (two mock providers with different keys: neither ever receives the other's key); a job without provider; a job whose provider is gone; delete refused with active jobs; describe with a provider.
- IPC: validation of the new and changed channels; all `providers:*` channels work without a workspace.
- Renderer (jsdom): the settings list and editor; the select in all three dialogs with states, preselection and model switch; the gate per selected entry; the banner per provider; the Jobs column and filter; the move dialog from both places.

## Left to the builder

- How the scheduler expresses lanes (a lane key on the handler, a generic column name) as long as `packages/jobs` learns nothing about providers.
- The exact steps of the version 1 → 2 upgrade that make it crash-safe (for example: write the version 2 file with a known id first, then rename the key file, and adopt a leftover old key file on the next start).
- Whether the gateway keeps one adapter per entry or builds one per request.
- The exact wording of the new labels and messages, following `labels.ts` and the existing messages.
- How a state is shown inside the select (text in the option, as sketched, or the shared menu component).
