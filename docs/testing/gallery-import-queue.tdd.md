# Gallery discovery queue implementation

Branch: `feat/gallery-import-queue`. Initially delivered unmerged; the owner subsequently authorized integration into `main`, commit and push on 2026-11-28.

Starting base: `8ed6bc7`. During implementation `main` advanced independently to `354d127`. The initial feature validation below predates integration; the final section records validation of the combined feature and safety changes.

## Scope and acceptance

Use the existing implementation and the decisions in `scraping-review-and-backlog.md`. The original `gallery-import-konzept.md` is not the implementation specification. Reuse SQLite, the persistent job scheduler, browser profile sessions and the existing download/import pipeline.

- Queue several galleries, close the dialog and continue working without cancelling discovery.
- Keep each crawl's captured asset/workspace/profile context, progress and review results separately across navigation and restart.
- Resolve independent detail pages with bounded parallel browser views and shared request pacing.
- Wait for usable URLs and stable results rather than merely matching DOM nodes.
- Review and select candidates before explicitly enqueueing downloads.
- Optionally exclude obvious existing filenames within the captured asset, rechecking live state before import; unknown names retain the normal download/hash path.
- Reuse login/browser checks and make cancellation and profile deletion explicit.
- Preserve streaming import, integrity, URL/session validation and existing application behavior.

## Agent ownership

| Work item | Owner | State | Validation gate |
| --- | --- | --- | --- |
| Contracts and background discovery orchestration | discovery_backend | Review | Contract and service tests, lifecycle checks passed |
| Durable crawl repository and migration | discovery_persistence | Review | SQLite repository, atomicity and migration tests passed |
| Parallel crawl and native page readiness/pool | crawl_parallel | Review | Core concurrency, cancellation and native page checks passed |
| Queue, review and profile UI | discovery_ui | Review | Renderer interaction tests and native rendered smoke passed |
| Integration, review and branch handoff | root | Review | Typecheck, lint, full tests, isolated build and diff review passed |

All agents shared the feature branch with explicit file ownership. Local commits were coordinated by root. The original implementation scope stopped before merge/push; the owner's subsequent explicit instruction authorized those steps.

## TDD evidence

The following tests were added and executed before production edits. Each failed for the missing behavior rather than test setup:

| Journey | RED command | Observed failure |
| --- | --- | --- |
| Parallel detail extraction | `pnpm --filter @assetforge/core test test/site-crawl-concurrency.test.ts` | Expected three detail loads to start; only one started. |
| Usable, stable extracted URLs | `pnpm --filter @assetforge/desktop test test/site-page-readiness.test.ts` | Empty URL results accepted; changing URL values considered stable based only on node count. |
| Close dialog without cancelling | `pnpm --filter @assetforge/desktop test test/renderer/site-import-queue.test.tsx` | Unmount sent `sites:cancelCrawl`. |
| Queue/review IPC and parser settings | `pnpm --filter @assetforge/contracts test site-discovery.test.ts` | Queue/review channels absent and parser settings stripped. |

## GREEN and integration evidence

The agents implemented their owned sections after the RED checkpoints. An independent read-only reviewer identified additional regressions; root integrated and verified their fixes. Later agent turns hit an account usage limit, so root completed the remaining integration and validation after the owner resumed the task.

| Guarantee | Evidence | Result |
| --- | --- | --- |
| Five queued galleries retain separate review results and do not download automatically | `apps/desktop/test/site-discovery.test.ts` | PASS |
| Workspace close/reopen preserves captured context and saved results | Discovery integration tests and SQLite repository reopen/upgrade tests | PASS |
| Crawl and technical job are created atomically | `packages/persistence/test/site-crawl-repository.test.ts` | PASS |
| Clearing job history neither promotes partial results to ready nor prevents retry | Discovery completion-marker and missing-job retry regressions | PASS |
| Site refusal pauses the affected source; HTTP 429 holds its queue with the shared delay | Discovery integration and pause-gate tests | PASS |
| Detail workers overlap without sharing a navigated browser view, retain pacing and respect cancellation | `packages/core/test/site-crawl-concurrency.test.ts`, desktop page-pool tests | PASS |
| Empty hrefs and changing post-load URL batches do not count as ready | `apps/desktop/test/site-page-readiness.test.ts` | PASS |
| Filename filtering reads all current asset files and preserves unknown names, explicit overrides and raw results | `packages/core/test/site-candidate-filter.test.ts` and live-state discovery integration | PASS |
| Closing/reopening the dialog does not cancel extraction; imported subsets remain reviewable | Renderer queue tests and native rendered smoke | PASS |
| Job completion refreshes the selected result even when its persisted timestamp is unchanged | Renderer running-to-ready revision regression | PASS |
| Asset/inbox entry points enqueue the intended destination; selected-result imports use the captured target | Renderer asset/inbox integration and malicious-target backend regression | PASS |

Final full suite: **4,515 tests passed**, with one pre-existing conditional seed test skipped (`apps/desktop/test/seed-e2e.test.ts`, requires an E2E user-data path). Per package: contracts 310, media 149, core 911, jobs 126, providers 252, storage 220, persistence 431 and desktop 2,116.

- `pnpm typecheck`: passed across all workspace packages.
- `pnpm lint`: zero errors; repository rule warnings remain, including component/function length and label documentation. The polling teardown warning was removed without changing its generation guard; its renderer tests passed again.
- `pnpm audit --prod --json`: zero known vulnerabilities reported.
- `git diff --check`: passed.
- `electron-vite build --outDir <owned temporary directory>`: main, media worker, preload and renderer built successfully, including copied migrations. Existing `apps/desktop/out` was not rebuilt.
- Formatting checked with the repository's Prettier version.
- `pnpm --filter @assetforge/persistence db:generate`: no schema changes; migration 0019 and its snapshot match the final schema.

## Native and rendered validation

Run the committed native test from the desktop package:

```powershell
node test/native/run-site-discovery-smoke.mjs
```

It bundles only its test entry into a fresh temporary directory and uses temporary user data. Synthetic HTTPS responses test three real, independent Electron browser pages and delayed href assignment, without requesting a website or touching existing login/asset data. The test passed with the renderer sandbox enabled.

On this managed Windows host the execution sandbox's runtime ACL prevents Chromium child-process access. The check passed from the normal execution context with `--copy-runtime`, which copies Electron and grants Chromium read access only to that owned temporary copy. Installed runtime permissions and production sandbox settings remain unchanged. Cleanup verifies the temporary path before recursive removal.

Rendered flow checked: open saved extraction -> review 70 candidates and captured destination -> select an existing-name override -> import selection -> close/reopen without cancellation. The isolated fixture used the actual renderer components and theme, with a fake IPC bridge. A screenshot was inspected outside the repository. There were no application console errors; the development fixture emitted Electron's expected development CSP warning.

Browser plugin was unavailable. The Playwright connector also failed because its Chrome extension was not installed. Native Electron provided the rendered fallback; no browser extension was installed or existing browser profile modified.

## Operational scope and limits

- One discovery job runs at a time in the existing scheduler; independent detail pages within it default to three workers (configurable 1–6). Request starts share a default 500 ms gap, and page timeout defaults to 30 seconds. Downloads keep the existing independent queue.
- Work continues while the dialog is closed, provided the application and workspace remain open. Workspace close stops and checkpoints the scheduler; reopening resumes it. There is no separate worker after application exit.
- Profiles are app-level; deletion refuses active discovery/download references in the open workspace. Saved results retain their profile snapshot. Removing a profile can leave tasks in another, closed workspace without a usable login profile; those tasks report the existing missing-profile error rather than silently substituting another profile.
- The user's actual 70-image gallery has not been timed after this change. Native tests prove independent concurrent navigation, not a specific speedup on that website.
- Coverage percentages were not instrumented: no coverage provider is configured or installed. No 80% coverage claim is made. The guarantees above are backed by executed behavioral and integration tests.
- Review-stage requests, results and checkpoints contain URL metadata; they do not contain copied session cookies or API credentials. The existing streaming, integrity and public-address checks remain active.
- The original untracked `gallery-import-konzept.md` was preserved. The implementation follows the current code and the later agreed scope, rather than adding its proposed external queue/database stack.

## Authorized main integration

The owner explicitly authorized merge, commit and push after reviewing the initial feature handoff. Integration incorporates `main` at `354d127` and preserves its data-safety work.

- Resolved the `job-host.ts` conflict by registering discovery through the new `workspaceHandlers` helper while retaining safe scheduler logging and recovery reports. Discovery keeps its existing concurrency/pause configuration.
- Verified the automatic merge of pre-migration backups, atomic asset/workflow changes, safe diagnostics, recovery handling and the new crawl repository wiring.
- Extended migration 0019's upgrade test to open the backup read-only, verify its integrity, confirm it precedes the crawl table, and check the original queued download job survives in both backup and upgraded database.
- Updated the existing backup test to compare the migrated database against the shipped journal rather than a fixed count of 19 migrations.
- Combined full suite: **4,594 tests passed**, one pre-existing conditional E2E seed test skipped. Counts: contracts 310, media 149, core 965, jobs 129, providers 252, storage 220, persistence 443, desktop 2,126.
- Combined typecheck and lint passed (zero lint errors; rule warnings remain), production dependency audit reported zero known vulnerabilities, and main/preload/renderer/media-worker production bundles built in a temporary directory.
- Repeated the native Electron smoke with three independent pages and delayed URL attributes: passed.

The merge history and remote `main` identify the final integration commits; no force push or history rewrite is part of this integration.

## Dialog overflow regression

The owner reported that eligible-file results expand the dialog indefinitely. A native layout check reproduced this at a 1280 × 800 content viewport with 70 candidates: the file-list wrapper measured 2671 px high, dialog scroll content reached 3857 px, and the Close button began at y=3820, outside the viewport. The check failed the requirement that the file list leave room for controls and scroll internally.

This visual regression is verified with real browser geometry, not jsdom class-name assertions. The isolated fixture and screenshots stay outside the repository and reuse the committed native smoke runner.

The fix uses a viewport-height workspace dialog with independently scrolling profile/content columns and a non-shrinking Close footer. The candidate table has its own keyboard-focusable scroll region, capped at the smaller of 40 dvh and 20 rem, with a sticky header. Existing form/wide dialog sizing is unchanged.

Native GREEN measurements: at 1280 × 800, both 70 and 5,000 candidates keep the dialog at 752 px and the file viewport at 320 px. At 1024 × 640, they measure 592 px and 256 px. The dialog has no outer overflow, Close stays inside the viewport, and Import selected remains reachable after scrolling the content pane. All 1,059 renderer tests across 55 files passed, as did workspace typechecking and lint (zero errors).

## Cancelled partial imports, history cleanup and profile editing

The owner clarified that downloads run normally: after cancelling discovery and explicitly importing its partial result, the saved extraction stays at `Import queued`. The remaining issue was managing that saved result and editing its source profile.

- Added `Remove extraction` with confirmation that only the saved review/checkpoint is removed. The repository checks active discovery jobs and removes metadata in one transaction; download jobs, files, profiles and sessions are untouched. Active extractions must be cancelled first.
- Added `Edit profile`, which reloads and selects the task's current live profile, focuses the form and preserves existing unsaved edits. Profile selection and Save/Delete/Login stay at the top of the profile pane.
- Removed the unnecessary profile-save lock while its login window or a legacy crawl is open. Site identity stays immutable, deletion guards remain, and existing crawls/downloads keep captured settings.
- Added `Extract again` to create a new task using the saved profile, original gallery URL and captured target. Unsaved profile edits must first be saved. Old partial results are retained until explicitly removed, with no automatic retry or requeue.
- The exact backend sequence cancellation -> partial import -> profile edit -> removal is covered, including preservation of queued downloads and their original filter payloads.
- Runtime RED checkpoints: `eb73b73` (missing UI actions), `3ed9cf3` (missing removal and profile-save lock), `80eb521` (cancelled-partial sequence). Backend GREEN checkpoint: `8b86f1d`.
- Final combined suite: **4,606 tests passed**, one pre-existing conditional E2E seed skipped. Typecheck, formatting, lint (zero errors), production dependency audit and isolated Electron build passed.
- Native rendered validation with fake IPC passed cancelled partial import -> edit/save live profile -> new extraction with the captured target -> remove original review, with no cancellation request. Existing snapshots were displayed separately from the edited live profile.
