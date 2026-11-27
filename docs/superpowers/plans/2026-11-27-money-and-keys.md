# Money and Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the eight backlog entries in which a paid request can be doubled, aborted or
misreported, or an API key lost or sent to another origin.

**Architecture:** Four lanes with disjoint files, built in parallel worktrees and integrated by the
controller. No schema change, no migration, one new job error code in contracts.

**Tech Stack:** TypeScript, Zod 4, Vitest (jsdom for the renderer), Electron main, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-11-27-money-and-keys-design.md`

## Global Constraints

- Everything in the repository is English. No attribution lines in commits.
- Error messages that reach the renderer are fixed texts: no cause, path, URL or credential.
- Tests never call the network beyond the in-process mock provider; key literals are
  `test-key-not-real` and `test-key-not-real-2`. Never launch the app, never touch Docker, never call
  host port 11434 or a real provider.
- Renderer: labels in `labels.ts`, button classes from `ui.ts`, no colour literals, no explanatory
  text in the layout.
- Every task is test-first: the tests named in the spec's "Tests" section fail before the change.
- A lane touches only its own files (below). A needed change outside them is reported, not made.
- Single test: `pnpm --filter @assetforge/<package> test <file>` (no `--`). Before the final commit
  of a lane: `pnpm typecheck` and the tests of every package the lane touched.

## Review Focus

- A job that is claimed between the trash check and the cancel: the running check and the cancel
  must read the same state (one synchronous repository call or one transaction).
- A generation whose source was trashed **and** restored into another asset while it ran: the result
  follows the source's asset at placement time.
- A key file in the old form whose entry was already edited to another origin by hand: it is bound
  to that origin once (accepted, stated in the spec); afterwards an edit yields no key.
- A settings file whose entries are all broken: an empty list, the copy exists, no key file removed.
- `cancelAll` without a scheduler while an import holds the manager queue: it must not deadlock and
  must answer the number it cancelled.

---

### Task A: Studio double start (spec §1) — renderer plus one main handler

**Files:** `apps/desktop/src/renderer/src/studio-context.tsx`, `GenerationStudio.tsx`,
`StudioForm.tsx`, `studio-state.ts`, `Dialog.tsx` (only if the remount is removed),
`apps/desktop/src/main/generation-handlers.ts`; tests `apps/desktop/test/renderer/generation-studio.test.tsx`,
`studio-stacking.test.tsx`, `apps/desktop/test/generation-ipc.test.ts`.

**Interfaces:** Produces `useStudio().starting(fileId, kind): boolean` (name free) and the `busy`
answer of `generations:start` with the message `A generation for this file is already being started`.

- [ ] Failing tests: remount with a start in flight keeps Generate disabled; the typed prompt, the
  attached library prompt with its values and the chosen model are still there after a raise; a
  second in-flight `generations:start` for the same file and kind answers `busy`, a start for another
  file or after the first settled (also after a rejection) goes through.
- [ ] Implement, run the tests, typecheck, commit `Keep a generation start and the studio form across a raise`.

### Task B: Paths in messages and workspace removal (spec §6, §8)

**Files:** `packages/core/src/workspace-manager.ts`, `packages/storage/src/local-storage.ts`,
`apps/desktop/src/main/ipc.ts`; tests in `packages/core/test` (workspace manager),
`packages/storage/test/local-storage.test.ts`, `apps/desktop/test/ipc.test.ts`.

- [ ] Failing tests: each of the six messages equals the fixed text for a root path that would be
  recognisable; `workspace:remove` of a workspace that is not open sends neither `workspaceClosing`
  nor `workspaceOpened`, of the open one sends both as today.
- [ ] Implement (the open check inside `lifecycleQueue.run`), run, typecheck, commit
  `Keep paths out of error messages and leave the scheduler alone on a foreign remove`.

### Task C: Provider settings and key binding (spec §4, §5)

**Files:** `apps/desktop/src/main/provider-store.ts`, `secret-codec.ts`; tests
`apps/desktop/test/provider-store.test.ts`, `provider-gateway.test.ts`.

**Interfaces:** `ProviderStore` keeps its public shape (`apiKeyFor(id, baseUrl)`, `hasApiKey` in the
view). The payload form and its marker are the builder's choice; it must tell a bare key from the
new form without guessing.

- [ ] Failing tests for §4: one broken entry (each rule of `entryRules` and the V4 options rule) is
  left out, the others load, the `.corrupt-<stamp>` copy exists, the original stays, every key file
  stays; an unreadable file and a newer version keep every key file; `lastUsedId` of a dropped entry
  reads null; a clean load still sweeps an orphan key file.
- [ ] Failing tests for §5: a new-form key with another origin gives `hasApiKey: false` and no key
  from `apiKeyFor`; a bare key file is rewritten at load and works; a failed rewrite keeps it usable;
  the version 1 adoption writes the new form; an origin change through `save` still removes the key.
- [ ] Implement, run, typecheck, commit `Tolerate broken provider entries and bind a key to its origin`.

### Task D: Trash, result code and cancel fallback (spec §2, §3, §7)

**Files:** `packages/contracts/src/jobs.ts`, `packages/core/src/generation-handler.ts`,
`file-trash.ts`, `jobs.ts`, `generations.ts`, `packages/persistence/src/file-repository.ts`,
`job-repository.ts` (and the in-memory doubles in `packages/core/test`),
`packages/jobs/src/scheduler.ts`, `apps/desktop/src/main/job-host.ts`, `job-handlers.ts`, renderer
`labels.ts`/any exhaustive map over job error codes; tests beside each.

**Interfaces:** Produces `settleGenerationOfJob` exported from core (signature the builder's, used by
the handler's `settled` and the host fallback) and the code `generation_result_not_stored`.

- [ ] Failing tests for §3: import failure without a stream error and `!linked` answer the new code;
  no file row remains; a stream error still answers `provider_outcome_unknown`; the code is not
  retryable and does not pause.
- [ ] Failing tests for §2: trash leaves a running `image.generate` job and cancels a queued one and
  a running analysis; the result of a trashed source lands in `trashedAssetId` with role `generated`
  and `fileAdded` reports that asset; without a former asset it lands in the inbox; purge of a file
  with a running generation answers `invalid_operation` with the fixed message and writes nothing;
  purge with a queued one settles the generation `cancelled`.
- [ ] Failing tests for §7: `cancel` and `cancelAll` on a host without a scheduler end queued jobs and
  settle a pending generation `cancelled`; `cancelAll` with a scheduler leaves a job enqueued during
  the wait untouched.
- [ ] Implement, run core, persistence, jobs and desktop tests, typecheck, commit in up to three
  commits (one per spec section).

### Task E: Close out (controller)

- [ ] Integrate the lanes, whole-branch review, fixes, `pnpm typecheck`, `pnpm test`.
- [ ] Remove the fixed entries from `docs/backlog.md`, add what was found and left.
