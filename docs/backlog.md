# Backlog

Findings from the phase 1, phase 2, phase 3a, phase 3b, UI redesign, image viewer, phase 4a, phase 4b, file trash, editable prompts, tag rename and merge, ZIP import, asset sources, several vision providers and generation studio reviews that were deliberately not fixed. Nothing here blocks the next phase; triage the list whenever a plan touches the area.

## Requested features

Asked for by the owner on 2026-11-26; none is designed or scheduled yet. Each needs a design before a plan.

- **Duplicate check by hash.** The content hash is used to avoid duplicates. Today an import only reports that a file with the same SHA-256 already exists (`duplicateOf`, counted in the inbox's import result) and imports it all the same. Decided by the owner: a duplicate is never skipped (files would be missing and the user would wonder why) but is clearly identifiable, on an import into an asset as well as into the inbox; the check is workspace-wide (the same content may already sit in another asset the owner did not think of searching for); there is a "Find duplicates" action for what already exists; files in the trash do not count. Open for the design: how a duplicate is marked and where the marker stays visible after the import (tile, table, detail dialog, filter), how the other copies are reached from it, what "Find duplicates" shows and which actions it offers, and whether a stored hash index is needed.

## Correctness and robustness

- `JsonWorkspaceRegistry` read-modify-write is unserialized and quarantine on read is racy; it drops unknown keys in `settings.json`.
- `database.close()` throwing inside the `open` error path masks the original error.
- `isInside` rejects valid names that start with `..` (e.g. `..config`); compare against `..` and `..` + separator.
- A failed move leaves an empty target parent directory.
- `LocalStorage.move` checks for the target and then renames; a target created in between can be replaced.
- A file move whose commit fails leaves the file row pointing at the old path until the workspace is opened again.
- `assignAsset` checks for an existing assignment and then inserts (not one statement); `addRelation` returns a `createdAt` that was not stored when the relation already existed.
- Quitting the application waits for a running import; reads are not ordered against `close`.
- File names are truncated by code points, so long non-ASCII names can exceed a 255-byte limit (ext4, Samba).
- The same folder reached through a drive letter and a UNC path is reported as `workspace_duplicate`.
- `EPERM` from a locked file is reported as `storage_access_denied`.
- Error messages that carry absolute paths to the renderer: `PathEscapeError` for a dangling link (`packages/storage/src/local-storage.ts`) and "Storage is not reachable: …" on workspace create/open.
- Non-domain import errors are not logged anywhere; the recovery results (imports and file moves) are not logged either.
- Pre-migration database backup; migrations path for the packaged app.
- Hashing moves off the main event loop once jobs exist.
- The built-in asset type definitions generate fresh UUIDs on every open (only used when a type is missing).
- `createAsset` inserts the asset and then starts its default workflow; the two are not atomic, so a failure in between leaves an asset without the workflow of its type.
- A built-in template whose version row is missing is only repaired the next time the workspace is opened.
- The asset list computes progress with two correlated subqueries per row.
- Nothing guards against editing a built-in workflow template definition without raising its version; such an edit never reaches existing workspaces.
- Workflow use cases assert that the workflow they just wrote can be read back; a failure there surfaces as `internal_error`.
- Preview requests are not cancelled when a tile scrolls away; the worker queue is only served newest first. A tile that is revisited while its job is still queued keeps its old place at the bottom of that queue and is served after everything requested in between.
- When the preview worker module cannot load, every queued job starts a fresh worker and logs its own failure line; one scroll can print hundreds of identical lines.
- The session failure memory of the preview service also remembers worker timeouts and crashes, and it is unbounded.
- No index on `asset.cover_file_id`.
- `setCover` is not a guarded UPDATE and `getAssetDetail` reads in two steps; both are safe only under serialised writes.
- The derived-data rebuild still runs on the main process while a workspace opens (about 1.7 s at 10 000 assets); it yields to the event loop between batches of 500, but each batch blocks it. The step also runs on every new workspace.
- `asset_search_map` rowids: once assets can be deleted, the FTS row and the map row must be deleted together; otherwise rowid reuse attaches a stale index row to a new asset.
- `FileKindSchema.catch('other')` in the file repository hides an invalid stored kind.
- Adding and removing a tag are check-then-act in the use cases (safe today because one writer holds the workspace lock).
- The search plans rely on `cross join` to fix the join order in the tag filter; the scale test guards it.
- The search path without a query still orders by `lower(name)` over all assets.
- The inbox file list orders through a temporary B-tree (no index matches its sort).
- `files:assignMany` holds the exclusive workspace queue for the whole batch.
- Tags stored before the letter-or-digit rule that consist only of symbols cannot be removed through the UI; a symbol-only name in the tag filter is rejected with `validation_failed`.
- Unused tag rows are never deleted (a merge deletes only its source row).
- A drive-relative source path without a backslash (`C:a.exe::$DATA`) still passes the refused-import check; no file dialog produces such a path.
- The 200-character limit of the search query counts UTF-16 code units, not characters.
- `InMemoryStorage.absolutePath` and `LocalStorage.absolutePath` behave differently when the storage is unreachable.
- `files:measure` runs inside `manager.exclusive`; other writers wait for the probe.
- Decoder byte limit of 256 MiB: an uncompressed 16-bit RGBA 8K TIFF (about 265 MB) gets neither dimensions nor a preview. Raising the limit is an owner decision.

## IPC and security

- Channel allowlist in the preload, so unknown channels fail there instead of at `ipcMain`.
- Track dialog-granted paths: `files:import` and `workspace:open` currently accept any absolute path sent by the renderer.
- Permission request handler on the session.
- `shutting_down` is returned before the sender check.

## Renderer

- Lists used as pickers and filters (projects in the asset list, asset and project pickers) load at most 200 entries.
- The project member table still uses a pager of 50 that resets on navigation.
- `CommitInput`: Enter followed by blur can save twice before the reload; the draft reset can overwrite typing while a reload is in flight.
- The load-error lists of the screens are keyed by their message, so two identical errors share a React key.
- The type select on the asset form is empty when loading the asset types fails.
- The "Importing…" label is shown while the file picker is still open.
- `formatBytes(1048575)` yields `1024.0 KiB`; no guard for NaN or negative values.
- A file whose placement failed counts as failed on the asset screen although it was imported into the inbox (the inbox screen counts it as imported).
- No settings for the cache size and location; the preview worker timeout (30 s) is a constant.
- The preview failure memory is per session and is not invalidated when a file changes.
- `Cache-Control` max-age on previews assumes the content of a file ID never changes (true until working-file re-hashing in phase 6).
- Two saves of the same workflow step in flight: the response that arrives last wins.
- A workflow without mandatory steps renders `<progress max="0">`.
- Removing a workflow clears the local state instead of reloading it.
- `CoverImage` keeps a failed id per instance, so non-virtualised tiles stay on the format tile after the storage returns until the user navigates away and back.
- A paged loader re-activated after an inactive settle would keep stale loading entries.
- Focus is lost when a focused placeholder becomes a Retry button.
- Multi-file Detach is a renderer loop over `files:unassign`.
- The project member table has no cover (the contract lacks it).
- Tag filter chips show the normalised name, not the display name.
- `ProjectListState` has no opened index, so focus does not return to the project row after Back.
- After assigning a file from the inbox detail dialog, focus is lost when its tile leaves the list.
- The assign busy guard of the inbox selection column does not survive a remount of the column.
- Body text uses Tailwind `text-sm` (14 px) in buttons and tables where the design names 15 px.
- Retry on the storage banner during an import remounts the page and clears the busy block; navigation and "Import files" are free while the main process still imports, and the result strip is lost.
- Ctrl+F ignores an open modal: it swallows the key and focuses the field behind the dialog.
- A stale `assets:get` can overwrite a newer mutation result on the asset screen, and `fileCountError` stays after a successful reload.
- `FileBrowser` refreshes the selection from the last rendered props instead of a functional update; `usePagedList` has side effects in render, and `retry` and `loadThrough` act on the non-displayed state.
- Batch tag changes on the asset Files tab bypass the `batching` guard, `nameOf` there closes over the render-time selection (the inbox uses a ref), and cover and detach from the menu have no busy guard.
- `AssignFileControl.assign` has no in-flight guard; two different picks in quick succession make the second fail with a domain error.
- Ctrl+A after a failed page silently selects a partial result; a failed first page shows Retry without a message (assets, projects, file browser).
- A stale assign failure strip in the inbox selection column stays for later selections.
- The Selection column is empty after a remount while the selected page is not loaded.
- A failing asset-type load is silent in `ProjectDetails`, and so is a failing library count in `AssetsScreen`.
- Candidate, not verified: the tile menu in the last visible row and the "More" menu at the bottom of the file dialog panel may be clipped.
- `TagCombobox` ignores IME composition, can keep a stale active option, and `aria-controls` points at a list that is not rendered; `TagFilter` loses focus at 10 tags.
- The row "Open" link has `tabIndex -1`; focus is not restored to a neighbour after a removal; the Workspaces screen has no `h1`.
- Image viewer, left out on purpose: neighbouring files are not preloaded; 16-bit and wide-gamut TIFF are converted to 8-bit sRGB in the PNG rendition; the viewer cannot be opened from the asset gallery (only from file lists).
- Image viewer zoom: a fast Ctrl+wheel can lose zoom steps; `devicePixelRatio` is read at render only (no `matchMedia` resolution listener), so "100 %" is stale after a monitor or scaling change until the next render; a `reduced` rendition at 100 % is upscaled by a non-integer factor.
- Image viewer browsing: stepping on and a pending `show` wait until Retry when the slot's own page failed; focus falls to `body` when the focused Previous/Next button becomes disabled at the end of the list, after which the shortcut keys only work again after a click into the dialog; `ViewerList.want` has a new identity on every render.
- Image viewer layout: Fit uses the whole-number `clientWidth`/`clientHeight` of the frame, so at a fractional `devicePixelRatio` the fitted box can be up to half a CSS pixel larger than the real stage and loses an edge pixel (measure with `getBoundingClientRect` and floor to the device grid); a rotated layer can sit half a device pixel off the box; the stage's own position on screen may be off the device grid; Ctrl+wheel over an on-stage arrow does not zoom; the on-stage arrows make the focus loss on a disabled Previous/Next button more likely; the dialog header is a `<header>` and so a banner landmark; the tag input is named "Add image tag" for non-image files too; a horizontal film-strip scrollbar clips the tiles; the toolbar is cut off in very narrow windows; in the inbox the heading "Assign" sits above a button "Assign". Untested: Fit ignoring a client area shrunk by scrollbars; no on-stage arrows for a list of one file.
- Small inconsistencies: the asset breadcrumb is "Assets" only while the project one adds the name; `AssetsScreen` does not refresh `lastSelected` from a loaded page as `ProjectsScreen` does; role selects use `INPUT` instead of `SELECT`.

## Code structure

- The asset row mapper is duplicated in three repositories.
- `safeErrorMessage` lives in `import-file.ts` although file moves use it too.
- The workflow progress rule exists three times: `progressOf` in the adapter, the SQL of the asset list, and the in-memory fake.
- The session and the import context are built from near-identical lambdas in the workspace manager.
- "Details" is removed from the dialog menu by its label, with dummy `onDetails` handlers in both hosts.
- `ROLES = FileRoleSchema.options` is declared six times in the renderer; `{ name: section } as View` in `WorkspaceShell`.
- The tag-id lookup is triplicated in persistence; `ipc.ts` and `library-handlers.ts` import each other.
- `AssetsScreen`, `AssetScreen` and `FileBrowser` are large and want splitting.
- `TagList` is called with `Number.MAX_SAFE_INTEGER` in the file dialog instead of a "show all" option.
- `FileBrowser.tsx` should hand its viewer state machine to a `useViewerList` hook.
- The preview worker pool doc comments still say "none" for failed jobs.

## Tooling and tests

- Split the desktop `tsconfig` into DOM (renderer) and Node (main, preload) configurations.
- Crash-recovery test on the real adapters (currently only on the fakes).
- Tests for `journal_mode=wal`, a failed migration closing its handle, the dangling-link and Windows case-folding branches, temp-file cleanup in the registry, and the "ignore removal errors" branch of `importFile`.
- The in-memory fakes approximate BM25 by a two-bucket rule (name matches first, then the rest).
- The in-memory fakes sort with `localeCompare`, SQLite with `lower()`; the orders can differ for non-ASCII names.
- The IPC test hard-codes the number of channels; the absolute-path scan in the error tests only looks for the native separator.
- The `EACCES` test of `writeStream` does not assert that the target is absent.
- The in-memory `assetWorkflows.insert` checks fewer foreign keys than SQLite does.
- A new template version next to workflows on the old one is only tested on the fakes, not on the SQL adapter.
- `check-sharp.mjs` is a manual gate and not part of `pnpm test`; it has no worker `exit` listener.
- No test for `workflows:remove` with an unknown asset; the `handlersFor` helper is duplicated in `acceptance.test.ts`.
- `noopHost` is duplicated in three test files.
- Fake and SQLite repositories differ in error precedence for batch tag channels.
- A `toHaveLength(1)` assertion in `tag-repository.test.ts` is vacuous.
- The test setup emulates Esc, and the native-close fallback of the dialog is untested; some tests assert class substrings.
- No test for superseding on a tag change; missing tests for `usePagedList` retry, the Workspaces busy state, the asset Files tab batch tags and the inbox assign failure strip.
- `console.info` output in the tag scale test.
- Flaky jsdom test under load (pre-existing, timing-sensitive): inbox "filters and scroll offset survive navigation". The assets and projects "list state round trip" tests, which failed the same way, were hardened in phase 4b: they now wait until the list has settled (no `aria-busy` left) before the click and wait for `aria-selected` after it. Their failure was not reproduced, so the root cause is unconfirmed.
- Preview worker pool: the reverse eviction case (thumb evicted, `full` untouched) is untested.
- Media protocol tests: the cancel test cannot fail; the upper-case UUID parity test only compares nullness.
- Image viewer tests: no tests for the anchored scroll offsets and for Fit following a stage resize; `show(125)` alone and a file shifting across a page boundary are untested; the rejected-fullscreen test would pass without the `catch`; no test for the film strip scrolling the current tile into view; no end-to-end test "import stores oriented dimensions" through the real composition.

## Phase 4a

Deferred by design:

- No attempt history: a job keeps only its attempt counter and the error of its latest run (ReadMe §10). Needed at the latest for paid jobs in phase 5.
- The file name on the Jobs screen is plain text, not a link to the file.
- Job rows are only removed by "Clear finished"; there is no age-based cleanup of finished jobs.

Found during the build:

- Tag cleaning (`cleanTagText`, shared by manual and AI tags) does not strip control and format characters (`\p{Cc}`, `\p{Cf}`: NUL, zero-width characters, bidi overrides), so a model answer can produce invisible or visually spoofed tags. Fixing it changes stored names and needs a `DERIVED_DATA_VERSION` bump.
- Scheduler (`packages/jobs/src/scheduler.ts`): a cancel during `stop` is dropped instead of marking the run cancelled; a failing pass skips the remaining resource classes and keeps the old timer; non-`JobError` causes during `stop` are not logged; the delay fallback is unreachable.
- Scheduler: a thrown `claimNext` or `nextRunAfter` in a pass (e.g. a corrupt `payload` JSON) stalls that resource class until the next wake.
- Scheduler: when `recover()` or `settle` fails, the rows stay `running` until the next workspace open; retry the recovery on the next wake.
- Scheduler: a job that a pass has claimed but not yet launched misses a cancel (`cancelPending` returns 0 and no active run exists yet); re-check `active` after `cancelPending` returned 0.
- A handler that ignores its abort signal hangs `stop` and with it the workspace close and quit.
- `pool.jpeg` is not abortable (up to 30 s), so a workspace close during an analysis can wait that long.
- Job repository: a cancelled `retry_wait` job keeps its `run_after` and its old error.
- The "an AI assignment yields to any existing one" rule is coded twice (`FileAnalysisRepository.apply` and `linkFileTags`).
- Nothing ties `errorMessage` to the fixed message of `errorCode` in the contract schema; the stored pair is only correct because every writer uses `JOB_ERROR_MESSAGES`.
- The preview worker pool doc comments do not mention the `jpeg` job and its `null` result.
- Before paid providers: `jobs:cancel` and `jobs:cancelAll` (`packages/core/src/jobs.ts`, `apps/desktop/src/main/job-host.ts`) report success without a scheduler (during `stop`, or after a failed `workspaceOpened`) while a pending job stays queued; fall back to `cancelPending` in core.
- Before paid providers: `workspace:remove` of a workspace that is not open still stops the scheduler of the open one and starts it again (`apps/desktop/src/main/ipc.ts`), interrupting its running jobs.
- `ollama-vision.ts` keeps the JSON parse error as the cause of `invalid_response`, and a `SyntaxError` message can quote part of the answer; nothing logs it (the failure log line carries only the code and the HTTP status), and nothing must start to.
- Jobs screen: a page button activated by keyboard is disabled while its action runs, so focus falls to `body`; restore focus to it afterwards.
- `scheduler.ts`: `startDone` and `starting` hold the same promise once `start()` ran; one of them is redundant.
- Inbox and asset screen (`InboxScreen.tsx:39,78`, `AssetScreen.tsx:59,66`): the `importResult` state also holds the analysis counts (rename to `result`); the counts of a start replace an import failure list in the shared strip even when it was not read yet.
- `file-actions.ts`: the doc comment of `fileMenuItems` is wrapped unevenly.
- `resultToken` (`apps/desktop/src/renderer/src/jobs-context.tsx`) misses a success when finished jobs are cleared in the same poll window, because `succeeded` does not rise then.
- A `storage_unreachable` answer to `jobs:summary` would raise the storage banner again on every poll (`apps/desktop/src/renderer/src/api.ts`, `jobs-context.tsx`).
- Jobs screen (`apps/desktop/src/renderer/src/screens/JobsScreen.tsx`): `MAX_ATTEMPTS` is duplicated as a renderer constant (move it to `packages/contracts` with the next job type); an action reloads the list twice (its own reload token, then the poll that sees `changes` move); `focusedIndex` is a copy of the one in `FileBrowser.tsx` (share it); a status filter change can lose its reset to the top when a poll moves the reload key in the same render (skip the capture when the status changed); the remount after a moved `changes` returns the focus to the row rather than the action button, and a newly queued job shifts the restored index; the count tooltip "Jobs in this workspace" shows the filtered total.

Tests:

- No test pins the exact text of every job error message.
- In-memory job fake (`packages/core/test/memory-jobs.ts`): `enqueue` is not atomic on an id collision; it clones payloads with `structuredClone` while SQLite round-trips JSON; the fake has no tests of its own.
- The core tag tests lack the asset-tag cases of the manual-wins fake.
- Missing persistence tests: `FileAnalysisRepository.apply` for an inbox file, rejection of an unknown `job.file_id` by the foreign key.
- Mock provider: its test does not pin the style tag or that the tags come from the vocabulary; scripted numeric and `'hang'` failures bypass `delayMs` and are consumed before the model and image checks.
- Ollama adapter: the `closedPortUrl` test can flake.
- Tag cleaning: no test pins that control and format characters pass `cleanTagText` (see above).
- No test pins the content of `ANALYSIS_PROMPT` (`packages/core/src/analysis.ts`); the analysis test only checks that it is sent.
- Renderer: the theme contrast test in `tags.test.tsx` reads `index.css` through `process.cwd()` (use `import.meta.url` like `theme.test.ts`).
- Real 50 ms sleeps in negative assertions (`file-browser.test.tsx`, `inbox.test.tsx`, `jobs-ipc.test.ts`).
- Jobs screen tests: no test for the poll and reload after a rejected action, for the position kept across a reload, or for the reset to the top on a status change.
- The Compose service of the `mock` profile and the environment configuration through a real `pnpm dev` start are not covered by any automated check.

## Phase 4b

Deferred by design:

- The asset gallery has no multi-select; several assets are analysed through "Analyse all" over the gallery filter.
- Image2Prompt runs outside the scheduler, so it can overlap one running analysis on the same GPU (Ollama queues the requests).
- The pause of the analysis queue is not persisted; a restart starts unpaused.
- A file has one AI tag set, not one per model, and there is no proposal history.
- `providers:listModels` has no cancel channel (`provider-handlers.ts`); a slow server holds the request until its timeout.
- The Settings screen is reachable only inside an open workspace, although the settings are app-level.
- The two "Before paid providers" entries of phase 4a still apply.
- `jobs:resume { providerId }` is app-level: it works without an open workspace and resumes one lane of the app session's pause gate.
- The "Proposals" toggle of the file lists is local to `FileBrowser` and does not survive navigation (the list state assumes string filter values, and "Analyse all" would have to leave the toggle out of its filter).
- The pause banner sits in the shell behind the backdrop of a modal dialog: behind a form-size dialog it stays faintly visible but cannot be used, and the file detail dialog covers it almost completely.
- With a selection, the asset Files tab shows two Analyse buttons (the asset's in the header and the selection's), told apart only by their tooltips.

Provider adapter (`packages/providers/src/ollama-vision.ts`):

- Models beyond the first 100 of `/api/tags` are dropped silently.
- `invalid_response` for a `message.content` that is not JSON is logged with HTTP status 200.
- A timeout that fires after the answer arrived relabels the outcome as `provider_timeout`.
- A host with a trailing dot counts as a different origin, so the stored key is deleted on such a change.
- A failure while building the request headers throws `provider_unauthorized` directly instead of going through `fail`, so an abort at that point would be reported as `provider_unauthorized`; not reachable today, because `throwIfAborted` runs just before and the header build is synchronous.

Provider settings (`apps/desktop/src/main/provider-store.ts`):

- A direct save that breaks the schema answers `invalid_operation` rather than `validation_failed`.
- The key's origin binding lives only in the plaintext settings file (an entry's stored base URL): a process with write access to `userData` can replace an entry's base URL and keep its key file, and the next request sends the key to the new host. Possible fix: encrypt `{ origin, key }` together and compare the origin after decrypting.

Main process (`apps/desktop/src/main`):

- Cancelled Image2Prompt runs keep running in the media worker pool until they settle; the set of settling runs is unbounded, so repeated Generate and Cancel can pile them up (pass the signal into `images.jpeg` or cap the set).
- `JobHost.resume()` always calls `changed()` and `wake()`, so `changes` rises on every save or delete of a provider entry even when the queue is not paused (`job-host.ts`).
- The provider id reaches core by two routes: `composition.ts` hands `OLLAMA_PROVIDER` to the job host (the fingerprint of a run), and `job-handlers.ts` imports it for `analysis:preview` and `analysis:enqueue`. `OLLAMA_PROVIDER` stays the one adapter kind and the provider id of the fingerprint, not an entry id, so the same model through two entries counts as already analysed; a second kind of provider must keep both routes equal.

Mock provider (`docker/mock-provider/server.mjs`):

- Every request, including the image body and the headers, is kept in memory for the life of the process (`server.mjs:83`). Possible fix: record only when a `record` option is set, or cap the array.

Scheduler and pause gate (`packages/jobs`):

- With a class limit of 2 or more, a claim already in flight when the pause trips still starts its job.
- The gate records an outcome before the job's result is stored, so a failing store still counts.
- The pause threshold of `createPauseGate` is not validated.

Persistence:

- `acceptProposal` in the repository answers `false` both for no proposal and for a stale one; core tells them apart only by reading first.
- A wrong `sha256` passed to the repository's `acceptProposal` deletes a valid proposal (core always passes the stored one).
- The proposal reader (`parseTags` in `file-analysis-repository.ts`) returns an empty tag list for stored JSON that does not parse or is not an array and drops malformed entries, where the list readers throw; it does not validate tag names.
- No query-plan test for the reader page statement or the new index `job (file_id, type, created_at, id)`.
- The analysis target reader (`analysis-target-reader.ts:17-26`) answers an empty target for a filter tag name that does not normalise (no letter or digit, too long), so `analysis:preview` and `analysis:enqueue` answer zero counts where `files:list` and `assets:list` reject the same filter with `validation_failed`.
- No test pins that the reader's SQL predicate (`analysableSql` over `PREVIEWABLE_MIME_TYPES`: complete, listed MIME type, checksum present) agrees with `isAnalysable` in core (`analysis.ts:57`) and with the renderer's `analysable` (`file.previewable`, which `isPreviewable` derives, without the checksum); unverified beyond reading the code.

Renderer:

- Accept can race a newer proposal of the same file; the fix needs the proposal's `createdAt` in the `analysis:acceptProposal` contract, which carries only `fileId` and `names`.
- The preview counts a file that is analysed and also queued only as `alreadyAnalysed`, so with "Analyse again" the start dialog counts it under "To analyse" (`wouldEnqueue`, `AnalysisStartDialog.tsx:41-42`) while "Already queued" shows 0; the enqueue with `force` then answers it as `alreadyQueued` and the strip shows "0 queued, 1 already queued". There is no dedicated dialog state for 0 enqueued (only the strip).
- A propose request for a file that already has an active apply job is shown as the dialog's own job (`AnalysisResultDialog.tsx:166-175`, `packages/core/src/analysis-enqueue.ts:74`): the dedupe key is per file, the enqueue answers `alreadyQueued`, and the dialog treats that as success. After "Analyse all", opening one of its files and clicking Analyse shows Queued or Running; on success the tags are applied without review and the dialog ends empty. Possible fix: carry `mode` in the `JobView` of `analysis:getProposal` and show a fixed "already being analysed in a batch" state.
- The prompt dialog shows the tagging wording of the shared provider gate: `NO_VISION_MODEL` and `MODEL_NOT_VISION` (`labels.ts:88,91`) say "analyse images".
- `ModelSelect` shows a failed model list twice on the Settings screen, and a stale refresh error stays visible after a good list arrived.
- The prompt dialog loses focus when its state changes (Generate disabled, Cancel unmounted).
- The result dialog's busy state can flicker for one frame after a file switch.

Renderer tests:

- The settings route of `AssetFilesTab` (closing the file detail dialog before Settings opens) has no dedicated test, only the inbox's; the result dialog's disabled Settings during an import is covered only by a shell test.
- Not tested: the proposal toggle on the Files tab, the debounced query reaching "Analyse all", and Image to prompt from the detail dialog menu. Of the gallery filters only status and tags are asserted in the `assetFilter` target (`assets.test.tsx`); query, type, project, role and kind are not.
- No test proves that the asset Files tab and its count reload when the jobs `resultToken` advances (`AssetScreen.tsx:93,272` use `reloadToken + resultToken`; the asset screen tests use a static `jobs:summary`).
- Settings: the reload race and a superseded model request that fails are tested; a superseded model request that succeeds after the newer one is not.
- Start dialog: no test for Settings clicked while a start is in flight (the `startingRef` guard in `openSettings`), and none for a preview answer of a previous target arriving after the target changed (only a model change is tested).

Core tests:

- The fingerprint tests do not cover every field separately for a waiting proposal (checksum, prompt version).
- The fake proposal reader skips tag normalisation.
- `viewOf` in `analysis-proposals.ts` duplicates the `JobView` mapping of the job use cases.

## File trash

Deferred by design:

- Nothing empties the trash automatically; there is no retention period (owner decision).
- Assets and projects cannot be deleted.
- The trash is in the app only, not the operating system's recycle bin.

Found during the build — core and persistence:

- The port doc comments in `packages/core/src/ports.ts` do not describe the new refusals and skips (a move commit or placement on a trashed file is refused, trashed files are left out of the inbox and workspace-wide queries, tag suggestions, duplicate detection and analysis targets).
- A stale move row that the repository refuses to commit (a move onto a trashed file) is not deleted; it is retried and refused again on every workspace open, and a restore or purge of that file that resolves it fails with the same refusal.
- `analysis:discardProposal` has no trash guard (`packages/core/src/analysis-proposals.ts`, `discardProposal`): it deletes the waiting proposal of a trashed file, which a restore should bring back. The renderer does not offer it in the trash.
- The commit of a move (`packages/persistence/src/file-move-repository.ts`) has a dead `NotFoundError` branch after the update (the row was read in the same transaction just before).
- A purge that loses a race to another purge answers "The file is not in the trash" although the file is gone.
- `purgeFiles` (`packages/core/src/file-trash.ts`) deletes the tombstone after `remove` returned, but `remove` also returns without error when the storage dropped just before. The binary then stays in the trash directory with neither a row nor a tombstone and no sweep removes it (leaked disk space, no data loss). Delete the tombstone only when the storage is still reachable afterwards, as the sweep does.
- `resolveFileMove` (`packages/core/src/asset-files.ts`) treats a storage that drops between the reachability check and its `exists` calls as "target missing" and aborts the move row. A purge that follows can then leave a restored binary outside the trash without a row. Re-check reachability before the abort, or after a discarded row in restore and purge.
- Binaries left in `.assetforge/trash/` by a purge before migration `0009` have no tombstone and are never swept.

Found during the build — main process and jobs:

- `analysis:enqueue` and `jobs:retry` run in `manager.read`, not in the exclusive queue, so a race between `cancelFileJobs` and the trash commit can leave a job that later fails `file_unavailable` (accepted by the design).
- Without a running scheduler `jobHost.cancel` is a no-op (`apps/desktop/src/main/job-host.ts`), so a queued job of a trashed file can survive the delete; it later fails `file_unavailable` or is removed by the purge.
- `trash:empty` counts an unexpected per-item error as failed without logging it.
- `touchingJobs` in `apps/desktop/src/main/library-handlers.ts` raises the job change counter after every trash, restore and purge, even when no job was touched.

Found during the build — renderer:

- The `Delete` key acts only while a file item has focus, narrower than the design's "when focus is not in an input".
- A failed `trash:summary` is swallowed and not retried (`trash-context.tsx`); the badge stays stale or missing until the next delete, restore or purge.
- `throwFirst` (`apps/desktop/src/renderer/src/trash-actions.ts`) rethrows the first per-item failure by message and drops its error code.
- The single delete and the selection delete have separate busy guards (the inbox selection Delete has its own); an overlap reports "already in the trash".
- A failed single restore shows the error message instead of the count strip; the Empty trash count can be one reload behind.
- Trash tiles and table rows still show the proposal marker, hinting at Review tags, which the trash does not offer.
- The nine-column trash table may be too wide; the Confirm/Cancel order differs between the confirm dialog and other dialogs.
- `TrashScreen`'s `exclusive` returns without clearing the pending confirmation when an action is already running, and a replaced pending confirmation with `settle` would stay unsettled (both unreachable while the buttons are disabled and the dialog is modal).
- Import order in the touched renderer files is not consistent.

Tests:

- Not tested: a file trashed while the analysis handler re-reads the image; the order of the trash check and the stale check when accepting a proposal; the `retryJob` race in which the file is trashed between the check and the retry and the caller gets the "active job" message.
- Core and jobs: the open test cannot detect a swapped order of move recovery and sweep; the fake `onPurge` does not clear a chosen cover; the scheduler test does not pin the purge order (cancel, then row removal); the proposal-accept refusal for a trashed file is pinned only at core level; `wake()` after a trash action is not pinned.
- Renderer: no tests for Delete from the asset-tab detail dialog, the trash count refresh after an asset-tab or single delete and after restore, purge and Empty trash, a partial failure and a double Delete in the inbox, focus after a delete, the double-submit guard, Esc while busy and purge from the detail dialog in the trash; the search-field Delete test is weak; the selection-bar tests do not pin the absence of other actions.
- The acceptance test's "images" are text files named `.png`; its comment does not say so.

## Editable prompts

Deferred by design:

- No prompt per asset type, project or workspace, no version history of a prompt, no import or export, no placeholders, and no tag vocabulary appended to a prompt.
- A file keeps one set of AI tags and one waiting proposal whatever prompt produced them; the prompt is not part of the fingerprint, so another prompt redoes a file only through "Analyse again".
- A file already queued with another prompt counts as `alreadyQueued` and keeps the prompt it was queued with.
- The Jobs screen shows neither model nor prompt.

Found during the build — main process:

- `markUsed` in `apps/desktop/src/main/analysis-prompts.ts` catches around `load()` as well, so a prompt file that cannot be read while the prompt used last is stored is logged as the write warning instead of failing.
- After a failed write of the prompt used last, the store keeps the previous value in memory too, so the dialogs preselect the earlier prompt until the next successful write.
- The `TOO_MANY` message is built from `ANALYSIS_PROMPTS_PER_PURPOSE` instead of being a literal fixed string (same text today).

Found during the build — renderer:

- A save or reset answer in `PromptSettings` can be overwritten by an older list answer still in flight; save, delete and reset should supersede a pending reload (bump `reloadRequest` in `analysis-prompts-context.tsx`).
- Reset drops text typed into the editor while the call runs.
- An error of a prompt action outlives a change of the selected prompt.
- A tag limit typed as `015` counts as an unsaved change of `15`.
- The unsaved-changes marker in the prompt list is `aria-hidden`, so a screen reader does not learn of unsaved changes.
- The Image to prompt dialog names both the prompt select and the result text "Prompt".
- While the analysis prompts load, the start button's tooltip of the three dialogs is `START_LOADING`, "The provider settings are loading", instead of a text about the prompts.
- A failed prompt reload leaves the three analysis dialogs on "The analysis prompts could not be read" with no Retry or Settings action in the dialog; the only retry is in Settings > Prompts.
- Reset in the Prompts settings overwrites a saved text without confirmation, while Delete confirms (owner's call).
- A hand-edited `analysis-prompts.json` with more than 50 prompts per purpose or duplicate names is accepted on load; only ids are checked for uniqueness.
- A choice whose prompt vanished from the list through a reload shows "choose a prompt" instead of falling back to the default.
- The `not_found` handling (reload and drop the choice) is copied in the three dialogs.
- A `not_found` start shows the generic "This item no longer exists." text.
- `promptGate` does not check the purpose of the chosen id (the main process does).

Tests:

- `analysis:describe` without `promptId` (fallback to the prompt used last, then the first) is not tested at the channel level.
- The read-error test of the prompt store asserts only that it throws, not the error.
- `chatContents()` is duplicated in `describe.test.ts` and `jobs-ipc.test.ts`; the marking of the prompt used last after a cancelled describe is not asserted in `describe.test.ts`.
- Renderer: no test for a superseding reload of the prompt list or for the busy guard of the prompt actions; `installFakeApi` consumes two ids per call for the seeded default prompts.

## Tag rename and merge

Deferred by design:

- No tags page listing all tags; a tag is renamed only from an editable tag chip.
- No rename from read-only chips (gallery tiles, tables, the trash) or from the tag filter.
- No undo of a rename or merge.
- An open proposal review dialog keeps the names it loaded: after a rename of one of them, Accept is refused and the dialog must be reopened.
- A merge target without any assignment (an unused tag row) is offered as a merge with zero counts.

Left from the reviews:

- Renderer: the restore-capture block on a rename reload is repeated in `AssetsScreen`, `ProjectsScreen` and `FileBrowser`, and the `useRenamed` bodies of the inbox, the trash and the asset Files tab are near-identical; both want one shared helper.
- Renderer: `onRenamedRef` in `tags-context.tsx` is assigned during render (the same pattern as elsewhere in the renderer).
- Renderer: the gallery's last selected asset is rewritten in a ref and shows only with the reload's re-render; its `matchedTags` are not rewritten.
- Tests: the position test of the asset Files tab after a rename does not reproduce a jump to the top under jsdom; the large merge test (3000 files) uses inbox files only; the in-memory tag fake does not model `createdAt`.

## ZIP import

Deferred by design:

- No progress display and no cancel for a running import, also not while an archive is unpacked.
- No archive format other than ZIP (7z, RAR, tar, gz).
- No password-protected archives; an encrypted entry is refused.
- No nested archives: a `.zip` entry is refused, not unpacked.
- No unpacking of a ZIP that already sits in the workspace as a file.
- No free-space check before unpacking; only the entry-count and declared-size limits bound what one import writes.
- No folder structure: entries are imported flat under the last segment of their path.

Found in the final review and not fixed:

- A stored entry with a wrong declared size and an archive with strong encryption fail the whole archive (`This file is not a readable ZIP archive`) instead of one entry.
- The result strip is neither bounded nor virtualised; one import can show up to 5000 failure lines.
- Test gaps: Esc in the "ZIP archive" choice dialog is tested only in the inbox; `openEntry` racing `close()` is untested; `apps/desktop/test/import-result.test.ts` imports renderer test helpers (`test/renderer/fake-api.ts`, `fixtures.ts`).
- `useZipChoice` leaves a pending promise when the screen unmounts or `choose` is called twice.
- `AssetScreen` has no synchronous re-entry guard like the inbox's `importingRef`.
- Three variants of "last path segment" exist (`import-file.ts`, `import-archive.ts`, `workspace-manager.ts`).
- The acceptance test for an entry with a wrong declared size only checks that the error carries no workspace path, not the exact fixed message.
- An entry whose file name is longer than 255 characters and has a refused extension answers `This archive entry cannot be imported`, not the refused-type message (the length check comes first).

## Asset sources

Deferred by design:

- No further fields on a source (title, author, licence, note, retrieval date).
- No sources on single files or on projects.
- No search or filter by source.
- No editing a source in place and no reordering (remove and add again).
- No adding several URLs at once.
- No fetching of any kind: no page title, favicon or reachability check.

Found in the final review and not fixed:

- Remove has no in-flight guard: a double click on `Remove source` sends two requests and the second shows a not-found alert.
- After an add the `Add URL` input takes focus again even when the user has moved focus elsewhere meanwhile.
- The alert of a failed copy stays until a later copy succeeds.
- Test gaps: the scroll threshold of the list and the double-Enter guard are tested only through class names and `disabled` (jsdom cannot measure layout).
- Writing a source and touching the asset's `updated_at` are two statements, not one transaction (as for tags).
- An `assets:get` reload already in flight can briefly show the asset without a source that was just added (the same pattern as for tags).
- How Windows treats `^`, `|`, `&` and a backtick in a query string handed to `shell.openExternal` is unverified.

## Vision providers

Deferred by design:

- No second kind of provider (OpenAI-compatible servers, vLLM, a llama.cpp server, RunPod serverless); every entry speaks the Ollama API (see the note on the provider id routes under "Main process").
- No automatic failover: the app never moves jobs or switches a provider by itself.
- No starting, stopping or loading anything on a provider (pods, Ollama model load control).
- No setting for parallel analyses per provider; each provider runs one at a time.
- No moving of a running job or of single jobs picked from the list; a move is all waiting jobs of one provider.
- No background polling of reachability; a state is checked when a dialog, the select or the settings ask.
- No record of which entry produced a stored analysis; the stored model name stays the record.
- No paid providers and no safeguards for them.
- Jobs in workspaces that are not open are not checked when an entry is deleted; such a job later fails as `provider_not_configured` and can be moved.
- Jobs without a provider are assigned to the first entry only when a workspace is opened, not when the first entry is created.
- The origin binding of a key lives in the plaintext settings file (it is the stored base URL), now per entry.
- The Jobs-screen provider filter offers `All providers` and the existing entries; there is no option for jobs without a provider or for the lanes of a deleted provider.
- In environment mode an unusable `ASSETFORGE_VISION_BASE_URL` gives an empty provider list rather than one entry that reports the error.

Found in the final review and not fixed:

- Opening a dialog or the provider select discards each entry's last answer before re-checking, so a ready entry shows as being checked and Start is blocked until the answer arrives.
- A failed reload with a list already held is visible only to the caller.
- A pending key removal is not shown and cannot be undone before saving.
- Focus is lost after deleting an entry in Settings.
- The delete guard is check-then-act: a job queued at that moment fails as not configured and can be moved.
- Key temporary files are swept only at start.
- The waiting count in the move dialog is not refreshed while it is open.
- Jobs of a deleted provider cannot be filtered on the Jobs screen.
- The result dialog re-checks all entries and drops a manual provider pick on every file switch.
- `listTimeoutMs` is not clamped.
- `assignLane` with a rewrite that answers `undefined` behaves differently in the SQLite repository and the in-memory repository of the core tests; `rerouteWaiting` does not refuse the same lane itself (the host does).
- `list({ lane: null })` matches no row in the SQLite repository; `nextRunAfter(types, [])` is not pinned by a test.
- `pause.paused(rc)` is called unguarded when the scheduler computes the excluded lanes.
- No test for a caller abort of `listModels`; `MAX_TIMER_MS` is a magic value on the model-list request.
- `listWaitingLanes` runs one query per lane.
- Model-list answers of entries that no longer exist stay in the renderer's provider context.
- `internal_error` on the model list with a stored model (no Settings offer) is untested in the start dialog.
- Move jobs dialog: the source name shows `Removed provider` until the lanes arrive; an old refusal stays visible after the source changes; a failed lane lookup leaves the disabled Move without a tooltip.
- `shell.test.tsx` no longer asserts the Settings button for `provider_not_configured` nor the path from the banner to the Settings screen through `WorkspaceShell`.
- The acceptance test pins "one job at a time per provider" weakly; no desktop test runs a v1 job to success; no desktop test queues a job in environment mode.
- `providers:list` decrypts every stored key on each call to answer `hasApiKey`.
- Moving jobs into a paused target lane leaves them waiting there with no hint in the dialog.

## Generation studio

- Trashing the source image of a generation cancels its running job, which aborts the paid request; the provider may already have charged it.
- A job enqueued while "Cancel all" waits for running jobs may still start.
- "Cancel all" answers 0 while no scheduler exists; the reconcile of pending generations on the next workspace open is the safety net.
- One inconsistent provider entry (for example a `venice` entry with a plain `http` base URL to another machine, or an entry that breaks the kind rules) sets the whole `provider-settings.json` aside as unreadable, including the link to every stored key. This is the existing corrupt-file policy, widened by the kind rules.
- The Venice adapter was built from the vendor's documentation and tested only against the mock provider. The price shape in `pricing`, the `/image/edit` request (experimental at the vendor) and the answer types are assumptions until they are checked with the real service.
- The full-size rendition sent to the provider is capped at 8192 px per edge (`PREVIEW_EDGE.full`), so a larger image that is not sent as is arrives downscaled; the result is smaller than the source then.
- Upscale checks only the pixel bounds of the app and of the input; the provider's own upscale limits are not read.
- Result names (`<source name> edit <n>`, `<source name> <scale>x`) may repeat after a generation was removed or its file purged.
- A failed import of a paid answer leaves a failed file row in the inbox. The generation ends as `provider_outcome_unknown` only when the answer stream itself failed; a local import failure (disk full, checksum mismatch) ends it as `internal_error`, although that request was certainly charged.
- The image provider used last is not tracked in the renderer: it is not preselected in the studio until the provider list is reloaded, and the upscale from the file menu names no entry so that the main process resolves it.
- An image that is still too large for the provider after the rendition (or whose rendition cannot be produced) is refused only when the job runs (`file_unavailable`), not at start as the design says.
- A purge shortly after trashing the source of a running generation deletes its job row; the generation then stays `pending` until the reconcile on the next workspace open.
- The guard that refuses deleting a provider entry with active jobs sees only the open workspace; jobs of that entry in another workspace fail later with `provider_not_configured`.
- Tag edits in a file dialog opened from a link (source or result) do not reach the host list until it reloads; the linked dialog shows the asset name as plain text.
- Opening a result from inside the studio does nothing visible when the file can no longer be read.
- The upscales of the previously selected result show briefly under a newly selected one; the two result loads share one error slot.
- A circular import between `studio-context`, `FileDetailDialog` and `GenerationDetails`.
- No desktop test with a JPEG or WebP provider answer; a job found `running` after a crash is tested only in `packages/jobs`.
- An upscale of an upscale is reachable only through that file's own studio.
- A failed Generate start is visible only in the button tooltip.
- There is no workspace-wide generations screen and no marker or filter for generated files in the file lists.

## Not covered by any automated check

The native confirmation for removing a workflow, native file and directory dialogs (and therefore the "Choose location", "Open existing folder" and "Import files" buttons end to end), window appearance, focusing the existing window on a second launch, the `shutting_down` response, the rejected-invoke path to `ApiError`, `formatDateTime`, the rendered messages for `unsupported_format_version` and `workspace_mismatch`, and keyboard-only operation beyond the tag rows, the file selection, menus, tabs and the dialog focus return. Phase 4b: the production `SecretCodec` over Electron `safeStorage` (`apps/desktop/src/main/secret-codec.ts`); the tests use a fake codec.
