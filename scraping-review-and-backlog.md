# Scraping review and deferred improvements

- Date: 2026-11-28.
- Reference code state: `main`, commit `7940ddf`.
- Additional performance/settings review: `main`, commit `057fe03`.
- Status: discussion notes and backlog; the proposals below are not implemented by this document.
- Priority: perform the planned code cleanup first, then prioritize non-blocking, parallel URL discovery. Download tuning remains secondary.

Agreed follow-ups cover the optional filename prefilter, queued background parsing with saved results, accessible profile deletion, and a clearer site-import dialog. The architecture recommendations remain proposals to evaluate during that work.

## Agreed improvement: optional filename prefilter

When importing from a site into an existing asset, optionally exclude candidates whose obvious filename already exists in that asset. The purpose is to avoid unnecessary downloads, particularly for manually imported files or URLs that change while the filename stays the same.

The owner does not intend to rename source filenames: organization should happen through metadata. Filename matching is therefore useful as an explicit convenience rule, while the existing content-based duplicate check remains in place.

Suggested option label: **Skip filenames already in this asset**.

### Intended behavior

1. Collect `originalName` values for all complete, non-trashed files belonging to the target asset. Do this in the backend, independently of UI pagination, search, tag filters or the currently visible files.
2. Compare candidates with an obvious filename against that set. Use the full filename, including its extension, rather than an internal storage path or a UUID-prefixed storage filename.
3. Exclude matching candidates from the download selection before enqueueing them. Mark the reason as **Already present - filename** and allow the owner to include a candidate anyway.
4. Leave candidates with an unknown filename unchanged. Download them normally and let the existing SHA-256 check handle duplicates afterwards.
5. Recheck the relevant asset state before enqueueing. If the same rule is also checked when a queued download starts, use the current asset state rather than relying only on the earlier preview.

| Candidate | Existing file in the target asset | Expected behavior |
| --- | --- | --- |
| `/images/photo_53.jpg` | `photo_53.jpg` | Skip when the option is enabled. |
| `/images/photo_54.jpg` | No matching name | Download normally. |
| `/download?id=53` | Filename cannot be determined from the candidate | Download normally; deduplicate by content afterwards. |
| `/images/photo_53.jpg?token=...` | `photo_53.jpg` | An obvious path filename can still be compared; the presence of a query string alone does not make it unknown. |

**Important clarification:** this is a best-effort early filter. Do not add HEAD requests, preliminary downloads or extra page visits merely to discover a filename. Unknown cases should pass through. Generic endpoint names such as `download` must not be treated as a reliable identity for the requested file.

Example preview: **120 found - 85 already present - 35 new**. Keep filename-based matches distinguishable from known-URL matches and verified content duplicates; avoid double-counting overlapping reasons.

Equal filenames are a deliberate heuristic, not proof of equal bytes. Restrict this option to the target asset. Do not overwrite files, merge metadata or record a new URL as a verified origin solely because a filename matches. No filename changes are required for this feature.

The exact normalization rule and where the option is remembered remain implementation decisions. Apply the same comparison rule to both sides without renaming files.

## Existing duplicate handling

The filename prefilter would supplement these existing mechanisms:

- Known source URLs are excluded before jobs are queued in [`enqueueUrlImport`](packages/core/src/url-import.ts).
- The download handler checks known source URLs again before opening a download in [`download-handler.ts`](packages/core/src/download-handler.ts).
- SHA-256 duplicate detection runs after the content has been transferred and staged in [`import-file.ts`](packages/core/src/import-file.ts). It can prevent duplicate storage, but not the preceding network transfer.
- `originalName` is part of the file record in [`files.ts`](packages/contracts/src/files.ts).
- The actual download filename can come from `Content-Disposition`, the final URL or a fallback in [`download-name.ts`](packages/core/src/download-name.ts). This is why not every candidate has a trustworthy filename before a request.

At the reference code state, `sites:crawl` receives a profile and URL; the target asset is supplied later to `sites:import`. Showing asset-specific exclusions in the test preview will therefore need explicit asset context or a separate preview-filter step. Keep raw discovery results available so toggling the option does not require another crawl.

## Agreed improvement: background parsing queue and saved results

The owner wants to submit several large galleries, for example five, and let them be parsed one after another while using other parts of the application. They should be able to inspect each result later and explicitly start its import.

```text
Queue parsing requests -> parse sequentially -> save each result -> owner reviews -> existing download queue
```

### Requirements

- Reuse and extend the existing job infrastructure rather than introduce a separate queue service. A job type such as `site.crawl` is a possible implementation; its final contract is not decided here.
- Initially process one parsing request at a time. Submitting five requests means five queued tasks, not five simultaneous browser windows.
- Parsing belongs to the background job, not the lifetime of the dialog. Closing the dialog or changing the current UI view must not cancel an explicitly queued task. Cancellation is a separate action.
- Give every task its own identity, progress, outcome and persistent result. Starting another task must not overwrite an earlier result.
- Retain the gallery URL, site-profile identity, settings used, and the intended workspace/asset context. Navigating to another asset must not retarget a previously queued import request.
- Persist discovered candidates with their provenance, problems and counts. Preserve checkpoints and partial results where needed to continue interrupted work without unnecessarily repeating all discovery.
- A completed parse becomes **Ready for review**. The owner can reopen it, review and select candidates, apply the optional existing-filename filter, then choose **Import**. Parsing itself must not automatically enqueue downloads.
- Keep the technical job outcome separate from review state: a successfully stored parsing result is a finished parsing job, even if the owner reviews it hours later.
- Once Import is chosen, use the existing download queue and import path. Show that downloads were queued and prevent accidental duplicate submission through the existing deduplication rules.
- Recheck known URLs and the target asset's current filenames when preparing the import; files may have arrived since parsing began.
- Queue state and saved results should survive an application restart. Background execution here means while the application process is running; this does not introduce an external worker service. Define behavior on workspace close/switch consistently with the existing scheduler lifecycle.

Illustrative review states are **Queued**, **Parsing**, **Ready for review**, **Needs attention**, **Failed**, **Cancelled**, and **Downloads queued**. These are UI/domain concepts, not a decision to put every state into the existing technical job-status enum.

### Reuse the existing login and browser-check flow

The application already has a window/flow for login and browser checks, including challenges encountered by download jobs. Reuse that mechanism for parsing jobs; do not design a second captcha/login subsystem or duplicate its windows.

When a queued parse requires renewed authentication or a browser confirmation, retain its progress, expose the existing action for the correct site profile, and allow it to continue after the owner completes that action. Other runnable profiles should not be held behind one profile waiting for user input. Use the current session at execution time rather than copying cookies into queued payloads.

The owner is already aware that time-limited download URLs can expire. Preserve provenance so affected links can be refreshed when necessary, but keep this known limitation out of the main queue-design discussion.

### Current coupling to replace

At the reference code state:

- [`SiteImportDialog.tsx`](apps/desktop/src/renderer/src/components/SiteImportDialog.tsx) cancels a running crawl when the dialog unmounts.
- [`site-handlers.ts`](apps/desktop/src/main/site-handlers.ts) has one in-memory `running` crawl and one `kept` answer. Starting another crawl replaces that answer; it is not a multi-result store.
- [`scheduler.ts`](packages/jobs/src/scheduler.ts) and [`job-host.ts`](apps/desktop/src/main/job-host.ts) provide existing scheduling, cancellation and workspace lifecycle seams to build on.

The main change is therefore persistent task/result ownership outside the dialog, not merely allowing the current modal to close.

## Agreed improvement: profile deletion and management

Site profiles must be easy to find, edit and delete again. Deletion should be a visible, understandable part of profile management rather than an action whose availability is unclear.

Deletion already exists through `sites:delete` in [`site-handlers.ts`](apps/desktop/src/main/site-handlers.ts), with a confirmation action in [`SiteImportDialog.tsx`](apps/desktop/src/renderer/src/components/SiteImportDialog.tsx). Treat this as an existing feature to verify and improve, not a missing backend to rebuild from scratch.

For the queued design, account for references from queued/running parses, saved results and active downloads. If deletion is blocked, display a specific reason. Decide explicitly whether dependent pending work must be cancelled first or whether a confirmed cancel-and-delete action is offered. Do not silently discard tasks or switch them to another profile.

Deleting a site profile must not delete imported asset files. Handle its saved browser session through the existing cleanup behavior. Decide how completed result/history records retain useful context when their profile is removed. Profiles are application-level, so consider references from other workspaces when defining deletion rules.

## Agreed improvement: clearer site-import dialog

Redesign the dialog as part of the same visual system as the existing AssetForge screens: consistent controls, spacing, typography and action placement. The goal is a clearer workflow as well as a more polished appearance.

The UI should make these responsibilities easy to distinguish:

- **Profiles:** select, create, edit and delete a profile, with its configuration clearly grouped and any blocked action explained.
- **Queue parsing:** enter one or more gallery URLs, make the target context visible, choose the relevant options and submit tasks. The owner can then close the dialog.
- **Tasks and results:** show progress and queued requests, reopen saved results, inspect errors or exclusions, and invoke existing login/browser-check actions when needed.
- **Review and import:** select candidates, see found/already-present/new counts, then enqueue the actual downloads explicitly.

A grouped layout or tabs for profile configuration, parsing tasks and result review are possible design directions; the exact layout is not selected yet. Reuse the established list/editor and action-menu patterns where helpful. Avoid making the owner stay in one long, locked form during discovery.

No new visual mockup or application UI implementation is part of this documentation update.

## Architecture review: proposals to revisit

The current implementation provides a useful foundation for conventional galleries. The main limitations are fixed workflow assumptions and lost context, rather than hard-coded website names. These are review recommendations, not an agreed rewrite plan.

### Preserve the context of a discovered file

The crawl currently returns `files: string[]`, and [`site-handlers.ts`](apps/desktop/src/main/site-handlers.ts) passes those URLs to the import queue. The individual page on which a file was found is lost.

A future import candidate could retain:

```ts
interface ImportCandidate {
  fileUrl: string;
  sourcePageUrl: string;
  siteProfileId: string;
  expectedName?: string; // Only when known; unknown names are allowed.
}
```

This is an illustrative shape, not a finalized contract. Keep cookies and other credentials out of candidates and job payloads. Preserved context could support diagnostics, source attribution and any deliberately supported referrer behavior.

Relevant files: [`site-import.ts`](packages/contracts/src/site-import.ts), [`site-crawl.ts`](packages/core/src/site-crawl.ts), [`site-handlers.ts`](apps/desktop/src/main/site-handlers.ts).

### Wait for usable URLs, not just matching DOM nodes

In [`site-sessions.ts`](apps/desktop/src/main/site-sessions.ts), readiness is based on matching node counts. Two polls with the same count do not prove that URL attributes have been populated or that a dynamic list is complete. Once navigation finishes, the first matching node count can end the wait immediately.

Review readiness using usable URL results and an explicit stability or completion condition. Keep sensible default timing values; allow source-specific waiting behavior where necessary.

The extractor reads `href`, otherwise `src`, directly from each selected element. It does not automatically search descendants. Explicit attribute XPath expressions, such as `//a/@href` or `//img/@data-src`, already provide clearer selection without guessing which URL to use.

### Separate source-specific behavior from the common crawl

The three fields `thumbnails`, `pagination` and `file` encode a fixed gallery-to-optional-detail-to-file workflow. Empty strings also select behavior. This is adequate for simple galleries, but additional detail levels, interactive pagination or lazy loading do not fit naturally.

Consider a small source-adapter boundary for discovery while retaining a configurable gallery adapter for the common case. The intended flow is:

```text
Source profile -> discovery -> candidates with provenance -> existing queue -> existing file import
```

Keep straightforward cases straightforward. Do not introduce a general workflow engine or new queue infrastructure just for the filename prefilter.

### Keep the download/session boundary explicit

The browser-session download path now exists in [`site-download.ts`](apps/desktop/src/main/site-download.ts), is exposed through [`site-sessions.ts`](apps/desktop/src/main/site-sessions.ts), and is wired in [`composition.ts`](apps/desktop/src/main/composition.ts). Do not revisit this topic assuming all site downloads still use only Node HTTP.

There is still room to clarify the transport contract: the session path calls `headersFor` but discards its returned headers, using the callback to observe the hop while the session supplies cookies and user agent. Separate header provision from hop reporting if this is refactored.

The observed `Just a moment...` response was a Cloudflare challenge. Its distinct browser-check error and the application's existing login/check-window flow are the integration points for queued parsing as well as downloads. Preserve that distinction rather than reporting every refusal as a missing login or an empty gallery.

### Bound total crawl work

In [`site-crawl.ts`](packages/core/src/site-crawl.ts), `maxPages` bounds gallery pages, while detail-page visits have no equivalent total budget. `maxFiles` bounds accepted candidates, so many rejected or unsuccessful detail pages can still cause substantial work.

Consider an overall request, detail-page or runtime budget, independently of the maximum number of accepted files.

## Additional proposals: performance and configurable limits

Validated by reading the implementation at `057fe03`. No benchmark was run; the observations below identify definite scheduling behavior and possible optimization points, not measured speedups. Recheck them after the ongoing cleanup.

### Owner-reported timing and priority

The owner reports approximately **two minutes to extract 70 image URLs**, followed by approximately **15 seconds to download the files**. Downloads already run in the background and are not the immediate problem. Treat this as a reported end-to-end observation, not an instrumented breakdown of individual page loads.

The immediate requirements are therefore both:

1. **Let the owner continue working while extraction runs.** Enqueue the crawl, allow the dialog to close without cancellation, and retain its progress and results for later review and explicit import.
2. **Accelerate extraction with bounded parallel detail-page loads.** Background execution alone removes the forced wait in the dialog but does not shorten extraction. Parallel workers alone would leave the owner trapped in a faster dialog. Both changes are needed.

The UI coupling is confirmed in [`SiteImportDialog.tsx`](apps/desktop/src/renderer/src/components/SiteImportDialog.tsx): crawling locks its controls, its result is component state, and unmounting explicitly sends `sites:cancelCrawl`. [`site-handlers.ts`](apps/desktop/src/main/site-handlers.ts) also permits only one in-memory crawl and keeps only the latest answer. This is workflow blocking; these observations do not establish a synchronous renderer/event-loop freeze.

Keep download concurrency settings in the backlog, but do not make download, hashing or image-processing optimization a prerequisite for fixing discovery. The reported total does not establish how much time is spent navigating, waiting or extracting. If one detail page is visited per image, the current 500 ms gaps alone account for roughly 35 seconds for 70 images; verify the actual page count rather than assuming it.

### Keep discovery, downloads and file processing separate

- **URL discovery:** [`site-crawl.ts`](packages/core/src/site-crawl.ts) visits detail pages sequentially. Every page load after the first adds a fixed `PAGE_GAP_MS = 500` wait after the preceding load. Visiting 500 detail pages after an initial gallery therefore adds 250 seconds of deliberate waits, besides navigation and extraction time.
- **Page readiness:** [`site-page-loader.ts`](apps/desktop/src/main/site-page-loader.ts) polls every 250 ms, allows up to 10 seconds of settling after navigation, and caps a load at 30 seconds overall. Successful matches can return earlier; the 10-second value is not a mandatory delay on every page. Readiness currently uses matching node counts rather than usable URL values, as discussed above.
- **Downloads:** [`scheduler.ts`](packages/jobs/src/scheduler.ts) defaults to four running I/O jobs across lanes and two per ordinary I/O lane. [`lane-limits.ts`](apps/desktop/src/main/lane-limits.ts) overrides lanes matching a configured site's name to one running I/O job. Raising only the global limit will not increase downloads from that site. The global value is an I/O-job limit, not a dedicated network-transfer counter.
- **Post-transfer work:** [`download-handler.ts`](packages/core/src/download-handler.ts) holds its job slot through the import. [`stream-write.ts`](packages/storage/src/stream-write.ts) hashes bytes while writing; [`import-file.ts`](packages/core/src/import-file.ts) then rereads staging to verify its checksum, checks duplicates, moves the file and awaits image-dimension measurement before marking it complete. The second read is an explicit integrity check in the current import contract. Measure its cost, especially on NAS storage, before considering changes to that contract.
- **Image processing:** the app starts a bounded media worker pool with `POOL_SIZE = 2` from [`worker-pool.ts`](packages/media/src/worker-pool.ts). Network concurrency and media-worker count should remain independent.
- **AI analysis:** provider-specific `parallelRequests` already exists in the settings UI and feeds the analysis lane limit. Reuse that setting rather than creating a second control with the same purpose.

### Candidate improvements, in order

1. Move crawl ownership and saved results out of the dialog into the existing job infrastructure. Closing or navigating away must not cancel or retarget the crawl. Report progress and allow explicit cancellation from the task list.
2. Add a small configurable, bounded pool for independent detail pages. Each worker needs its own page view/loader; concurrent navigation through the current single view would interfere. Share the intended profile session and coordinate request spacing across all workers and queued crawls for that site. Preserve partial progress and reuse the existing login/browser-check flow.
3. Make page readiness depend on usable results and appropriate stability. Tune the page gap and timeouts per source instead of globally shortening every wait. Record page navigation/readiness and extraction durations, then compare sequential and parallel runs of the same gallery. Keep progress and diagnostics free of sensitive URLs or credentials.
4. Avoid known unnecessary work with the existing URL checks and the proposed optional filename prefilter. Do not add one request per candidate just to discover its name. A filter based on final filenames cannot remove a detail-page visit when that name is not known yet.
5. Revisit download and post-transfer processing only if later measurements identify a separate problem there. Any split into processing stages must preserve pending-file recovery, integrity checks, duplicate handling, final-state semantics and bounded staging/backpressure.

Background parsing and parsing parallelism are separate improvements: queued tasks should first become independent of the dialog, even with one active crawl. A later worker pool can accelerate discovery inside a crawl without requiring several full crawls to run simultaneously.

### Proposed user-facing settings

The values below describe the current baseline where one exists, not benchmark-derived optimal values. Select the new parser-worker default by comparing the same gallery at bounded concurrency levels; preserving serial extraction is not the performance goal.

| Setting | Initial value | Scope / purpose |
| --- | --- | --- |
| Simultaneous downloads | 4 | App-wide ceiling; decide whether to retain the shared I/O budget or expose a dedicated download budget. |
| Simultaneous downloads per site | 1 | Site override beneath the global ceiling; also define the fallback for URLs without a site profile, currently two per lane. |
| Parallel detail-page loads | Configurable; default to validate | Currently serial. Add independent page workers and compare small pool sizes on the same gallery. |
| Minimum interval between page requests | 500 ms | Site-level request pacing shared across workers, rather than an independent pause in every worker. |
| Page-load timeout | 30 seconds | Advanced site-level setting; keep settling behavior separate and use sensible defaults. |
| Crawl budget | Existing `maxPages` / `maxFiles`, plus a proposed total-work budget | Bound detail visits or elapsed crawl time as well as accepted results. |
| Image-processing workers | 2 | Optional advanced setting if measurements justify exposing it; independent of downloads and AI-provider concurrency. |

Download idle/total timeouts and a maximum file size may also be useful advanced controls. Keep their definitions centralized; do not expose every internal constant as a UI field. The existing values live in [`download-limits.ts`](packages/core/src/download-limits.ts).

The scheduler already accepts limits and a per-lane resolver, and the media pool already accepts its size. The missing piece is a persisted, validated settings model connected to those boundaries. Use app defaults plus explicit site overrides, with one place calculating the effective values. Show when a site limit is the reason only one download runs despite a higher global value.

Apply changed queue limits to new job starts. Lowering a limit should let running jobs finish and defer further starts; it should not abort transfers. Define worker-pool resizing separately. Preserve server throttling, browser-check/login pauses and central URL/session checks independently of the selected concurrency.

## Parts to preserve during cleanup

- The existing persistent job queue, duplicate handling and streaming import.
- Cancellation, progress reporting and typed failures.
- Central URL, redirect, public-address and size checks.
- Session isolation and keeping credentials out of IPC, logs and job payloads.
- Shared limits and stream handling across download transports instead of separate copies of the same import logic.

Code cleanup should not silently change these behaviors or implement the deferred features as a side effect.

## Resume checklist

- [ ] Re-read the current implementation after code cleanup; this document records the discussion at the reference commit.
- [ ] Decide the minimal discovery/transport contracts and which review proposals are still relevant.
- [ ] Define the optional asset-scoped filename prefilter and its comparison normalization.
- [ ] Keep unknown filenames on the normal download and hash-deduplication path, without extra discovery requests.
- [ ] Show skipped candidates and reasons in the preview; revalidate against current asset state before queueing.
- [ ] Cover existing-name matches, another asset with the same name, unknown filenames, query-bearing file URLs, incomplete/trashed files, option disabled and the existing SHA-256 fallback.
- [ ] Add queued parsing through the existing job infrastructure, initially with one active parse at a time.
- [ ] Treat active-crawl count separately from detail-worker count: one active crawl can still resolve its independent detail pages in parallel.
- [ ] Recheck the owner's baseline (about 120 seconds for 70 URLs, about 15 seconds for downloads); verify that extraction continues after closing the dialog and compare bounded parser concurrency on the same gallery.
- [ ] Persist separate task progress, target context, partial results and completed review results instead of keeping only the latest answer.
- [ ] Decouple queued work from dialog unmounting and verify that navigation does not cancel or retarget it.
- [ ] Reuse the existing login/browser-check flow and preserve progress while a profile waits for user action.
- [ ] Define restart and workspace-close behavior, and verify that five queued galleries remain separately reviewable.
- [ ] Make profile deletion clear and usable; define its behavior with queued work, saved results and references from other workspaces.
- [ ] Produce a site-import dialog design covering profiles, queued parsing, result review and explicit import.
- [ ] Measure discovery, transfer, verification and metadata phases before choosing performance changes.
- [ ] Define persisted global limits and site overrides; make effective concurrency visible and apply changes without aborting running jobs.
- [ ] Evaluate bounded detail-page workers with independent page views and shared site pacing; retain separate network, media and AI controls.
- [ ] Add a controlled native Electron integration check for delayed URL attributes and browser-session downloads. Existing jsdom/mock tests do not exercise the complete native browser environment.

## Related notes

- [`gallery-import-konzept.md`](gallery-import-konzept.md): earlier, broader gallery-import concept; not replaced by this note.
- [Site-import design](docs/superpowers/specs/2026-11-27-site-import-design.md): original scope and deliberate limitations; compare with the current code before relying on older transport assumptions.
- [Cloudflare challenge-response detection](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/): `cf-mitigated: challenge` identifies a challenge response.

No scraper behavior, runtime settings or source files were changed while recording this note.
