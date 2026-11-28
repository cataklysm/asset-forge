# Backlog

Findings from the phase 1, phase 2, phase 3a, phase 3b, UI redesign, image viewer, phase 4a, phase 4b, file trash, editable prompts, tag rename and merge, ZIP import, asset sources, several vision providers, generation studio and video playback reviews that were deliberately not fixed. Nothing here blocks the next phase; triage the list whenever a plan touches the area.

## What belongs here

An entry belongs here only if it (a) can affect a person using the app (a wrong result, lost data, a confusing or broken screen, a real performance or security problem), (b) needs a decision of the owner, (c) is a deliberately deferred feature or scope item, or (d) is a manual check the owner still has to do.
Notes that are unreachable, harmless, theoretical or code-only, missing tests for low-risk behaviour that otherwise works, and duplicates do not belong here.
Small findings in code that is being changed anyway are fixed in the same change instead of being written down.

## Requested features

Asked for by the owner on 2026-11-26; none is designed or scheduled yet. Each needs a design before a plan.

- **Duplicate check by hash.** The content hash is used to avoid duplicates. Today an import only reports that a file with the same SHA-256 already exists (`duplicateOf`, counted in the inbox's import result) and imports it all the same. Decided by the owner: a duplicate is never skipped (files would be missing and the user would wonder why) but is clearly identifiable, on an import into an asset as well as into the inbox; the check is workspace-wide (the same content may already sit in another asset the owner did not think of searching for); there is a "Find duplicates" action for what already exists; files in the trash do not count. Open for the design: how a duplicate is marked and where the marker stays visible after the import (tile, table, detail dialog, filter), how the other copies are reached from it, what "Find duplicates" shows and which actions it offers, and whether a stored hash index is needed.
- **Image captions for LoRA training** (asked for on 2026-11-27). One stored caption per image file, as flowing prose (not a tag list), editable by hand and producible by the vision provider (single and as batch jobs), with manual and AI origin kept apart so a re-analysis never overwrites a hand-written text. Not part of the search index, no trigger word. Image to prompt already produces such a text but does not store it. An export of images with a same-named `.txt` belongs to it. Needs its own design round.

## Correctness and robustness

- Reads are not ordered against `close`.
- File names are truncated by code points, so long non-ASCII names can exceed a 255-byte limit (ext4, Samba).
- The same folder reached through a drive letter and a UNC path is reported as `workspace_duplicate`.
- `EPERM` from a locked file is reported as `storage_access_denied`.
- Migrations path for the packaged app.
- Hashing moves off the main event loop once jobs exist.
- A built-in template whose version row is missing is only repaired the next time the workspace is opened.
- Preview requests are not cancelled when a tile scrolls away; that needs a cancel signal from the renderer.
- The session failure memory of the preview service also remembers worker timeouts and crashes (the pool reports every failure as the same `none`/`null`); it now keeps at most `MAX_REMEMBERED_FAILURES` (10 000) keys per memory, the oldest forgotten first.
- The derived-data rebuild still runs on the main process while a workspace opens (about 1.7 s at 10 000 assets); it yields to the event loop between batches of 500, but each batch blocks it. The step also runs on every new workspace.
- `asset_search_map` rowids: once assets can be deleted, the FTS row and the map row must be deleted together; otherwise rowid reuse attaches a stale index row to a new asset.
- `files:assignMany` holds the exclusive workspace queue for the whole batch.
- Decoder byte limit of 256 MiB: an uncompressed 16-bit RGBA 8K TIFF (about 265 MB) gets neither dimensions nor a preview. Raising the limit is an owner decision.

## IPC and security

- Track dialog-granted paths: `files:import` and `workspace:open` currently accept any absolute path sent by the renderer.

## Renderer

- In-place list updates (`docs/superpowers/specs/2026-11-27-in-place-list-updates-design.md`), known limits: a patch replaces loaded rows and never adds or removes one, so with a status filter on the Jobs screen a job that left the filter keeps its row, a job that entered it does not appear, and pages loaded afterwards are shifted, until the filter is set again or a `jobs` change refreshes the list; the same holds for a file list with a filter the analysis moves a file into or out of (for example Proposals). The asset gallery, the projects list, the prompts list and the asset header (cover, tags) do not react to background jobs. More than 100 changed loaded records in one poll fall back to a refresh of the visible pages. An action on the Jobs screen reloads through its key and is followed by one redundant in-place refresh from the feed.
- In-place list updates, not checked in the running app: whether the virtualised grid keeps its visual position when a refresh changes the total above the visible area, and how a large analysis batch feels on the asset Files tab and the Jobs screen.
- The project member table still pages by 50 instead of scrolling endlessly like the other lists.
- No settings for the cache size and location; the preview worker timeout (30 s) is a constant.
- The failed-measurement memory of `measureVideo` is keyed by format and source path, so a video changed in place keeps its failed measurement for the session.
- `Cache-Control` max-age on previews assumes the content of a file ID never changes (true until working-file re-hashing in phase 6).
- Focus is lost when a focused placeholder becomes a Retry button.
- Multi-file Detach is a renderer loop over `files:unassign`.
- Retry on the storage banner during an import remounts the page and clears the busy block; navigation and "Import files" are free while the main process still imports, and the result strip is lost.
- The asset Files tab batch tag changes bypass the action guard (the tags dialog is modal; a guard would silently drop a typed tag).
- The Selection column is empty after a remount while the selected page is not loaded.
- Candidate, not verified: the tile menu in the last visible row and the "More" menu at the bottom of the file dialog panel may be clipped.
- Image viewer, left out on purpose: neighbouring files are not preloaded; 16-bit and wide-gamut TIFF are converted to 8-bit sRGB in the PNG rendition; the viewer cannot be opened from the asset gallery (only from file lists).
- Image viewer zoom: a fast Ctrl+wheel can lose zoom steps; a `reduced` rendition at 100 % is upscaled by a non-integer factor.
- Image viewer layout: Fit uses the whole-number `clientWidth`/`clientHeight` of the frame, so at a fractional `devicePixelRatio` the fitted box can be up to half a CSS pixel larger than the real stage and loses an edge pixel (measure with `getBoundingClientRect` and floor to the device grid); a rotated layer can sit half a device pixel off the box; the stage's own position on screen may be off the device grid; Ctrl+wheel over an on-stage arrow does not zoom; the tag input is named "Add image tag" for non-image files too; a horizontal film-strip scrollbar clips the tiles; the toolbar is cut off in very narrow windows. Untested: Fit ignoring a client area shrunk by scrollbars; no on-stage arrows for a list of one file.

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
- Scheduler: `scheduler.ts` is still over the file guide.
- `AssetScreen` is still 191 lines with nested async functions (`run`, `importFiles`); it needs the same treatment as `ProjectScreen`.
- `packages/core/src/site-crawl.ts` is over the file guide (about 330 code lines); `finalPageOf` and `kindOfUrl` could move into their own file.

## Tooling and tests

- Crash-recovery test on the real adapters (currently only on the fakes).
- Tests for the "ignore removal errors" branch of `importFile` (core). Storage: a real non-junction symlink (needs the symlink privilege on Windows; the dangling-link tests use junctions) and real case folding on a case-insensitive file system of another OS are not covered.
- Possibly flaky under full load, passing alone or on the rerun: the inbox jsdom test "filters and scroll offset survive navigation" (timing-sensitive; the assets and projects "list state round trip" tests, which failed the same way, were hardened in phase 4b by waiting until no `aria-busy` is left and for `aria-selected`, root cause unconfirmed); the list-state round trip in `assets.test.tsx`; `packages/media` `video-frames.test.ts > runs at most 1 processes at a time`; `packages/storage` "fails the stream past the total time".

## Phase 4a

Deferred by design:

- No attempt history: a job keeps only its attempt counter and the error of its latest run (ReadMe §10). Needed at the latest for paid jobs in phase 5.
- The file name on the Jobs screen is plain text, not a link to the file.
- Job rows are only removed by "Clear finished"; there is no age-based cleanup of finished jobs.

Found during the build:

- `pool.jpeg` is not abortable (up to 30 s), so a workspace close during an analysis can wait that long.
- Inbox and asset screen: the counts of a start replace an import failure list in the shared strip even when it was not read yet.

## Phase 4b

Deferred by design:

- The asset gallery has no multi-select; several assets are analysed through "Analyse all" over the gallery filter.
- Image2Prompt runs outside the scheduler, so it can overlap one running analysis on the same GPU (Ollama queues the requests).
- The pause of the analysis queue is not persisted; a restart starts unpaused.
- A file has one AI tag set, not one per model, and there is no proposal history.
- `providers:listModels` has no cancel channel (`provider-handlers.ts`); a slow server holds the request until its timeout.
- The Settings screen is reachable only inside an open workspace, although the settings are app-level.
- The "Proposals" toggle of the file lists is local to `FileBrowser` and does not survive navigation (the list state assumes string filter values, and "Analyse all" would have to leave the toggle out of its filter).
- The pause banner sits in the shell behind the backdrop of a modal dialog: behind a form-size dialog it stays faintly visible but cannot be used, and the file detail dialog covers it almost completely.
- With a selection, the asset Files tab shows two Analyse buttons (the asset's in the header and the selection's), told apart only by their tooltips.

Provider adapter (`packages/providers/src/ollama-vision.ts`):

- Models beyond the first 100 of `/api/tags` are dropped silently.

Provider settings (`apps/desktop/src/main/provider-store.ts`):

- A direct save that breaks the schema answers `invalid_operation` rather than `validation_failed`.

## File trash

Deferred by design:

- Nothing empties the trash automatically; there is no retention period (owner decision).
- Assets and projects cannot be deleted.
- The trash is in the app only, not the operating system's recycle bin.

Found during the build — core and persistence:

- Binaries left in `.assetforge/trash/` by a purge before migration `0009` have no tombstone and are never swept.

Found during the build — renderer:

- The nine-column trash table may be too wide; the Confirm/Cancel order differs between the confirm dialog and other dialogs.

Tests:

- Core and jobs: the open test cannot detect a swapped order of move recovery and sweep; the fake `onPurge` does not clear a chosen cover; the scheduler test does not pin the purge order (cancel, then row removal); the proposal-accept refusal for a trashed file is pinned only at core level.

## Editable prompts

Deferred by design:

- No prompt per asset type, project or workspace, no version history of a prompt, no import or export, no placeholders, and no tag vocabulary appended to a prompt.
- A file keeps one set of AI tags and one waiting proposal whatever prompt produced them; the prompt is not part of the fingerprint, so another prompt redoes a file only through "Analyse again".
- A file already queued with another prompt counts as `alreadyQueued` and keeps the prompt it was queued with.
- The Jobs screen shows neither model nor prompt.

Found during the build — renderer:

- Reset in the Prompts settings overwrites a saved text without confirmation, while Delete confirms (owner's call).

## Tag rename and merge

Deferred by design:

- No tags page listing all tags; a tag is renamed only from an editable tag chip.
- No rename from read-only chips (gallery tiles, tables, the trash) or from the tag filter.
- No undo of a rename or merge.
- An open proposal review dialog keeps the names it loaded: after a rename of one of them, Accept is refused and the dialog must be reopened.
- A merge target without any assignment (an unused tag row) is offered as a merge with zero counts.

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

## Asset sources

Deferred by design:

- No further fields on a source (title, author, licence, note, retrieval date).
- No sources on single files or on projects.
- No search or filter by source.
- No editing a source in place and no reordering (remove and add again).
- No adding several URLs at once.
- No fetching of any kind: no page title, favicon or reachability check.

Found in the final review and not fixed:

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

- A `.corrupt-*` copy beside `provider-settings.json` blocks the key-file sweep until someone removes the copy by hand; there is no cleanup of old copies and no hint in Settings that entries were left out.
- A settings file with a newer version number is set aside like an unreadable one; after a downgrade the entries are gone from the list (the keys stay).
- A key file in the old form is bound to the origin its entry has at the first start with the new code; an edit of the base URL by hand before that start is trusted once.
- The API key is decrypted on every `providers:list` (for `hasApiKey`), not only per request.

## Generation studio

- The Venice adapter was built from the vendor's documentation and tested only against the mock provider. The price shape in `pricing`, the `/image/edit` request (experimental at the vendor) and the answer types are assumptions until they are checked with the real service.
- The full-size rendition sent to the provider is capped at 8192 px per edge (`PREVIEW_EDGE.full`), so a larger image that is not sent as is arrives downscaled; the result is smaller than the source then.
- Upscale checks only the pixel bounds of the app and of the input; the provider's own upscale limits are not read.
- The guard that refuses deleting a provider entry with active jobs sees only the open workspace; jobs of that entry in another workspace fail later with `provider_not_configured`.
- Tag edits in a file dialog opened from a link (source or result) do not reach the host list until it reloads; the linked dialog shows the asset name as plain text.
- A JPEG or WebP answer of the image provider is not tested end to end; the mock only produces PNG (needs `docker/mock-provider`).
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
- The first open of a video runs ffmpeg twice (poster frame and measurement); the measurement could be derived from the frame extraction.
- The bundled ffmpeg is 6.1.1 (from `ffmpeg-static@5.3.0`, built in 2023) and should be replaced by a current build. Only `win32-x64` has a recorded checksum; on every other platform the tool stays disabled and videos have no picture.
- A frame that failed is remembered as failed for the app session (the same `failed` memory as image previews): a video whose frame could not be made shows the placeholder until the app is restarted, even when the cause is gone.

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

- `download_login_not_sent` also covers HTTP 407 and 451 from a host outside the site, because the downloader reports them as one refusal.
- A crawl and its kept answer live in memory only; nothing survives a restart, and one crawl runs at a time for the whole app.

Not covered by any automated check: the real windows. The hidden page window, the login window and the session glue are tested with fakes, the extraction script under jsdom (whose XPath errors differ from Chromium's). The owner checks by hand: a login that survives a restart, a real gallery with pagination and detail pages, a file behind the login, a file on another host, a `robots.txt` disallow, the window title staying `<profile name> – <host>`, a navigation to a private address being refused, `loadURL` rejecting with `ERR_ABORTED` when a navigation is replaced, `will-redirect` firing in a hidden window, and the partition being empty after a profile is deleted. For the browser check (spec "Browser check"; the session download, `sites:openCheck` and the requeue are tested only with fakes, and whether the session's request filter applies to `net.request` is not verified): a real site answering `cf-mitigated: challenge`, the lane pausing with `Open site`, passing the check in the login window, Resume repeating the refused downloads, and those downloads arriving through the session. The owner's check is pending.

## Found while clearing the backlog (2026-11-28)

- A ZIP entry whose declared size is wrong fails with the generic `Import failed`, not with the fixed `This archive could not be read to the end`; the size check fails while the entry is streamed, outside the mapping in `import-archive.ts`. `acceptance.test.ts` pins the current text.
- Image viewer: the device pixel ratio listener (`useDevicePixelRatio`) is tested only with a fake `matchMedia`; whether Electron fires the resolution query on a monitor move needs a manual check.
- Scheduler: a claimed row whose put-back failed is known as never launched only in memory. If the app ends before the next pass recovers it, the recovery at the next start ends an `onInterrupted: 'fail'` job as `provider_outcome_unknown`, although nothing was sent.
- Scheduler: the leftover recovery gives the attempt back (`release`); a requeue job whose `finish` keeps failing while `release` succeeds reruns without limit.
- File browser: Ctrl+A is ignored while a key change loads, and gives no feedback when the page that still fails is off-screen.
- URL import: a purge between the origin insert of a duplicate download and its `setOutcome` is still a window; the origin row is removed with the file and the job's result then names a file that no longer exists.
- `unboundOrigins` in `apps/desktop/src/main/provider-keys.ts` and the legacy marker comparison in `provider-settings-load.ts` still compare origins strictly; they do not use `isSameKeyOrigin`, so the trailing-dot equivalence does not reach them.
- A tag name that only a waiting proposal holds has no tag row any more, so `tags:rename` answers `not_found` for it; the proposal is rewritten only when its tag exists somewhere.
- Migrations that rebuild a table referenced by `ON DELETE CASCADE` must park and recreate the child tables (`PRAGMA foreign_keys=OFF` is a no-op inside the single migration transaction; see migration `0018`). This is not written down outside that migration.
- Tag cleaning removes every format character, also ZWJ and ZWNJ: emoji joined by ZWJ fall apart and two tags that differ only in such a character were merged by the derived-data step of version 3.
- Stop deadline: a requeued job abandoned at the deadline could run twice if the same workspace is reopened while the old handler still runs.
- Site partitions: Chromium keeps the partition directory after `clearStorageData`, so an ownerless partition is cleared again on every start; deleting the directory itself is open.
- Site partitions: the on-disk mapping `persist:site-<id>` to `Partitions/site-<id>` is assumed and not checked against a real Electron; needs a manual check.
- Structured output: nothing detects a server that refuses `response_format`; every tagging job on it fails as `provider_rejected` until the owner turns the option off.
- Provider settings: switching to another entry drops a pending key removal without asking.
- `StorageReturnContext` changes only on the storage banner's Retry, which already remounts the page; a storage that comes back without Retry leaves `CoverImage` on the format tile.
- An image that fails without a failing IPC call (a broken cached preview) raises no storage banner, so nothing signals its return.
- `ProjectFilter`: a filter naming a project deleted meanwhile shows an empty chip (`projects:get` fails and the error is not shown); the chip can still be removed.
- `SearchPicker` shows only the first 10 matches and has no hint that there are more.
- Other places that put listeners on a `<dialog>` element should be checked for events passed on from a nested dialog (`Dialog` now compares `event.target` with `event.currentTarget`).
- Generation studio: the per-source form draft is read only when the studio is mounted while the session still keeps the form; since a raise no longer remounts it is practically unused. Drop it or keep the form after a real close (needs a decision).
- Generation studio: scroll positions inside the studio and the look of the re-show on a raise (`close()` then `showModal()`) are tested only in jsdom; needs a manual check.
- `analysis:enqueue` without `force` still counts a file that is analysed and also queued as `alreadyAnalysed`, while the preview counts it as queued; making them agree needs `queued` on `AnalysisTargetEntry`.

## Found while building the data safety package (2026-11-28)

- Database backup: there is no free-space check before the backup; on a nearly full disk the open is refused cleanly, but nothing tells the owner how much space is needed.
- Database backup: a failed migration surfaces as `internal_error` with no hint that a backup exists; a restore path (UI or a documented manual step) does not exist.
- Database backup: a backup is reused when one with the same applied count exists; if an older app version wrote to the database between two failed opens, the reused backup is older than the data.
- The immediate resolve after a failed move commit retries once without a wait; an error that lasts a moment (`SQLITE_BUSY` beyond the busy timeout) still leaves the row for the next open.
- `relocateFile` does not resolve an open move row of the file before it begins a new one, unlike restore and purge; a row left by a commit and a resolve that both failed makes the next relocate fail with "already being moved" until the workspace is opened again.

## Not covered by any automated check

The native confirmation for removing a workflow, native file and directory dialogs (and therefore the "Choose location", "Open existing folder" and "Import files" buttons end to end), window appearance, focusing the existing window on a second launch, the wiring of the `shutting_down` refusal in `handleIpc` (the answer itself is tested through `ipcRefusal`), the rejected-invoke path to `ApiError`, `formatDateTime`, the rendered messages for `unsupported_format_version` and `workspace_mismatch`, and keyboard-only operation beyond the tag rows, the file selection, menus, tabs and the dialog focus return. Phase 4b: the production `SecretCodec` over Electron `safeStorage` (`apps/desktop/src/main/secret-codec.ts`); the tests use a fake codec.
