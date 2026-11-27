# In-place List Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A background job no longer remounts a list: a metadata change replaces only its record, a file added by a job refreshes the list of its target in place.

**Architecture:** The main process keeps an in-memory change feed (job changed, jobs changed in bulk, file changed, file added to a target) that the renderer reads through `changes:since` after the existing 2 s poll. `files:list` and `jobs:list` can answer chosen ids. `PagedLoader` gets `patch` and `refresh`, and `FileBrowser` and `JobsScreen` use them instead of putting the job token into the list key.

**Tech Stack:** TypeScript, Zod 4, Electron IPC, better-sqlite3 + Drizzle, React, Vitest (+ jsdom).

**Spec:** `docs/superpowers/specs/2026-11-27-in-place-list-updates-design.md`

## Global Constraints

- Everything in the repository is English. No attribution lines in commit messages. Commit after every task; do not push (the controller pushes).
- `core` and `contracts` never import Electron, a provider or a database.
- Error messages and log lines never contain a cause, path, URL or credential.
- No push channel: no `webContents.send`, no change to the preload.
- UI: no new visible text, no colour literals, buttons only through the constants in `ui.ts`.
- Tests never start the app, never call the network. Run a single file with `pnpm --filter @assetforge/<package> test <file>` (no `--`). Before the commit of a task: `pnpm typecheck` and the test files of the touched packages.
- Known flaky tests, not to be "fixed": `inbox.test.tsx > filters and scroll offset survive navigation`, `venice-image.test.ts > maps a refused connection to provider_unreachable`.
- The user's own actions (filter, search, delete, assign, import, tag rename, `reloadToken` of a screen) keep changing the list key and reloading as today.
- `jobs:summary.changes`, `changeToken` and `resultToken` keep their meaning; `AnalysisResultDialog`, `GenerationDetails` and `GenerationStudio` are not touched.

## Review Focus

- A refresh answer arriving after a key change, or after a newer refresh, must be dropped (Task 3 tests).
- A page request started before a refresh and answered after it must not overwrite the refreshed page (Task 3).
- A change answer with `reset: true` (first poll, workspace switch, feed overflow) must refresh in place, not remount and not be ignored (Task 4).
- A patch read that fails or answers late (list key changed meanwhile) must change nothing and report nothing (Task 4).
- A handler's `effects` call that throws must not fail the job (Task 1).

---

### Task 1: Change feed and `changes:since`

**Files:**
- Modify: `packages/contracts/src/jobs.ts`, `packages/contracts/src/ipc.ts`
- Modify: `packages/core/src/jobs.ts` (port), `packages/core/src/analysis-handler.ts`, `packages/core/src/download-handler.ts`, `packages/core/src/generation-handler.ts`, `packages/core/src/index.ts` if it lists exports
- Modify: `packages/jobs/src/scheduler.ts`
- Create: `apps/desktop/src/main/change-feed.ts`
- Modify: `apps/desktop/src/main/job-host.ts`, `apps/desktop/src/main/job-handlers.ts`, `apps/desktop/src/main/composition.ts`, the preload/renderer channel lists if channels are enumerated there
- Test: `apps/desktop/test/change-feed.test.ts` (new), `apps/desktop/test/jobs-ipc.test.ts`, the scheduler and handler test files of `packages/jobs` and `packages/core`

**Interfaces (produced):**

```ts
// contracts/jobs.ts
export const ChangesSchema = z.object({
  cursor: z.string(),
  reset: z.boolean(),
  jobIds: z.array(z.string()),
  jobs: z.boolean(),
  fileIds: z.array(z.string()),
  added: z.array(z.object({ assetId: z.string().nullable() })),
});
export type Changes = z.infer<typeof ChangesSchema>;
// contracts/ipc.ts
'changes:since': { request: z.object({ cursor: z.string().max(100).nullable() }), response: ChangesSchema }

// core/jobs.ts
/** What a job handler changed outside its own job row. Calls must not throw; a handler guards them anyway. */
export interface JobEffects {
  fileChanged(fileId: string): void;
  /** A file was added to this asset; null is the inbox. */
  fileAdded(assetId: string | null): void;
}
// each of the three handler deps gets `effects?: JobEffects`

// jobs/scheduler.ts
onChange?(jobId: string): void;   // the job whose status the scheduler changed

// main/change-feed.ts
export const CHANGE_FEED_CAPACITY = 2000;
export interface ChangeFeed extends JobEffects {
  job(id: string): void;
  jobs(): void;
  /** Forgets every entry and starts a new instance, so every earlier cursor answers `reset`. */
  clear(): void;
  since(cursor: string | null): Changes;
  /** Entries written since the app started; never goes down, `clear` does not reset it. */
  total(): number;
}
export function createChangeFeed(capacity?: number): ChangeFeed;
```

- [ ] **Step 1: Tests for the feed** in `change-feed.test.ts`: `since(null)` answers `reset: true`, empty lists and a cursor; with that cursor, after `job('a')`, `job('a')`, `fileChanged('f')`, `fileAdded(null)`, `fileAdded('x')`, `fileAdded('x')`, `jobs()` the answer is `reset: false`, `jobIds: ['a']`, `fileIds: ['f']`, `added: [{assetId: null}, {assetId: 'x'}]`, `jobs: true`; the returned cursor then answers empty lists and `jobs: false`; after `capacity + 1` entries an old cursor answers `reset: true` with empty lists; after `clear()` every earlier cursor answers `reset: true`; a malformed cursor answers `reset: true`; `total()` counts every entry and survives `clear()`.
- [ ] **Step 2: Implement `createChangeFeed`.** The cursor is `<instance>:<number>`; the instance is a counter raised by `clear()` (plus a random part created once per feed so a restart never matches).
- [ ] **Step 3: Scheduler.** Every existing `changed()` call passes the id of the job whose row it changed; extend one scheduler test to assert the ids for claim and end. A listener that throws is still only logged.
- [ ] **Step 4: Handlers.** Analysis: `fileChanged(fileId)` after the transaction that stored tags or a proposal committed (not when the fingerprint skipped the file, not for a trashed file, not on failure). Download: `fileAdded(target asset id or null)` after the file was placed; nothing for `already_present` or a failure. Generation: `fileAdded(<asset the result was moved into, or null when it stayed in the inbox>)` after the result is linked and moved. Every call sits in a `try/catch` that swallows. One test per handler for the positive and one negative case, plus one where `effects` throws and the job still succeeds.
- [ ] **Step 5: Wiring.** `JobHostDeps.feed: ChangeFeed`; the job host's own counter goes: `changed()` calls `feed.jobs()`, `changes()` answers `feed.total()`, the scheduler's `onChange` is `feed.job`, the handlers get `effects: feed`; `feed.clear()` at the start of `workspaceOpened` and in `workspaceClosing`. `composition.ts` creates the feed. Handler `changes:since` in `job-handlers.ts`: without an open workspace `feed.since(null)`-shaped answer with `reset: true`; otherwise `feed.since(r.cursor)`; it does not go through `manager.read`.
- [ ] **Step 6: IPC test** in `jobs-ipc.test.ts`: `changes:since` without a workspace answers `reset: true`; after an enqueue through IPC a second call with the first cursor answers `jobs: true`; `jobs:summary.changes` rose.
- [ ] **Step 7:** `pnpm typecheck`, tests of `contracts`, `core`, `jobs`, `desktop`; commit `Add the change feed and changes:since`.

### Task 2: `ids` on `files:list` and `jobs:list`

**Files:**
- Modify: `packages/contracts/src/ipc.ts` (both requests), the list methods behind `manager.listFiles` and the `jobs:list` handler (`packages/core`, `packages/persistence/src/file-repository.ts`, `job-repository.ts`, `apps/desktop/src/main/job-handlers.ts`)
- Test: `apps/desktop/test/library-ipc.test.ts`, `apps/desktop/test/jobs-ipc.test.ts`, the repository tests in `packages/persistence`

**Interfaces (produced):** both requests take `ids: z.array(IdSchema).min(1).max(100).optional()` (for jobs the id schema the job id already uses). With `ids` the answer holds only rows whose id is listed **and** that match every other field of the request (scope, filters, search, `hasProposal`, status, provider); `total` counts those; order, `offset` and `limit` are unchanged. `ids` is a list field only: it is not part of `FileListFilterSchema` and never reaches an analysis target.

- [ ] **Step 1: Failing tests:** files — three files in the inbox, `ids` of two answers those two with `total: 2`; the same with a tag filter only one of them carries answers one; an id of a file in another scope answers nothing; 101 ids answer `invalid_request`. Jobs — the same shape with `status`.
- [ ] **Step 2: Implement** as an additional `inArray` condition in the existing where clause of list and count.
- [ ] **Step 3:** typecheck, tests, commit `Let files:list and jobs:list answer chosen ids`.

### Task 3: `patch` and `refresh` on the paged loader

**Files:**
- Modify: `apps/desktop/src/renderer/src/paged-list.ts`, `paged-loader.ts`, `hooks/usePagedList.ts`
- Test: `apps/desktop/test/paged-list.test.ts`, `apps/desktop/test/paged-loader.test.ts`

**Interfaces (produced):**

```ts
// paged-list.ts
/** Replaces loaded items that have the id of one of `items`; returns `state` itself when nothing matched. */
export function patchItems<T extends { id: string }>(state: PagedState<T>, items: readonly T[]): PagedState<T>;

// PagedLoader
patch(items: readonly (T & { id: string })[]): void;   // commit(patchItems(...)); no request
refresh(): void;
/** The loader's current key (without the epoch); callers compare it to drop late answers of their own reads. */

// usePagedList result gains
patch(items: readonly T[]): void;
refresh(): void;
```

`refresh()` semantics:
- While `pending` (a key change is loading) or before page 0 of the key has settled it does nothing: that load is already fresh.
- Otherwise it starts a new *round*: the state key and `displayed` stay, so nothing remounts. Every loaded or failed page that is currently wanted (the wanted pages plus the `loadThrough` pages) is requested again while its old entry stays displayed; every other page is removed from the state at once and loads again when wanted. If no page is wanted, page 0 is refetched.
- Requests of a round respect `maxInFlight` like all others. An answer replaces its page and sets the total (pages beyond a shrunk total go, as in `acceptPage`). A failed refetch keeps the old entry.
- Each request remembers the round it was started in; an answer of an earlier round is dropped (it still frees its slot). The epoch rule for key changes is unchanged.
- A `refresh()` while a round still has outstanding requests is remembered once and runs when the round has settled.
- Pages that become wanted during a round and are not loaded are requested as usual, in the current round.

- [ ] **Step 1: Failing tests** in `paged-loader.test.ts` with controllable promises: (a) `patch` replaces one item, keeps the other pages' entry objects identical, calls `onChange` once, and does nothing for an unknown id; (b) `refresh` with pages 0 and 1 loaded and wanted `[1]`: `displayed.key` is unchanged, page 1 stays loaded until its answer and then holds the new items, page 0 is gone from the state, exactly one request (offset 60) was made; (c) the new total shrinks: pages beyond it are dropped; (d) a request started before `refresh` and answered after it does not overwrite; (e) two `refresh()` calls during a round cause exactly one further round; (f) `refresh` during a pending key change makes no request; (g) a key change during a round drops the round's answers; (h) a failed refetch keeps the old items; (i) never more than `maxInFlight` unsettled requests.
- [ ] **Step 2: Implement.** A `round` counter beside `generation`; keep the implementation in the loader, `paged-list.ts` gets only pure helpers.
- [ ] **Step 3: `usePagedList`** exposes `patch` and `refresh` as stable callbacks.
- [ ] **Step 4:** typecheck, both test files, commit `Add patch and in-place refresh to the paged loader`.

### Task 4: Lists follow the change feed

**Files:**
- Modify: `apps/desktop/src/renderer/src/jobs-context.tsx`, `components/FileBrowser.tsx`, `screens/JobsScreen.tsx`, `screens/AssetScreen.tsx`, `screens/InboxScreen.tsx`, the trash screen only if it passes a job token (it must not react)
- Modify: `apps/desktop/test/renderer/fake-api.ts` if it needs a default for `changes:since`
- Test: `apps/desktop/test/renderer/jobs-context.test.tsx`, `file-browser.test.tsx`, `jobs-screen.test.tsx`, `asset-screen.test.tsx`, `inbox.test.tsx`

**Interfaces:**
- Consumes: `Changes`, `changes:since`, `ids` on both lists, `patch`/`refresh` of `usePagedList`.
- Produces in `jobs-context.tsx`:

```ts
/** Calls `listener` with every change answer while mounted; the latest listener is used, the subscription is stable. */
export function useChanges(listener: (changes: Changes) => void): void;
```

Behaviour:
- `JobsProvider`: after a poll whose `changes` differs from the previous summary's (and after the very first summary), it calls `changes:since` with the cursor it holds (null at first), stores the answered cursor and calls every subscriber. One such request at a time inside the existing poll cycle (the next poll is scheduled after it settled); a failed request keeps the cursor and tries again with the next poll. Subscribers are kept in a ref-held set; delivering changes sets no React state.
- `FileBrowser`: `reloadToken` no longer includes a job token (hosts pass `reloadToken + renameToken`). On a change answer:
  - `reset`, or `added` contains the scope's target (`assetId` of an `asset` scope, `null` for the inbox scope): `refresh()`.
  - otherwise, for the loaded records whose id is in `fileIds`: none → nothing; more than 100 → `refresh()`; else one `files:list` call with `ids`, `offset: 0`, `limit: ids.length` and the same scope, filters and proposal flag as the list. When it answers and the list key is still the one it was started for, `patch(items)`. A failure is ignored.
  - a `trash` scope ignores every change answer.
  - The existing restore-on-`reloadToken` logic stays for the hosts' own reloads.
- `AssetScreen`, `InboxScreen`: the count read no longer depends on `resultToken`; it runs again on a change answer with `reset` or a matching `added` (through `useChanges` bumping a local counter). `useJobs().resultToken` is no longer read there.
- `JobsScreen`: `changeToken` leaves `reloadKey`. On a change answer: `reset` or `jobs` → `refresh()`; otherwise the loaded rows whose id is in `jobIds` are read through `jobs:list` with `ids` and the current status and provider filter and patched under the same rules as above (more than 100 → `refresh()`).

- [ ] **Step 1: `jobs-context` tests:** a subscriber receives the answer after `changes` moved; `changes:since` is called with the cursor of the previous answer; no call when the summary did not move; a rejected `changes:since` keeps the cursor.
- [ ] **Step 2: Implement `useChanges`** and the provider part.
- [ ] **Step 3: `file-browser` tests** (render inside `JobsProvider` with the fake API, fake timers as the existing tests do): (a) a `fileIds` answer for a visible file makes exactly one `files:list` call carrying `ids`, the tile shows the new tag, and the scroll container is the same DOM node as before with its `scrollTop` untouched; (b) `fileIds` for a file that is not loaded makes no call; (c) the `ids` read answers no item: the tile is unchanged; (d) `added: [{assetId: 'other'}]` makes no call; (e) `added` for this scope refetches the visible page without `ids`, no placeholder is rendered in between and the node is the same; (f) `reset` behaves like (e); (g) a trash scope makes no call; (h) the `ids` read answers after a filter change: nothing is patched.
- [ ] **Step 4: Implement `FileBrowser`** and adapt the two hosts and their tests (count re-read only on matching `added`/`reset`).
- [ ] **Step 5: `jobs-screen` tests:** a `jobIds` answer patches the visible row's status with one `jobs:list` call carrying `ids` and the same table node; `jobs: true` refetches the visible page in place; an action of the screen still reloads through `reloadToken`.
- [ ] **Step 6: Implement `JobsScreen`.**
- [ ] **Step 7:** `pnpm typecheck`, `pnpm --filter @assetforge/desktop test`, commit `Update lists in place from the change feed`.

### Task 5: Documentation

- [ ] In `docs/backlog.md` remove the entry about the reload on finished jobs under "Renderer" and add, under the same heading, the known limits from the spec (shifted pages under a job status filter; no reaction of gallery, projects and prompts). Commit `Document in-place list updates`.
