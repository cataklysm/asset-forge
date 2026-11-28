# Gallery discovery queue implementation

Branch: `feat/gallery-import-queue`. Do not merge automatically.

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
| Contracts and background discovery orchestration | discovery_backend | Running | Contract and service tests, lifecycle checks |
| Durable crawl repository and migration | discovery_persistence | Running | SQLite repository and migration tests |
| Parallel crawl and native page readiness/pool | crawl_parallel | Running | Core concurrency, cancellation and page-loader tests |
| Queue, review and profile UI | discovery_ui | Running | Renderer interaction tests |
| Integration, review and branch handoff | root | Running | Typecheck, lint, relevant/full tests, diff review |

All agents share the feature branch with explicit file ownership. Local commits are coordinated by root. No merge or remote push is authorized by this work item.

## TDD evidence

The following tests were added and executed before production edits. Each failed for the missing behavior rather than test setup:

| Journey | RED command | Observed failure |
| --- | --- | --- |
| Parallel detail extraction | `pnpm --filter @assetforge/core test test/site-crawl-concurrency.test.ts` | Expected three detail loads to start; only one started. |
| Usable, stable extracted URLs | `pnpm --filter @assetforge/desktop test test/site-page-readiness.test.ts` | Empty URL results accepted; changing URL values considered stable based only on node count. |
| Close dialog without cancelling | `pnpm --filter @assetforge/desktop test test/renderer/site-import-queue.test.tsx` | Unmount sent `sites:cancelCrawl`. |
| Queue/review IPC and parser settings | `pnpm --filter @assetforge/contracts test site-discovery.test.ts` | Queue/review channels absent and parser settings stripped. |

GREEN results, final validation, native integration evidence and any remaining limitations will be recorded before handoff.
