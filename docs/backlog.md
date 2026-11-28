# Backlog

Findings from the phase 1, phase 2, phase 3a, phase 3b, UI redesign, image viewer, phase 4a, phase 4b, file trash, editable prompts, tag rename and merge, ZIP import, asset sources, several vision providers, generation studio and video playback reviews that were deliberately not fixed. Nothing here blocks the next phase; triage the list whenever a plan touches the area.

## Requested features

Asked for by the owner on 2026-11-26; none is designed or scheduled yet. Each needs a design before a plan.

- **Duplicate check by hash.** The content hash is used to avoid duplicates. Today an import only reports that a file with the same SHA-256 already exists (`duplicateOf`, counted in the inbox's import result) and imports it all the same. Decided by the owner: a duplicate is never skipped (files would be missing and the user would wonder why) but is clearly identifiable, on an import into an asset as well as into the inbox; the check is workspace-wide (the same content may already sit in another asset the owner did not think of searching for); there is a "Find duplicates" action for what already exists; files in the trash do not count. Open for the design: how a duplicate is marked and where the marker stays visible after the import (tile, table, detail dialog, filter), how the other copies are reached from it, what "Find duplicates" shows and which actions it offers, and whether a stored hash index is needed.
- **Image captions for LoRA training** (asked for on 2026-11-27). One stored caption per image file, as flowing prose (not a tag list), editable by hand and producible by the vision provider (single and as batch jobs), with manual and AI origin kept apart so a re-analysis never overwrites a hand-written text. Not part of the search index, no trigger word. Image to prompt already produces such a text but does not store it. An export of images with a same-named `.txt` belongs to it. Needs its own design round.

## Correctness and robustness

- `LocalStorage.move` checks for the target and then renames; a target created in between can be replaced.
- A file move whose commit fails leaves the file row pointing at the old path until the workspace is opened again.
- Quitting the application waits for a running import; reads are not ordered against `close`.
- File names are truncated by code points, so long non-ASCII names can exceed a 255-byte limit (ext4, Samba).
- The same folder reached through a drive letter and a UNC path is reported as `workspace_duplicate`.
- `EPERM` from a locked file is reported as `storage_access_denied`.
- Non-domain import errors are not logged anywhere; the recovery results (imports and file moves) are not logged either.
- Pre-migration database backup; migrations path for the packaged app.
- Hashing moves off the main event loop once jobs exist.
- `createAsset` inserts the asset and then starts its default workflow; the two are not atomic, so a failure in between leaves an asset without the workflow of its type.
- A built-in template whose version row is missing is only repaired the next time the workspace is opened.
- Preview requests are not cancelled when a tile scrolls away; that needs a cancel signal from the renderer.
- When the preview worker module cannot load, every queued job still starts a fresh worker; the failure line is logged once until a worker answers again.
- The session failure memory of the preview service also remembers worker timeouts and crashes (the pool reports every failure as the same `none`/`null`); it now keeps at most `MAX_REMEMBERED_FAILURES` (10 000) keys per memory, the oldest forgotten first.
- The derived-data rebuild still runs on the main process while a workspace opens (about 1.7 s at 10 000 assets); it yields to the event loop between batches of 500, but each batch blocks it. The step also runs on every new workspace.
- `asset_search_map` rowids: once assets can be deleted, the FTS row and the map row must be deleted together; otherwise rowid reuse attaches a stale index row to a new asset.
- `FileKindSchema.catch('other')` in the file repository hides an invalid stored kind.
- The search plans rely on `cross join` to fix the join order in the tag filter; the scale test guards it.
- `files:assignMany` holds the exclusive workspace queue for the whole batch.
- Tags stored before the letter-or-digit rule that consist only of symbols cannot be removed through the UI; a symbol-only name in the tag filter is rejected with `validation_failed`.
- Unused tag rows are never deleted (a merge deletes only its source row).
- `InMemoryStorage.absolutePath` and `LocalStorage.absolutePath` behave differently when the storage is unreachable.
- Decoder byte limit of 256 MiB: an uncompressed 16-bit RGBA 8K TIFF (about 265 MB) gets neither dimensions nor a preview. Raising the limit is an owner decision.

## IPC and security

- Track dialog-granted paths: `files:import` and `workspace:open` currently accept any absolute path sent by the renderer.

## Renderer

- In-place list updates (`docs/superpowers/specs/2026-11-27-in-place-list-updates-design.md`), known limits: a patch replaces loaded rows and never adds or removes one, so with a status filter on the Jobs screen a job that left the filter keeps its row, a job that entered it does not appear, and pages loaded afterwards are shifted, until the filter is set again or a `jobs` change refreshes the list; the same holds for a file list with a filter the analysis moves a file into or out of (for example Proposals). The asset gallery, the projects list, the prompts list and the asset header (cover, tags) do not react to background jobs. More than 100 changed loaded records in one poll fall back to a refresh of the visible pages. An action on the Jobs screen reloads through its key and is followed by one redundant in-place refresh from the feed.
- In-place list updates, not checked in the running app: whether the virtualised grid keeps its visual position when a refresh changes the total above the visible area, and how a large analysis batch feels on the asset Files tab and the Jobs screen.
- Lists used as pickers and filters (projects in the asset list, asset and project pickers) load at most 200 entries.
- The project member table still pages by 50 instead of scrolling endlessly like the other lists.
- No settings for the cache size and location; the preview worker timeout (30 s) is a constant.
- The failed-measurement memory of `measureVideo` is keyed by format and source path, so a video changed in place keeps its failed measurement for the session.
- `Cache-Control` max-age on previews assumes the content of a file ID never changes (true until working-file re-hashing in phase 6).
- `CoverImage` keeps a failed id per instance, so non-virtualised tiles stay on the format tile after the storage returns until the user navigates away and back.
- Focus is lost when a focused placeholder becomes a Retry button.
- Multi-file Detach is a renderer loop over `files:unassign`.
- The project member table has no cover (the contract lacks it).
- Tag filter chips show the normalised name, not the display name.
- Body text uses Tailwind `text-sm` (14 px) in buttons and tables where the design names 15 px.
- Retry on the storage banner during an import remounts the page and clears the busy block; navigation and "Import files" are free while the main process still imports, and the result strip is lost.
- The asset Files tab batch tag changes bypass the action guard (the tags dialog is modal; a guard would silently drop a typed tag).
- The Selection column is empty after a remount while the selected page is not loaded.
- Candidate, not verified: the tile menu in the last visible row and the "More" menu at the bottom of the file dialog panel may be clipped.
- Image viewer, left out on purpose: neighbouring files are not preloaded; 16-bit and wide-gamut TIFF are converted to 8-bit sRGB in the PNG rendition; the viewer cannot be opened from the asset gallery (only from file lists).
- Image viewer zoom: a fast Ctrl+wheel can lose zoom steps; a `reduced` rendition at 100 % is upscaled by a non-integer factor.
- Image viewer browsing: `ViewerList.want` has a new identity on every render.
- Image viewer layout: Fit uses the whole-number `clientWidth`/`clientHeight` of the frame, so at a fractional `devicePixelRatio` the fitted box can be up to half a CSS pixel larger than the real stage and loses an edge pixel (measure with `getBoundingClientRect` and floor to the device grid); a rotated layer can sit half a device pixel off the box; the stage's own position on screen may be off the device grid; Ctrl+wheel over an on-stage arrow does not zoom; the tag input is named "Add image tag" for non-image files too; a horizontal film-strip scrollbar clips the tiles; the toolbar is cut off in very narrow windows; in the inbox the heading "Assign" sits above a button "Assign". Untested: Fit ignoring a client area shrunk by scrollbars; no on-stage arrows for a list of one file.

## Code structure

- Readability for a human developer (owner's request, 2026-11-27): the code is hard to follow and to extend by hand. Wanted as a rule for new code and as a pass over the existing code, without behaviour changes: every function documented with a description, its parameters and its return value; no promise-returning functions defined inside other functions where a named module-level function or a small state machine does the job; large files split by responsibility (`site-sessions.ts` done in the readability pilot, `provider-store.ts`, `FileBrowser.tsx`, `start()` in `index.ts`); descriptive names instead of one-letter ones, also in tests; a developer guide (`docs/architecture.md`) with one request traced from click to database and recipes for common extensions; Prettier and ESLint to hold the rule.
- Readability pilot leftovers (2026-11-28): `download-handler.ts` is close to 400 lines, most of it doc comments; `sessionHop` and `fetchHop` stay promise executors with small closures; `PageLoad.poll` sets `isPolling` once and never resets it, so the poll started by `dom-ready` is the only one of a load (behaviour kept); the session hop is not pinned to the vetted address (the session's request filter vets the host a second time, by design).
- Renderer AI readability leftovers (2026-11-28): `JobsScreen`, `GenerationStudio` and `StudioForm` keep component bodies over 40 lines, almost all of it JSX.
- The workflow progress rule exists three times: `progressOf` in the adapter, the SQL of the asset list, and the in-memory fake (adapter and SQL are pinned to agree by `workflow-repositories.test.ts`; the fake is not).
- `AssetsScreen`, `AssetScreen` and `FileBrowser` are large and want splitting.
- `FileBrowser.tsx` should hand its viewer state machine to a `useViewerList` hook.
- Core ports split (2026-11-28, `packages/core/src/ports/`): the type names `StorageRef`, `GenerationFileRef`, `GenerationPromptRef` and `WorkspaceMeta` (and the field `NewGeneration.promptRef`) keep the short forms `Ref` and `Meta`, which the style file does not list as established; renaming them touches persistence, desktop and the core bodies. `GenerationRow` is a plain alias of the contracts type `Generation` and could go. `RemoteFileError` takes `retryAfterMs` as a positional parameter beside an options object holding `cause` and `status`. The repository methods still take their arguments as inline object types (one per method) rather than named request types, so implementers repeat them. `JobRepository` documents `FILE_DOWNLOAD_JOB` and `analysisJobFields`/`downloadJobFields` behaviour, so the persistence port knows two job types by name.
- Core file readability pass (2026-11-28): `ImportRun` in `import-file.ts` and `ArchiveRun` in `import-archive.ts` are plain mutable records passed between steps rather than classes; turning them into classes would move the journaled order into methods, which this pass avoided.
- Core domain readability pass (2026-11-28): `settleGenerationOfJob` stays in `generations.ts` because `file-trash.ts` imports it.
- Renderer files lane readability pass (2026-11-28): the component bodies of `FileBrowser`, `FileDetailDialog`, `AssetScreen`, `AssetsScreen`, `InboxScreen` and `SiteImportDialog` and the `Stage` of `ImageStage` stay over 40 lines, because they are hook wiring in a fixed order plus flat JSX; `useVirtualRows` is about 95 lines for the same reason. The nested JSX ternaries in `FileListBody`, the stage of `FileDetailDialog` and the body of `AssetsScreen` stay. The `disposed` ref of `UrlImportDialog` and the `live`/`active` flags of `FileOrigins` and `AssetSelection` could become one small hook. Splitting a hook body into smaller hooks moved `useState` slots (React state order inside the same component), which is invisible but not literally the same fiber layout; the `useId` strings of the inputs moved into `SiteProfileForm` differ from before.

## Tooling and tests

- Split the desktop `tsconfig` into DOM (renderer) and Node (main, preload) configurations.
- Crash-recovery test on the real adapters (currently only on the fakes).
- Tests for the "ignore removal errors" branch of `importFile` (core). Storage: a real non-junction symlink (needs the symlink privilege on Windows; the dangling-link tests use junctions) and real case folding on a case-insensitive file system of another OS are not covered.
- The in-memory fakes approximate BM25 by a two-bucket rule (name matches first, then the rest).
- `check-sharp.mjs` is a manual gate and not part of `pnpm test`; it has no worker `exit` listener.
- The test setup emulates Esc; some tests assert class substrings.
- Flaky jsdom test under load (pre-existing, timing-sensitive): inbox "filters and scroll offset survive navigation". The assets and projects "list state round trip" tests, which failed the same way, were hardened in phase 4b: they now wait until the list has settled (no `aria-busy` left) before the click and wait for `aria-selected` after it. Their failure was not reproduced, so the root cause is unconfirmed.
- Image viewer tests: no tests for the anchored scroll offsets and for Fit following a stage resize; `show(125)` alone and a file shifting across a page boundary are untested; the rejected-fullscreen test would pass without the `catch`; no end-to-end test "import stores oriented dimensions" through the real composition.

## Phase 4a

Deferred by design:

- No attempt history: a job keeps only its attempt counter and the error of its latest run (ReadMe §10). Needed at the latest for paid jobs in phase 5.
- The file name on the Jobs screen is plain text, not a link to the file.
- Job rows are only removed by "Clear finished"; there is no age-based cleanup of finished jobs.

Found during the build:

- Tag cleaning (`cleanTagText`, shared by manual and AI tags) does not strip control and format characters (`\p{Cc}`, `\p{Cf}`: NUL, zero-width characters, bidi overrides), so a model answer can produce invisible or visually spoofed tags. Fixing it changes stored names and needs a `DERIVED_DATA_VERSION` bump.
- A handler that ignores its abort signal hangs `stop` and with it the workspace close and quit.
- `pool.jpeg` is not abortable (up to 30 s), so a workspace close during an analysis can wait that long.
- Nothing ties `errorMessage` to the fixed message of `errorCode` in the contract schema; the stored pair is only correct because every writer uses `JOB_ERROR_MESSAGES`.
- Inbox and asset screen: the counts of a start replace an import failure list in the shared strip even when it was not read yet.
- Jobs screen: an action reloads the list twice (its own reload token, then the poll that sees `changes` move). A clean fix needs an immediate feed read in the jobs context after an action.

Tests:

- Mock provider: scripted failures are consumed before the model and image checks; `apps/desktop/test/providers-acceptance.test.ts` counts on that order (a scripted `hang` is used up even for a chat with an unknown model).
- A real 50 ms sleep before a negative assertion remains in `jobs-ipc.test.ts` (there is no event to wait on).
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
- A host with a trailing dot counts as a different origin, so the stored key is deleted on such a change.

Provider settings (`apps/desktop/src/main/provider-store.ts`):

- A direct save that breaks the schema answers `invalid_operation` rather than `validation_failed`.

Main process (`apps/desktop/src/main`):


Mock provider (`docker/mock-provider/server.mjs`):


Scheduler and pause gate (`packages/jobs`):


Persistence:

- The proposal reader (`parseTags` in `file-analysis-repository.ts`) returns an empty tag list for stored JSON that does not parse or is not an array and drops malformed entries, where the list readers throw; it does not validate tag names.
- No test pins that the renderer's `analysable` (`file.previewable`, without the checksum) agrees with `isAnalysable` in core; the reader's SQL predicate is pinned against core.

Renderer:

- Accept can race a newer proposal of the same file; the fix needs the proposal's `createdAt` in the `analysis:acceptProposal` contract, which carries only `fileId` and `names`.
- The preview counts a file that is analysed and also queued only as `alreadyAnalysed`, so with "Analyse again" the start dialog counts it under "To analyse" (`wouldEnqueue`, `AnalysisStartDialog.tsx:41-42`) while "Already queued" shows 0; the enqueue with `force` then answers it as `alreadyQueued` and the strip shows "0 queued, 1 already queued". There is no dedicated dialog state for 0 enqueued (only the strip).
- A propose request for a file that already has an active apply job is shown as the dialog's own job (`AnalysisResultDialog.tsx:166-175`, `packages/core/src/analysis-enqueue.ts:74`): the dedupe key is per file, the enqueue answers `alreadyQueued`, and the dialog treats that as success. After "Analyse all", opening one of its files and clicking Analyse shows Queued or Running; on success the tags are applied without review and the dialog ends empty. Possible fix: carry `mode` in the `JobView` of `analysis:getProposal` and show a fixed "already being analysed in a batch" state.
- The result dialog's busy state can flicker for one frame after a file switch.

Renderer tests:

- The settings route of `AssetFilesTab` (closing the file detail dialog before Settings opens) has no dedicated test, only the inbox's; the result dialog's disabled Settings during an import is covered only by a shell test.

Core tests:

- The core fingerprint tests do not cover every field separately for a waiting proposal (checksum, prompt version); the SQL side is pinned.

## File trash

Deferred by design:

- Nothing empties the trash automatically; there is no retention period (owner decision).
- Assets and projects cannot be deleted.
- The trash is in the app only, not the operating system's recycle bin.

Found during the build — core and persistence:

- Binaries left in `.assetforge/trash/` by a purge before migration `0009` have no tombstone and are never swept.

Found during the build — main process and jobs:

- `trash:empty` counts an unexpected per-item error as failed without logging it.
- `touchingJobs` in `apps/desktop/src/main/library-handlers.ts` raises the job change counter after every trash, restore and purge, even when no job was touched.

Found during the build — renderer:

- The `Delete` key acts only while a file item has focus, narrower than the design's "when focus is not in an input".
- A failed single restore shows the error message instead of the count strip.
- The nine-column trash table may be too wide; the Confirm/Cancel order differs between the confirm dialog and other dialogs.
- Import order in the touched renderer files is not consistent.

Tests:

- Not tested: a file trashed while the analysis handler re-reads the image; the order of the trash check and the stale check when accepting a proposal; the `retryJob` race in which the file is trashed between the check and the retry and the caller gets the "active job" message.
- Core and jobs: the open test cannot detect a swapped order of move recovery and sweep; the fake `onPurge` does not clear a chosen cover; the scheduler test does not pin the purge order (cancel, then row removal); the proposal-accept refusal for a trashed file is pinned only at core level.
- Renderer: no tests for Delete from the asset-tab detail dialog, the trash count refresh after an asset-tab or single delete and after restore, purge and Empty trash, a partial failure and a double Delete in the inbox, focus after a delete, the double-submit guard, Esc while busy; the search-field Delete test is weak; the selection-bar tests do not pin the absence of other actions.
- The acceptance test's "images" are text files named `.png`; its comment does not say so.

## Editable prompts

Deferred by design:

- No prompt per asset type, project or workspace, no version history of a prompt, no import or export, no placeholders, and no tag vocabulary appended to a prompt.
- A file keeps one set of AI tags and one waiting proposal whatever prompt produced them; the prompt is not part of the fingerprint, so another prompt redoes a file only through "Analyse again".
- A file already queued with another prompt counts as `alreadyQueued` and keeps the prompt it was queued with.
- The Jobs screen shows neither model nor prompt.

Found during the build — main process:


Found during the build — renderer:

- Reset in the Prompts settings overwrites a saved text without confirmation, while Delete confirms (owner's call).
- A hand-edited `analysis-prompts.json` with more than 50 prompts per purpose or duplicate names is accepted on load; only ids are checked for uniqueness.

Tests:

- `installFakeApi` consumes two ids per call for the seeded default prompts (harmless; changing it would shift ids in existing tests).

## Tag rename and merge

Deferred by design:

- No tags page listing all tags; a tag is renamed only from an editable tag chip.
- No rename from read-only chips (gallery tiles, tables, the trash) or from the tag filter.
- No undo of a rename or merge.
- An open proposal review dialog keeps the names it loaded: after a rename of one of them, Accept is refused and the dialog must be reopened.
- A merge target without any assignment (an unused tag row) is offered as a merge with zero counts.

Left from the reviews:

- Renderer: the restore-capture block on a rename reload is repeated in `AssetsScreen`, `ProjectsScreen` and `FileBrowser`, and the `useRenamed` bodies of the inbox, the trash and the asset Files tab are near-identical; both want one shared helper.

## ZIP import

Deferred by design:

- A cancel stops an unpacking archive only between entries, never inside one (see "Import progress").
- No archive format other than ZIP (7z, RAR, tar, gz).
- No password-protected archives; an encrypted entry is refused.
- No nested archives: a `.zip` entry is refused, not unpacked.
- No unpacking of a ZIP that already sits in the workspace as a file.
- No free-space check before unpacking; only the entry-count and declared-size limits bound what one import writes.
- No folder structure: entries are imported flat under the last segment of their path.

Found in the final review and not fixed:

- A stored entry with a wrong declared size and an archive with strong encryption fail the whole archive (`This file is not a readable ZIP archive`) instead of one entry.
- The result strip is neither bounded nor virtualised; one import can show up to 5000 failure lines.
- Test gaps: `openEntry` racing `close()` in the ZIP import is untested (main).
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

- Test gaps: the scroll threshold of the list and the double-Enter guard are tested only through class names and `disabled` (jsdom cannot measure layout).
- How Windows treats `^`, `|`, `&` and a backtick in a query string handed to `shell.openExternal` is unverified.

## Vision providers

Deferred by design:

- No other kind of analysis provider than Ollama-compatible and OpenAI-compatible (RunPod serverless API, native vendor APIs).
- No automatic failover: the app never moves jobs or switches a provider by itself.
- No starting, stopping or loading anything on a provider (pods, Ollama model load control).
- No parallel-requests setting in environment mode: its one entry is read-only and runs one analysis at a time.
- With many parallel requests the media worker pool, which prepares the image of every analysis request, may become the bottleneck; its size is not configurable.
- With a high parallel-requests value an outage spends an attempt on every request in flight before the pause gate trips; a throwing lane-limit lookup is logged once per claim rather than once.
- No moving of a running job or of single jobs picked from the list; a move is all waiting jobs of one provider.
- No background polling of reachability; a state is checked when a dialog, the select or the settings ask.
- No record of which entry produced a stored analysis; the stored model name stays the record.
- No paid providers and no safeguards for them.
- Jobs in workspaces that are not open are not checked when an entry is deleted; such a job later fails as `provider_not_configured` and can be moved.
- Jobs without a provider are assigned to the first entry only when a workspace is opened, not when the first entry is created.
- The Jobs-screen provider filter offers `All providers` and the existing entries; there is no option for jobs without a provider or for the lanes of a deleted provider.
- In environment mode an unusable `ASSETFORGE_VISION_BASE_URL` gives an empty provider list rather than one entry that reports the error.
- No environment mode for the `openai` kind: `ASSETFORGE_VISION_BASE_URL` yields one `ollama` entry.
- The thinking switch of the `openai` kind sets only `chat_template_kwargs.enable_thinking`; a model steered another way needs its parameter in the extra parameters.
- No capability report for `openai` entries: every model the server lists is offered, with `vision` unknown, so a model without vision fails at the first request.
- Options are per entry, not per model or per analysis prompt.
- Options are not part of the fingerprint: a file analysed before a change counts as analysed until `force`.
- A request in flight keeps the options it was built with; a save applies from the next request.
- The `openai` adapter and its request options were tested only against the mock provider, never against a real vLLM server.

Found in the final review and not fixed:

- A failed reload with a list already held is visible only to the caller.
- A pending key removal is not shown and cannot be undone before saving.
- The OpenAI-compatible adapter retries every HTTP 400 once without `response_format`, also one caused by the context length or an unknown extra parameter: that sends the image a second time, and after a success the model stays without `response_format` until the entry is saved again.
- A `.corrupt-*` copy beside `provider-settings.json` blocks the key-file sweep until someone removes the copy by hand; there is no cleanup of old copies and no hint in Settings that entries were left out.
- A settings file with a newer version number is set aside like an unreadable one; after a downgrade the entries are gone from the list (the keys stay).
- A key file in the old form is bound to the origin its entry has at the first start with the new code; an edit of the base URL by hand before that start is trusted once.
- Windows DPAPI is per user: the origin binding does not protect against code running as the same user.
- The API key is decrypted on every `providers:list` (for `hasApiKey`), not only per request.
- The delete guard is check-then-act: a job queued at that moment fails as not configured and can be moved.
- Jobs of a deleted provider cannot be filtered on the Jobs screen.
- The acceptance test pins one job at a time per provider only through a fixed 100 ms pause (parallel-requests test).
- `providers:list` decrypts every stored key on each call to answer `hasApiKey`.
- Moving jobs into a paused target lane leaves them waiting there with no hint in the dialog.

## Generation studio

- The Venice adapter was built from the vendor's documentation and tested only against the mock provider. The price shape in `pricing`, the `/image/edit` request (experimental at the vendor) and the answer types are assumptions until they are checked with the real service.
- The full-size rendition sent to the provider is capped at 8192 px per edge (`PREVIEW_EDGE.full`), so a larger image that is not sent as is arrives downscaled; the result is smaller than the source then.
- Upscale checks only the pixel bounds of the app and of the input; the provider's own upscale limits are not read.
- Result names (`<source name> edit <n>`, `<source name> <scale>x`) may repeat after a generation was removed or its file purged.
- An image that is still too large for the provider after the rendition (or whose rendition cannot be produced) is refused only when the job runs (`file_unavailable`), not at start as the design says.
- The guard that refuses deleting a provider entry with active jobs sees only the open workspace; jobs of that entry in another workspace fail later with `provider_not_configured`.
- Tag edits in a file dialog opened from a link (source or result) do not reach the host list until it reloads; the linked dialog shows the asset name as plain text.
- A JPEG or WebP answer of the image provider is not tested end to end; the mock only produces PNG (needs `docker/mock-provider`).
- An upscale of an upscale is reachable only through that file's own studio.
- The studio still remounts on a raise and restores a draft; the results selection, an open prompt picker and the save dialog are lost on a raise, and a start error that arrives after the studio was closed is dropped.
- A row stuck in `running` for an `image.generate` job (scheduler never started) blocks the purge of its source until the next recovery.
- `generations:retry` on a generation that was cancelled because its source went to the trash is a new paid run after a restore; nothing marks why it was cancelled.
- Not checked in the running app: the Generate lock and the kept form across a raise, a source trashed during a real generation, and the purge refusal.
- There is no workspace-wide generations screen and no marker or filter for generated files in the file lists.

## Prompt library

- Negative prompts do not exist; the only image provider takes none. The version row is the seam.
- Variables have no type, no list of allowed values and no nesting, and a template has no conditionals.
- There is no list of the generations that used a prompt, and no link from a prompt to assets or projects.
- The text of Image to prompt cannot be saved to the library directly; it has to be copied into a new prompt by hand.
- Closing the window with unsaved prompt changes is not guarded; the guard covers choosing another prompt, `New` and the main navigation only.
- There is no trash for prompts: `prompts:delete` removes the prompt and all its versions at once (generations keep the copies).
- Prompts cannot be exported or imported, and not shared between workspaces.
- `promptTitleKey` (`packages/core/src/prompts.ts`) does not NFC-normalise, unlike tags; changing it changes the stored `title_key` of existing prompts.
- Prompts screen: a second guard question overwrites the resolver of the first; this cannot be reached while the modal question is open, the first promise just stays pending.
- Some `aria-label` literals outside `labels.ts` remain in other lanes' components; the analysis constants keep their `ANALYSIS_` prefix (renaming is churn without a behaviour change). The screen's list code is copied from `ProjectsScreen`.
- No test follows the details link with a dirty Prompts draft.

## URL import

Deferred by design:

- No view that groups the jobs of one import and no import history (a nullable batch id on the job could carry one).
- The URL of a purged file is forgotten, so it can be downloaded again.
- No editing, removing, searching or filtering of origins; they are not carried on list rows.
- No perceptual hash or similar-image detection; only identical content (SHA-256) is recognised.
- Two downloads with identical content running at the same moment may both be stored.
- A host pauses for the application session only; the pause is not persisted.
- A full disk fails each download individually with `download_no_space` instead of pausing all hosts.
- No API keys, per-site headers or proxies, and no setting to relax the address check; cookies and logins exist only through a site profile (see "Site import").
- No automatic tagging or analysis after a download, and a downloaded ZIP is never unpacked.

Known gaps:

- A lane hold covers only claims: a second job of the lane that is already running is unaffected, and the hold lives in memory, so it ends with the app session, a scheduler restart or a workspace close and reopen.
- After a crash between the completed import and the job outcome, the rerun finds its own file and reports `already_present`.
- Fixed pauses still come before negative assertions in `providers-acceptance` (parallel-requests test), in `analysis-acceptance` 'pauses on a wrong key' (100 ms, twice) and in the url-import `pause(100)` with a fake clock; the dialog refresh assertion belongs to the renderer.

## Import progress

Deferred by design:

- No abort inside one file: a cancel waits until the item in progress is finished, however large it is.
- No progress of its own for a second import that waits in the workspace queue behind a running one: `files:importProgress` describes only the import that runs, and a cancel marks only that one.
- No progress for the URL import beyond the Jobs screen; its downloads are jobs.
- The progress lives in memory only: no persisted import, no import as jobs, nothing survives a restart.
- No estimate of the remaining time, no transfer rate and no name of the current file.

## Video playback

Deferred by design:

- No `mov`, `mkv`, `avi` or audio files; no conversion of a video the built-in player cannot decode (the stage offers `Open externally` instead).
- No analysis, Image to prompt or generation studio for videos.
- No choice of the frame, no preview on hover, no scrubbing over a tile, no chapters or subtitles, no loop or speed control of our own, no picture-in-picture.
- Packaging: no packager exists yet. The ffmpeg binary must be shipped outside the archive (an executable cannot run from inside `app.asar`), with the GPL licence notice and the source offer of the build, before the app is distributed; the bundled build may also have to be replaced by an LGPL one. Concretely: unpack the binary from the asar (`asarUnpack`) and swap its path to `app.asar.unpacked` before it is hashed, because a process cannot be spawned from inside an asar.
- The ffmpeg binary is verified against its checksum once per start, not before every spawn. Accepted: whoever can write there can change the app's code as well.
- The checksum of the ffmpeg binary is computed on the main process as a stream; a worker would be stricter.
- The first open of a video runs ffmpeg twice (poster frame and measurement); the measurement could be derived from the frame extraction.
- The bundled ffmpeg is 6.1.1 (from `ffmpeg-static@5.3.0`, built in 2023) and should be replaced by a current build. Only `win32-x64` has a recorded checksum; on every other platform the tool stays disabled and videos have no picture.
- A frame that failed is remembered as failed for the app session (the same `failed` memory as image previews): a video whose frame could not be made shows the placeholder until the app is restarted, even when the cause is gone.

Found while building:

- `db:generate` for migration `0016` wanted to rebuild the `generation` table, because its CHECK on `provider_kind` in the Drizzle schema includes `openai` while no migration ever added it. Migration `0016` leaves the old CHECK in place; that is harmless since generations only store `venice`, but the schema and the database disagree until a migration rebuilds the table.

Not covered by any automated check: real playback (decoding in Chromium), seeking through the `video/` route of the media protocol, the poster and the arrow, `Shift`+arrow and `Space` keys against the element's own key handling, fullscreen of the stage with a playing video, and volume and mute carried over between videos. The owner checks these by hand.

## Site import

Deferred by design:

- The request filter of the site windows vets every host once but does not pin the socket to the vetted address, so a host that changes its address afterwards (DNS rebinding) can make a page window reach a private address. Files never take this path; the downloader pins. Direction: a proxy in front of the session that connects only to the vetted address.
- A login that opens a popup talking to its opener does not work: the login window loads a popup's target in the same window, the crawl window refuses it.
- No `Referer` and no per-site headers; a site that checks them refuses the file.
- Login cookies go only to the profile's site. A file on another host (a CDN) is fetched without them.
- No endless scrolling, no "load more" and no other interaction with a page.
- The page a file was found on is not kept; the file's origin is its URL.
- The number of detail pages of a crawl has no limit of its own (only the distinct thumbnail links of at most `maxPages` gallery pages).
- `Crawl-delay` in a `robots.txt` is ignored; the gap between two pages is the fixed half second.
- A session download (spec "Browser check") vets the host's addresses before every request but is not pinned to them: Electron resolves again, so DNS rebinding can reach a private address. Direction: the proxy named above.
- A browser check that fails inside an Electron window stays unsolved; nothing solves a check automatically.
- No public-suffix list: a profile for `co.uk` covers every host below it. Single-label sites are refused; Chromium's own cookie matching bounds what would be sent.
- The crawl cannot tell an expired login from an empty gallery.
- No streamed video (HLS/DASH), no scheduled runs, no proxies, no minimum resolution.

Known gaps:

- Deleting a profile clears the partition's storage, cache and auth cache, but the partition directory stays on disk.
- A profile left out of a damaged `site-profiles.json` keeps its partition's cookies, and nothing in the app can clear them.
- A profile stored with a single-label site before the rule existed still loads; the rule applies on save.
- A slow redirect inside the site that never arrives can be reported as `no_thumbnails` instead of `timeout`: the page loader counts the page as loaded once the replaced navigation settles as aborted.
- `off_site` links are listed as problems but have no counter of their own.
- `download_login_not_sent` also covers HTTP 407 and 451 from a host outside the site, because the downloader reports them as one refusal.
- A crawl and its kept answer live in memory only; nothing survives a restart, and one crawl runs at a time for the whole app.

Not covered by any automated check: the real windows. The hidden page window, the login window and the session glue are tested with fakes, the extraction script under jsdom (whose XPath errors differ from Chromium's). The owner checks by hand: a login that survives a restart, a real gallery with pagination and detail pages, a file behind the login, a file on another host, a `robots.txt` disallow, the window title staying `<profile name> – <host>`, a navigation to a private address being refused, `loadURL` rejecting with `ERR_ABORTED` when a navigation is replaced, `will-redirect` firing in a hidden window, and the partition being empty after a profile is deleted. For the browser check (spec "Browser check"; the session download, `sites:openCheck` and the requeue are tested only with fakes, and whether the session's request filter applies to `net.request` is not verified): a real site answering `cf-mitigated: challenge`, the lane pausing with `Open site`, passing the check in the login window, Resume repeating the refused downloads, and those downloads arriving through the session. The owner's check is pending.

## Found while clearing the small items (2026-11-28)

- Cancelled Image2Prompt runs still hold a media worker until the model JPEG is made (`MAX_SETTLING_RUNS` only caps the set); passing the signal into `images.jpeg` needs core and media.
- Scheduler: `scheduler.ts` is still over the file guide.
- `PromptsScreen` and `JobsScreen` (`paged-view.ts` `failedFirstPage`) still show only Retry for a failed page; show the failure message beside it (`PageFailure.tsx`).
- `labels/*.ts`: constants are prefixed by subject (`OPEN_WORKSPACE_BUTTON`, `OPEN_PROJECT_BUTTON`) because `studio.ts` already exports `OPEN_LABEL` and `REMOVE_LABEL` and everything is re-exported from the flat `labels.ts`; a naming rule for shared verbs would avoid future clashes.
- `CoverImage` remembers a failed id for good; it needs a "storage reachable again" signal from the shell.
- The detail dialog's menu items and Delete key being disabled while the action guard is set have no dialog-level test.
- Prompt library: Discard while a create is in flight still creates the prompt (the request cannot be taken back).

## Found while clearing the backlog (2026-11-28)

- Prompt variables: `variableKey` now folds names through NFC; a stored version whose variable names differ only in their normalisation form (exotic, older data) reads as one variable.
- `enqueue` in `job-repository.ts` silently skips a job whose `fileId` is unknown or trashed (it returns no id), so the foreign key on `job.file_id` is reached only by raw SQL; callers count the inserted ids, not the request.
- A ZIP entry whose declared size is wrong fails with the generic `Import failed`, not with the fixed `This archive could not be read to the end`; the size check fails while the entry is streamed, outside the mapping in `import-archive.ts`. `acceptance.test.ts` pins the current text.
- Image viewer: the device pixel ratio listener (`useDevicePixelRatio`) is tested only with a fake `matchMedia`; whether Electron fires the resolution query on a monitor move needs a manual check.
- `WorkerPool.prioritize` matches a queued render by its target path; a render with the same target queued twice (not possible today because of the in-flight dedup) would move only the first one.
- Persistence: without `page`, `summaries` passes every matching id through `inArray` (`workflowProgresses`, `automaticCovers`); bounded by SQLite's variable limit (32766) if a caller ever lists everything unpaged.
- Scheduler: a claimed row whose put-back failed is known as never launched only in memory. If the app ends before the next pass recovers it, the recovery at the next start ends an `onInterrupted: 'fail'` job as `provider_outcome_unknown`, although nothing was sent.
- Scheduler: the lane rotation remembers at most 8 lanes per class (`ROTATION_MEMORY`), so with more than 8 busy hosts the rotation is only approximate.
- Scheduler: the leftover recovery gives the attempt back (`release`); a requeue job whose `finish` keeps failing while `release` succeeds reruns without limit.
- Test gaps: jsdom has no `scrollWidth`, so a virtualizer scroll test must stub it (see `film-strip.test.tsx`); the same applies to a test of `useVirtualRows` keeping the focused row in view.
- Flaky under full load, passing alone: `packages/media` `video-frames.test.ts > runs at most 1 processes at a time`.
- Paged screens (`JobsScreen`, `paged-view.ts` `wantedPages`, `AssetsScreen`): after a filter change the wanted pages of the old list carry over to the new key, so page 1 of the new list is fetched once before the new table reports its rows.
- Model refresh: `ModelSelect` disables Refresh while a list loads, so the superseding rule for two overlapping requests of one entry is tested only through the context.
- `useModalDialog` declares `restoreFocus` inside the hook and reads `initialFocusRef` only on open; `exhaustive-deps` is disabled there.
- `AssetScreen` is still 191 lines with nested async functions (`run`, `importFiles`); it needs the same treatment as `ProjectScreen`.
- Renderer tests waiting with `findByRole('alert')` get flaky as soon as a second alert can appear later; tests that expect exactly one alert should assert on `getAllByRole` after the loads have settled.
- File browser: Ctrl+A is ignored while a key change loads, and gives no feedback when the page that still fails is off-screen.
- URL import: a purge between the origin insert of a duplicate download and its `setOutcome` is still a window; the origin row is removed with the file and the job's result then names a file that no longer exists.
- `packages/core/src/site-crawl.ts` is over the file guide (about 330 code lines); `finalPageOf` and `kindOfUrl` could move into their own file.
- Prompts screen: the remount on `openPrompt` of a prompt already opened by link (the `visit` counter in `WorkspaceFrame`) is not covered by a test; nothing in the UI reaches it while the Prompts screen is shown.
- No test pins the progress of a workflow that has only optional steps (`{ done: 0, total: 0 }`).
- The persistence test `search.test.ts > a committed file move reindexes both assets` builds a `Storage` stub without `isReachable`; it breaks as soon as `recoverFileMoves` checks reachability on the commit path.

## Not covered by any automated check

The native confirmation for removing a workflow, native file and directory dialogs (and therefore the "Choose location", "Open existing folder" and "Import files" buttons end to end), window appearance, focusing the existing window on a second launch, the wiring of the `shutting_down` refusal in `handleIpc` (the answer itself is tested through `ipcRefusal`), the rejected-invoke path to `ApiError`, `formatDateTime`, the rendered messages for `unsupported_format_version` and `workspace_mismatch`, and keyboard-only operation beyond the tag rows, the file selection, menus, tabs and the dialog focus return. Phase 4b: the production `SecretCodec` over Electron `safeStorage` (`apps/desktop/src/main/secret-codec.ts`); the tests use a fake codec.
