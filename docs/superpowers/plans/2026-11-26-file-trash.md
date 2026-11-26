# File Trash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Files can be deleted into an in-app trash, restored from it, and removed from disk only by an explicit purge.

**Architecture:** The trash is a third place for a file next to asset and inbox. Deleting and restoring are journaled moves (`file_move.kind`) whose commit sets or clears three columns on `file`; purging deletes the rows in one transaction and removes the binary afterwards, with a sweep on workspace open for the crash in between. Every query that reads files without going through an asset excludes trashed files.

**Tech Stack:** TypeScript, Zod, better-sqlite3 + Drizzle (migration `0008`), Vitest (+ jsdom), React, Tailwind tokens.

**Spec:** `docs/superpowers/specs/2026-11-26-file-trash-design.md` — read it together with the task brief; it wins over this plan.

## Global Constraints

- Everything in the repository is English. No attribution lines in commits. Agents commit but do not push.
- Never launch the app, never call "Open externally"/"Show in folder", never touch host port 11434, never start, stop or remove Docker containers.
- `core` and `contracts` do not import Electron, Drizzle or a provider. Renderer and preload hold no persistence logic.
- Error messages are fixed strings: no paths, IDs of other objects, cause messages or credentials in them.
- Invariant, enforced in repositories and pinned by tests (no CHECK): `deleted_at is not null` implies `asset_id is null and role is null`. `status` is not changed by deleting.
- Migration `0008` contains only `ALTER TABLE … ADD` and `CREATE INDEX` statements; `file` is not rebuilt.
- Purge and sweep never remove anything outside `.assetforge/trash/`. Nothing is purged automatically. No row is purged while the storage is unreachable.
- Transactions stay short; storage operations run outside them. Batches are 1–1000 file IDs (`FileIdsSchema`).
- No confirmation on Delete or Restore. Delete permanently and Empty trash confirm through the shared dialog and name the number of files.
- UI: no explanatory text in the layout (tooltips through `title`), buttons only from `BUTTON` / `ICON_BUTTON` / `BUTTON_INLINE` in `ui.ts`, tokens only, labels in `labels.ts`. `test/theme.test.ts` and `test/labels.test.ts` stay green.
- Commands: `pnpm --filter @assetforge/<package> test <file>` (no `--`), `pnpm typecheck`, `pnpm test`. After a schema change `pnpm --filter @assetforge/persistence db:generate`.
- Fixed messages used by more than one task:
  - `'The file is in the trash'` (`InvalidOperationError`) — tagging, assigning, detaching, cover, accept proposal, open/reveal.
  - `'The file is already in the trash'`, `'The file is not in the trash'`, `'The file is still being imported'` (`InvalidOperationError`).
  - `'The file is missing on disk and cannot be restored'` (`InvalidOperationError`).
  - `'The file of this job is in the trash'` (`InvalidOperationError`).

## Review Focus

1. A selection of 1000 files with a few that cannot be deleted (pending, already trashed by a double key press): the others are still deleted and the strip reports both counts. → Task 4 (per-item test), Task 8 (double `Delete` key).
2. Deleting the file that is an asset's chosen cover: the gallery shows the automatic cover at once, and restoring does not make it the chosen cover again. → Task 2.
3. Deleting while the analysis of that file runs: no tag and no proposal lands on the trashed file, and "Retry failed" on the Jobs screen does not bring the job back. → Tasks 3 and 5.
4. Two files with the same name deleted from different places, and a name with characters a file system refuses: both land in the trash under distinct paths. → Task 4.
5. The app is killed during Empty trash: on the next open no trashed row points at a removed binary, and no binary without a row stays in the trash directory. → Task 4 (sweep), Task 7 (acceptance).

## Lanes

Task 1 runs first and alone. Then three lanes run in parallel worktrees: **A** persistence (Tasks 2, 3), **B** core (Tasks 4, 5), **C** renderer (Tasks 8, 9, 10). After A and B are integrated: Task 6 (main process), then Task 7 (acceptance and documentation).

Lane ownership: A edits only `packages/persistence`; B edits only `packages/core` and `packages/jobs/test`; C edits only `apps/desktop/src/renderer`, `apps/desktop/src/preload` and `apps/desktop/test/renderer`.

---

### Task 1: Contracts, ports, paths and migration `0008`

**Files:**
- Modify: `packages/contracts/src/files.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/test/` (the file schema and channel tests that exist there)
- Modify: `packages/core/src/paths.ts`, `packages/core/src/ports.ts`, `packages/core/src/analysis.ts`
- Modify: `packages/persistence/src/schema.ts`, `packages/persistence/src/file-repository.ts`, `packages/persistence/src/file-move-repository.ts`, `packages/persistence/src/job-repository.ts`
- Create: `packages/persistence/migrations/0008_*.sql` (generated), `packages/persistence/test/migration-0008.test.ts`
- Modify: `packages/core/test/fakes.ts`, `packages/core/test/memory-jobs.ts`
- Modify: every test fixture and renderer fixture that builds a `FileRecord` literal (typecheck finds them)

**Interfaces:**
- Produces (contracts):
  - `FileRecordSchema` gains `deletedAt: z.string().nullable()`, `trashedAssetId: z.uuid().nullable()`, `trashedAssetName: z.string().nullable()`, `trashedRole: FileRoleSchema.nullable()`.
  - `FileScopeSchema` gains `{ kind: 'trash' }`.
  - `FileBatchResultSchema` — the shape of `AssignManyResultSchema` under a neutral name; `AssignManyResultSchema` stays as an alias of it. For a purged file and for a failed file removed outright the item is `{ fileId, file: null, error: null }`.
  - Channels: `'files:trashMany'`, `'files:restoreMany'`, `'files:purgeMany'` with request `{ fileIds: FileIdsSchema }` and response `FileBatchResultSchema`; `'trash:empty'` with `EmptyRequestSchema` → `{ purged: int ≥ 0, failed: int ≥ 0 }`; `'trash:summary'` with `EmptyRequestSchema` → `{ count: int ≥ 0 }`.
- Produces (core):
  - `TRASH_DIR = '.assetforge/trash'`, added to `LAYOUT_DIRS`; `trashPath(fileId: string, originalName: string): string` → `` `${TRASH_DIR}/${fileId}_${sanitised name}` `` with the sanitising `inboxPath` uses.
  - `type FileMoveKind = 'relocate' | 'trash' | 'restore'`; `FileMove.kind: FileMoveKind` (required; existing callers pass `'relocate'`).
  - `FileRepository.purge(id: string): Promise<boolean>` — deletes the file row and every row that references it, in one transaction, only for a row that is trashed or has status `failed`; `false` otherwise and for an unknown id.
  - `FileRepository.countTrashed(): Promise<number>`, `FileRepository.listTrashedIds(): Promise<string[]>` (newest deletion first).
  - `JobRepository.activeForFile(fileId: string): Promise<Job[]>` — jobs in `queued`, `retry_wait`, `running`, `waiting_remote`.
  - `isAnalysable(file)` is false for a file with `deletedAt !== null`.
- Produces (persistence): columns `file.deleted_at`, `file.trashed_asset_id` (FK `asset.id`, on delete set null), `file.trashed_role`, index `file_deleted_at_idx`; `file_move.kind` text not null default `'relocate'`. `toRecord` maps the four new fields (`trashedAssetName` from the asset row) and answers `openable: false` for a trashed file.
- In this task the three new repository methods and `activeForFile` are stubs that throw `new Error('not implemented')` in `packages/persistence` and in the fakes; Tasks 2–4 replace them. `kind` is stored and read by the move repository, but its commit still behaves as `relocate`.

- [ ] **Step 1: Contract tests.** `FileRecordSchema` rejects a record without `deletedAt`; `FileScopeSchema` accepts `{ kind: 'trash' }`; each new channel accepts a valid request and rejects 0 and 1001 file IDs and duplicate IDs. Run: `pnpm --filter @assetforge/contracts test` → FAIL.
- [ ] **Step 2: Implement the contract changes.** Run again → PASS.
- [ ] **Step 3: Path test** in `packages/core/test/paths.test.ts` (create if missing): `trashPath(id, 'a/b:c?.png')` starts with `.assetforge/trash/<id>_`, contains no `/` after that prefix and equals `inboxPath`'s file name part for the same input; `LAYOUT_DIRS` contains `TRASH_DIR`. One test in `packages/core/test/analysis*.test.ts`: `isAnalysable` is false for a complete previewable file with `deletedAt` set. → FAIL, implement, PASS.
- [ ] **Step 4: Ports and schema.** Add the port members, the Drizzle columns and index, run `db:generate`. Open the generated SQL: if it contains anything but `ALTER TABLE … ADD` and `CREATE INDEX`, replace it by hand with exactly those statements and keep the snapshot.
- [ ] **Step 5: `migration-0008.test.ts`**, built like `migration-0007.test.ts`: a database migrated up to `0007` holding an asset, an attached file, an inbox file, a `file_move` row and a job migrates; afterwards every file has `deleted_at`, `trashed_asset_id`, `trashed_role` null, the move row has `kind = 'relocate'`, `PRAGMA foreign_key_check` is empty, and all rows are still there.
- [ ] **Step 6: Mapping and stubs.** `toRecord`, fakes and fixtures; stubs as described. Run `pnpm typecheck` and `pnpm test` → both green.
- [ ] **Step 7: Commit** `feat: add the file trash contracts, ports and migration 0008`.

---

### Task 2: Persistence — move kinds, trash scope, purge (lane A)

**Files:**
- Modify: `packages/persistence/src/file-move-repository.ts`, `packages/persistence/src/file-repository.ts`
- Test: `packages/persistence/test/file-trash-repository.test.ts` (new), `packages/persistence/test/library-repositories.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `FileMoveRepository.commit(fileId)` by kind. `trash`: `trashed_asset_id`/`trashed_role` take the row's current `asset_id`/`role`, both are cleared, `deleted_at` = the move's `createdAt`, `relative_path` = target, a chosen cover pointing at the file is cleared, the former asset is reindexed. `restore`: `asset_id`/`role` from the move's target, the three trash columns cleared, `relative_path` = target, the asset reindexed, no cover is set. `relocate`: unchanged.
  - `FileRepository.list`: scope `all` and `inbox` exclude trashed files; scope `trash` returns only trashed files ordered `deleted_at desc, id desc` with the query, tag, kind, role and proposal filters working as elsewhere; `total` follows.
  - `findCompleteBySha256` ignores trashed files.
  - `purge`, `countTrashed`, `listTrashedIds` as in Task 1.

- [ ] **Step 1: Failing tests** in `file-trash-repository.test.ts` (real SQLite, the helpers of `library-repositories.test.ts`):
  - `commit of a trash move records the origin and clears the placement` — attached file with role; after begin(kind `trash`) + commit: `assetId`, `role` null, `deletedAt` = move `createdAt`, `trashedAssetId`/`trashedRole`/`trashedAssetName` = former values, `relativePath` = target, no move row left.
  - `trashing the chosen cover clears it` — `asset.cover_file_id` null afterwards.
  - `trashing removes the file name from the asset's search index` — an asset found only through that file name is no longer found by `assets.list({ query })`; found again after a restore commit.
  - `commit of a restore move puts the file back and clears the trash columns` — also asserts the cover stays null.
  - `an inbox file is trashed with a null origin and restored to the inbox`.
  - `deleting the asset of a trashed file nulls trashed_asset_id` — raw `DELETE` of the asset row with foreign keys on, after removing what else references it.
  - `scope all, inbox and asset exclude a trashed file; scope trash lists only trashed files, newest deletion first` — two trashed files with different `createdAt`, one live inbox file, one live asset file; totals asserted for each scope.
  - `scope trash honours query, tagNames and kind`.
  - `findCompleteBySha256 ignores a trashed file`.
  - `purge removes the row with its tags, analysis, proposal, jobs and move row` — with foreign keys on; other files' rows untouched; returns `true`.
  - `purge refuses a live complete file and an unknown id` → `false`, nothing deleted.
  - `purge removes a failed file that was never trashed` → `true`.
  - `countTrashed and listTrashedIds`.
  - `the invariant holds for every trashed row` — after all of the above setups: no row with `deleted_at` set has `asset_id` or `role`.
  - Extend the list query-plan test that uses `fileListSql`: scope `trash` uses `file_deleted_at_idx`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/persistence test file-trash-repository` → FAIL (not implemented).
- [ ] **Step 3: Implement.** `scopeMatches` carries the trash condition so `fileListWhere` (shared with the analysis target reader) inherits it; `purge` deletes dependents in the order tags, analysis, proposal, jobs, move, then the file.
- [ ] **Step 4: Run** the package's tests → PASS. `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: commit file moves by kind and add the trash queries`.

---

### Task 3: Persistence — jobs, analysis and tags ignore trashed files (lane A)

**Files:**
- Modify: `packages/persistence/src/job-repository.ts`, `file-analysis-repository.ts`, `analysis-target-reader.ts`, `tag-repository.ts`
- Test: `packages/persistence/test/job-repository.test.ts`, `file-analysis-repository.test.ts`, `proposal-repository.test.ts`, `analysis-target-reader.test.ts`, `tag-repository.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2 (a trashed file is produced with begin + commit of kind `trash`).
- Produces:
  - `JobRepository.activeForFile` implemented. `enqueue` does not insert a job whose `fileId` is trashed or unknown, checked in the inserting transaction; its ID is missing from the returned list like a deduplicated one. `retry({ id })` and `retry({})` skip jobs whose file is trashed.
  - `FileAnalysisRepository.apply`, `propose`, `acceptProposal` return `false` and write nothing for a trashed file; `acceptProposal` keeps the proposal of a trashed file (it deletes only a genuinely stale one).
  - `AnalysisTargetReader.page`/`count`: a trashed file is never analysable, for the targets `files` and `fileFilter` (including a `fileFilter` with scope `trash`).
  - `TagRepository.suggest`: usage counts ignore tags carried only by trashed files (such a tag is still suggested when an asset or a live file carries it). `addToFiles`/`removeFromFiles` throw `InvalidOperationError('The file is in the trash')` when one file is trashed, and then change nothing.

- [ ] **Step 1: Failing tests**, one per bullet above, each with one trashed file among live ones:
  - `activeForFile returns queued, retry_wait, running and waiting_remote jobs of the file only`.
  - `enqueue skips a trashed file` — two jobs, one for a trashed file: one ID returned, one row.
  - `retry by id returns 0 for a job of a trashed file`, `retry of all failed skips jobs of trashed files`.
  - `apply writes nothing to a trashed file` — returns `false`, no `file_tag`, no `file_analysis` row; same for `propose`.
  - `acceptProposal on a trashed file returns false and keeps the proposal`.
  - `a trashed file is not analysable for a files target`, `… for a fileFilter target`, `count agrees with page`.
  - `suggest does not count a trashed file`, `batch tagging refuses a trashed file and tags none`.
- [ ] **Step 2: Run** the five test files → the new tests FAIL.
- [ ] **Step 3: Implement.** `matchingFile` and `analysableSql` gain `deleted_at is null`; `completeFiles` gains the trash check.
- [ ] **Step 4: Run** `pnpm --filter @assetforge/persistence test` → PASS. `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: keep jobs, analysis and tags away from trashed files`.

---

### Task 4: Core — trash, restore, purge, empty, sweep (lane B)

**Files:**
- Create: `packages/core/src/file-trash.ts`, `packages/core/test/file-trash.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/workspace-manager.ts`, `packages/core/test/fakes.ts`, `packages/core/test/memory-jobs.ts`, `packages/core/test/recovery.test.ts`

**Interfaces:**
- Consumes: Task 1; `cancelJob(s, control, jobId)` from `jobs.ts`; `JobControl`.
- Produces (all exported from `@assetforge/core`):
  - `type FileBatchItem = { fileId: string; file: FileRecord | null; error: Error | null }`.
  - `trashFiles(s: WorkspaceSession, control: JobControl, fileIds: readonly string[]): Promise<FileBatchItem[]>`
  - `restoreFiles(s: WorkspaceSession, fileIds: readonly string[]): Promise<FileBatchItem[]>`
  - `purgeFiles(s: WorkspaceSession, control: JobControl, fileIds: readonly string[]): Promise<FileBatchItem[]>`
  - `emptyTrash(s: WorkspaceSession, control: JobControl): Promise<{ purged: number; failed: number }>`
  - `trashCount(s: WorkspaceSession): Promise<number>`
  - `sweepTrash(ctx: { storage: Storage; files: Pick<FileRepository, 'get'> }): Promise<{ removed: string[]; skipped: string[] }>`
  - `WorkspaceManager.doOpen` calls `sweepTrash` right after `recoverFileMoves`; a failing sweep does not fail the open.
  - The fakes implement Task 1's ports and the behaviour of Tasks 2 and 3 that core tests need (move commit by kind, list scopes, `purge`, `countTrashed`, `listTrashedIds`, `activeForFile`).

Behaviour, per file, in request order, one failure never stopping the next:

- **trash** — unknown → `NotFoundError`; `pending` → `'The file is still being imported'`; already trashed → `'The file is already in the trash'`; storage not reachable → the existing unreachable-storage error. `failed`: remove `stagingPath(id)` and the row's `relativePath` from storage, then `files.purge(id)`; item `file: null`. `complete`: cancel every job from `jobs.activeForFile` through `cancelJob` (not awaited beyond what `cancelJob` awaits); `fileMoves.begin` with kind `trash`, target `trashPath(id, originalName)`, null asset and role, `createdAt` = now; when the binary exists, `storage.move` (on failure `abort` and the relocation's existing message); when it is missing, no move; then `commit`.
- **restore** — unknown → `NotFoundError`; not trashed → `'The file is not in the trash'`; unreachable → storage error; binary missing → `'The file is missing on disk and cannot be restored'`. Target: `assetFilePath(trashedAssetId, trashedRole, id, originalName)` when `trashedAssetId` is set, else `inboxPath`. Begin with kind `restore`, move, commit as above.
- **purge** — unknown → `NotFoundError`; not trashed → `'The file is not in the trash'`; unreachable → storage error. Cancel active jobs as in trash, `files.purge(id)`, then `storage.remove(relativePath)` only when the path starts with `TRASH_DIR + '/'`; a failing removal is swallowed (the sweep retries). Item `file: null`.
- **emptyTrash** — `listTrashedIds()`, then `purgeFiles` over chunks of 200; counts items without and with an error.
- **sweepTrash** — `storage.list(TRASH_DIR)`; the file ID is the first 36 characters of an entry; an entry whose ID has no row is removed; an entry with any row, or whose name does not start with a UUID followed by `_`, is left alone; removal errors go to `skipped`.

- [ ] **Step 1: Failing tests** in `file-trash.test.ts` with `InMemoryStorage`, `InMemoryDatabase` and a recording `JobControl`:
  - `trashing an asset file moves the binary into the trash directory and records the origin` — storage has the trash path and not the old one; record as in Task 2's first test.
  - `trashing an inbox file`; `restore puts it back into the inbox`.
  - `restore returns the file to its asset and role with tags, analysis record and proposal intact`.
  - `restore goes to the inbox when the asset is gone` (`trashedAssetId` null).
  - `two files with the same name get distinct trash paths`; `a name with reserved characters is sanitised`.
  - `trashing cancels queued jobs and asks the scheduler to cancel a running one` — queued job ends `cancelled`, `control.cancel` called with the running job's ID, and the trash does not wait for a never-resolving handler.
  - `a pending file is refused`, `an already trashed file is refused`, `an unknown id is not_found` — and in one batch with a valid file the valid one is still trashed (Review Focus 1).
  - `a failed file is removed outright with its leftover binary` — no row, no trash entry, item `{ file: null, error: null }`.
  - `a complete file with a missing binary is trashed without a move` — `relativePath` is the trash path; `restore` of it is refused with the fixed message and it stays trashed; `purge` of it succeeds.
  - `an unreachable storage refuses trash, restore and purge` — rows and storage unchanged.
  - `a failing move aborts the journal and leaves the file where it was`.
  - `purge removes the row and then the binary`; `purge of a live file is refused`; `purge cancels a still active job first`; `purge never removes a path outside the trash directory` (a trashed row whose `relativePath` was forced elsewhere: row gone, that path still present).
  - `a binary that cannot be removed still counts as purged`.
  - `emptyTrash purges everything and reports purged and failed` — 450 trashed files, one made to fail.
  - `sweepTrash removes binaries without a row and keeps the others` — orphan removed; binary of a trashed row kept; binary of a live row kept; an entry `notes.txt` kept.
  - In `recovery.test.ts`: `an interrupted trash move is committed when the binary already moved` and `… aborted when it did not`, the same pair for `restore`; `opening a workspace sweeps the trash after recovering moves` (Review Focus 5: orphan binary gone, trashed row's binary kept).
- [ ] **Step 2: Run** `pnpm --filter @assetforge/core test file-trash` → FAIL.
- [ ] **Step 3: Implement** the fakes, then `file-trash.ts`, then the `doOpen` call.
- [ ] **Step 4: Run** `pnpm --filter @assetforge/core test` → PASS. `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: add trash, restore, purge and the trash sweep to the core`.

---

### Task 5: Core — guards on existing use cases (lane B)

**Files:**
- Modify: `packages/core/src/asset-files.ts`, `tags.ts`, `asset-cover.ts`, `file-access.ts`, `analysis-proposals.ts`, `jobs.ts`, `analysis-handler.ts` (only if a test shows a gap)
- Test: `packages/core/test/asset-files.test.ts`, `tags.test.ts`, `file-access.test.ts`, `analysis-proposals.test.ts`, `jobs.test.ts`, `analysis-enqueue.test.ts`, `import.test.ts`, `measure-file.test.ts`, the analysis handler test; `packages/jobs/test/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 4's fakes and `trashFiles`.
- Produces: unchanged signatures; new refusals.

- [ ] **Step 1: Failing tests**, each trashing a file through `trashFiles` first:
  - `relocateFile refuses a trashed file` (assign and detach), `assignFiles reports it per item` — `InvalidOperationError('The file is in the trash')`.
  - `addFileTag and removeFileTag refuse a trashed file`; `addFileTags and removeFileTags refuse a batch containing one` and tag none.
  - `setAssetCover refuses a trashed file`.
  - `resolveFilePath refuses a trashed file for open and reveal`; `resolvePreviewSource and resolveOriginalSource still serve it`; `measureFile still measures it`.
  - `acceptProposal refuses a trashed file and keeps its proposal`.
  - `retryJob refuses a job whose file is in the trash` → `'The file of this job is in the trash'`; `retryFailedJobs skips it and counts only the others`.
  - `enqueue counts a trashed file as not analysable and creates no job` (targets `files` and `fileFilter`), `analysis:preview` counts agree.
  - `an import of the same content as a trashed file is not a duplicate`.
  - Handler: `a job whose file was trashed after the image was read ends file_unavailable and writes nothing` — trash between `readModelImage` and `apply`, for both modes; `a job started for an already trashed file ends file_unavailable`.
  - `packages/jobs/test/scheduler.test.ts`: `a run whose job row was removed settles without an error and frees its slot` — the row is deleted while the handler runs; the next queued job of the class is claimed.
- [ ] **Step 2: Run** the listed files → the new tests FAIL (some may pass through Task 1's `isAnalysable`; keep them).
- [ ] **Step 3: Implement** the guards. A shared `requireLiveFile` helper next to `requireFile` is fine.
- [ ] **Step 4: Run** `pnpm --filter @assetforge/core test` and `pnpm --filter @assetforge/jobs test` → PASS. `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: refuse trashed files in tagging, placement, analysis and retry`.

---

### Task 6: Main process — IPC handlers

**Files:**
- Modify: `apps/desktop/src/main/library-handlers.ts`, `apps/desktop/src/main/ipc.ts`
- Test: `apps/desktop/test/library-ipc.test.ts`, `apps/desktop/test/jobs-ipc.test.ts`, `apps/desktop/test/file-shell-ipc.test.ts`, `apps/desktop/test/media-protocol.test.ts`

**Interfaces:**
- Consumes: Task 4's use cases; `JobHost` (`cancel`, `changed`, `wake`).
- Produces: `createLibraryHandlers(manager, dialogs, host, jobs: JobHost)` with the five new channels. The three batch channels and `trash:empty` run in `manager.exclusive`, map item errors with `toIpcError(error, channel)` like `files:assignMany`, and call `jobs.changed()` and `jobs.wake()` afterwards. `trash:summary` runs in `manager.read`.

- [ ] **Step 1: Failing tests:**
  - `files:trashMany returns one item per file and keeps going after a failing one` (unknown ID → `not_found`, a second valid file trashed).
  - `files:restoreMany` and `files:purgeMany` round trip on real SQLite and a temp directory: binary in `.assetforge/trash/` after trash, back at the asset path after restore, gone after purge; `files:list` scope `inbox` and `all` never show the trashed file, scope `trash` does.
  - `trash:summary counts`, `trash:empty returns purged and failed`.
  - `the trash channels answer no_workspace_open without a workspace` and `invalid_request` for 0, 1001 and duplicate IDs.
  - `files:trashMany raises the job change counter`.
  - `jobs:retry answers invalid_operation for a job of a trashed file`.
  - `files:openExternal / files:showInFolder answer invalid_operation for a trashed file` (channel names as in `file-shell-ipc.test.ts`); `the media protocol serves the preview of a trashed file`.
  - `files:addTag, files:assign and files:unassign answer invalid_operation for a trashed file`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test library-ipc` → FAIL.
- [ ] **Step 3: Implement** the handlers and the wiring.
- [ ] **Step 4: Run** `pnpm --filter @assetforge/desktop test` → PASS. `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: expose trash, restore and purge over IPC`.

---

### Task 7: Acceptance and documentation

**Files:**
- Modify: `apps/desktop/test/acceptance.test.ts`
- Modify: `ReadMe.md` (§3.3, §9.2, §9.4, §10, IPC list), `docs/backlog.md`, `CLAUDE.md`

- [ ] **Step 1: Acceptance test** `a deleted file leaves every view and comes back intact`: import two images into an asset, tag one, make it the chosen cover; trash it → asset detail has one file and the automatic cover, gallery search by its file name finds nothing, `tags:suggest` does not count its tag, `trash:summary` is 1; close and reopen the workspace → still trashed; restore → file, tag and role back, cover still automatic; trash + purge → row and binary gone.
- [ ] **Step 2: Acceptance test** `a purge interrupted before the binary is removed is finished by the next open`: trash a file, delete its rows through the repository's `purge` only, reopen → the binary is gone from `.assetforge/trash/`, a second trashed file's binary is still there.
- [ ] **Step 3: Run** `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build` → all green.
- [ ] **Step 4: Documentation** as listed in the spec's Documentation section: ReadMe sections; backlog (remove the "delete files" request, resolve the `job.file_id` / `file_analysis.file_id` entry, add the deferred items of the reviews); `CLAUDE.md` project state gains one "File trash is implemented" passage naming the spec, the columns, the channels and what does not exist (automatic emptying, deleting assets or projects).
- [ ] **Step 5: Commit** `test: cover the file trash end to end` and `docs: describe the file trash`.

---

### Task 8: Renderer — trash count context and Delete actions (lane C)

Paths below are relative to `apps/desktop/src/renderer/src` (`R`) and `apps/desktop/test/renderer` (`T`).

**Files:**
- Create: `R/trash-context.tsx`, `R/trash-actions.ts`, `T/trash-context.test.tsx`
- Modify: `R/labels.ts`, `R/file-actions.ts`, `R/components/FileTile.tsx`, `R/components/FileBrowser.tsx`, `R/components/ResultStrip.tsx`, `R/components/AssetFilesTab.tsx`, `R/screens/InboxScreen.tsx`, `R/components/FileDetailDialog.tsx`, `T/fixtures.ts`
- Test: `T/file-browser.test.tsx`, `T/asset-screen.test.tsx`, `T/inbox.test.tsx`, `T/file-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 1's contracts (`files:trashMany`, `trash:summary`, `FileRecord.deletedAt`).
- Produces:
  - `labels.ts`: `TRASH_LABEL = 'Trash'`, `DELETE_LABEL = 'Delete'`, `DELETE_TITLE = 'Moves the file to the trash'`, `DELETE_SELECTION_TITLE = 'Moves the files to the trash'`, `RESTORE_LABEL = 'Restore'`, `RESTORE_TITLE = 'Puts the file back where it was'`, `RESTORE_SELECTION_TITLE = 'Puts the files back where they were'`, `PURGE_LABEL = 'Delete permanently'`, `PURGE_TITLE = 'Removes the file from disk; asks first'`, `PURGE_SELECTION_TITLE = 'Removes the files from disk; asks first'`, `EMPTY_TRASH_LABEL = 'Empty trash'`, `EMPTY_TRASH_TITLE = 'Removes every file in the trash from disk; asks first'`, `CANCEL_LABEL = 'Cancel'`, `purgeConfirmTitle(count: number): string` → `'Delete 1 file permanently?'` / `'Delete 12 files permanently?'`, `trashNavLabel(count: number): string` → `'Trash, 1 file'` / `'Trash, 12 files'`.
  - `trash-context.tsx`: `TrashProvider({ children })`, `useTrash(): { count: number | null; refresh(): void }`. Loads `trash:summary` on mount and on every `refresh()`; one request in flight, a refresh during a request runs once more afterwards; a failure keeps the last count. Outside a provider: `{ count: null, refresh: no-op }`.
  - `trash-actions.ts`: `runFileBatch(channel: 'files:trashMany' | 'files:restoreMany' | 'files:purgeMany', files: readonly FileRecord[]): Promise<{ doneIds: string[]; failures: ResultFailure[] }>` — one call with all IDs; a failure names the file by `originalName`.
  - `ResultStrip.tsx`: `assignFailures` accepts `FileBatchResult['items']` (same shape).
  - `FileActionContext` gains `onDelete?(): void`, `onRestore?(): void`, `onPurge?(): void`. `fileMenuItems`: for a file with `deletedAt !== null` the items are exactly Details, Restore (if `onRestore`), Delete permanently (if `onPurge`) — nothing else, whatever else the context carries. For a live file Delete (if `onDelete`, title `DELETE_TITLE`) is the last item, after Detach, for every status except `pending`.
  - `FileBrowserProps.onDeleteKey?(): void` and `FileViewProps.onDeleteKey?(): void`: the `Delete` key on a focused item (same `event.target === event.currentTarget` rule as the other item keys, so never from an input or an inner control) calls it and prevents the default.
  - `fixtures.ts`: `fileRecord` defaults the four new fields to null; `trashedRecord(p)` sets `deletedAt` and clears `assetId`/`role`.

Behaviour in both hosts (asset Files tab, inbox):
- Single Delete (menu, detail dialog): `runFileBatch('files:trashMany', [file])`, drop the ID from the selection, reload through the host's existing path (`onFilesChanged()` / `reload()`), `useTrash().refresh()`. A failure is shown where Detach's failure is shown today. In the dialog `onDelete` is wrapped by `guard`; the dialog moves on through the browser's existing "viewed file left the list" handling.
- Selection Delete (selection bar button `DELETE_LABEL` with `DELETE_SELECTION_TITLE`, placed after Detach in the asset tab and after the analysis buttons in the inbox; and the `Delete` key): all selected files, not only the eligible ones; runs through the host's existing batch guard, so a second key press during a running batch does nothing; afterwards drop the done IDs, show `ResultStrip` only when something failed with the title `` `${done} deleted, ${failed} failed` ``, reload, refresh the trash count. The button is disabled only while a batch runs.
- No confirmation anywhere in this task.

- [ ] **Step 1: Failing tests:**
  - `trash-context.test.tsx`: `loads the count on mount`, `refresh loads again`, `a failing request keeps the last count`, `useTrash outside a provider is inert`.
  - `file-browser.test.tsx`: `the menu of a live file ends with Delete`, `a pending file has no Delete`, `a failed file offers Details and Delete`, `a trashed file offers only Details, Restore and Delete permanently` (context also carries `onDetach`, `onAnalyse`, `onSetCover`), `the Delete key on a focused tile calls onDeleteKey`, `the Delete key inside the search field does not`.
  - `asset-screen.test.tsx`: `Delete in the tile menu calls files:trashMany with the file and reloads the list and the asset`, `Delete in the selection bar sends all selected files including a failed one`, `a partly failing batch shows "1 deleted, 1 failed" and keeps the failed file selected`, `pressing Delete twice sends one request` (first held open with `deferred()`), `no dialog opens on Delete`.
  - `inbox.test.tsx`: `the selection bar offers Delete`, `deleting a failed file from its menu removes it`, `the Delete key deletes the selection`, `the inbox count reloads after a delete`.
  - `file-dialog.test.tsx`: `Delete in the More menu trashes the file and the dialog shows the next one`, `deleting the last file closes the dialog`, `a failing delete shows the message in the dialog`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test trash-context file-browser asset-screen inbox file-dialog` → the new tests FAIL.
- [ ] **Step 3: Implement.** Both hosts read `useTrash()`; tests that need the count wrap in `TrashProvider`.
- [ ] **Step 4: Run** `pnpm --filter @assetforge/desktop test` (includes `theme.test.ts`, `labels.test.ts`) → PASS. `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: delete files from the asset, the inbox and the viewer`.

---

### Task 9: Renderer — Trash screen (lane C)

**Files:**
- Create: `R/screens/TrashScreen.tsx`, `R/components/ConfirmDialog.tsx`, `T/trash.test.tsx`
- Modify: `R/components/FileBrowser.tsx`, `R/components/FileTable.tsx`, `R/components/FileTile.tsx`, `R/components/FileDetailDialog.tsx`, `R/list-state.ts` (only if a trash list state type belongs there next to `InboxListState`)
- Test: `T/dialog-menu-tabs.test.tsx`, `T/file-dialog.test.tsx`, `T/file-browser.test.tsx`

**Interfaces:**
- Consumes: Task 8.
- Produces:
  - `ConfirmDialog({ open, title, confirmLabel, busy, onConfirm, onCancel })` — the shared `Dialog` (`size="form"`) with the title as its only text and two `BUTTON`s: `confirmLabel` and `CANCEL_LABEL`. Cancel has the initial focus; Esc cancels; both buttons are disabled while `busy`.
  - `TrashListState = { filters: FileFilters; scrollOffset: number }` and `TrashScreen({ state, onStateChange }: { state: TrashListState; onStateChange(s: TrashListState): void })`.
  - `FileBrowser` with `scope.kind === 'trash'`: no role filter, and the table shows two more columns, `Deleted` (the deletion date, formatted like the import date) and `Origin` (`trashedAssetName`, or `Inbox` when `trashedAssetId` is null); the grid tile's meta line shows the origin. The `analysis` prop is not passed, so Proposals and Analyse all are absent.
  - `FileDetailDialog` for a file with `deletedAt !== null`: the Details list gains `Deleted` and `Origin`; tags render read-only (as asset tags do); no role or assign section (the host passes `roleControl={null}`); the More menu comes from `fileMenuItems` and so holds Restore and Delete permanently only.

Screen behaviour:
- `Page` titled `TRASH_LABEL` with the unfiltered count; header action `EMPTY_TRASH_LABEL` (title `EMPTY_TRASH_TITLE`, disabled when the trash is empty or an action runs).
- `FileBrowser` over `{ kind: 'trash' }` with grid/table, search, tag and kind filters, multi-select and the viewer; `emptyText` `'Trash is empty'`.
- Selection bar: `RESTORE_LABEL`, `PURGE_LABEL`. Menu and dialog: the same two.
- Restore (single and selection): `runFileBatch('files:restoreMany', …)` at once, no confirmation; strip title `` `${done} restored, ${failed} failed` `` on failures.
- Delete permanently (single, selection, and the `Delete` key on a selection): opens `ConfirmDialog` with `purgeConfirmTitle(n)` and `PURGE_LABEL`; confirm runs `runFileBatch('files:purgeMany', …)`; strip `` `${done} deleted, ${failed} failed` `` on failures.
- Empty trash: `ConfirmDialog` with `purgeConfirmTitle(total)` (the unfiltered trash count) and `EMPTY_TRASH_LABEL`; confirm calls `trash:empty`; when `failed > 0` the strip shows `` `${purged} deleted, ${failed} failed` `` without a failure list.
- After every action: drop the affected IDs from the selection, reload the list, `useTrash().refresh()`. One action at a time (ref guard as in `AssetFilesTab`).

- [ ] **Step 1: Failing tests:**
  - `dialog-menu-tabs.test.tsx`: `ConfirmDialog focuses Cancel, confirms, cancels on Esc and disables both buttons while busy`.
  - `file-browser.test.tsx`: `the trash table shows the deletion date and the origin` (one file from an asset named `Hero`, one from the inbox → `Inbox`), `the trash scope has no role filter, no Proposals toggle and no Analyse all`.
  - `file-dialog.test.tsx`: `a trashed file shows its origin, read-only tags and only Restore and Delete permanently` — no tag input, no role select, no `Open externally`, `Show in folder`, `Analyse`, `Review tags`, `Image to prompt`, `Detach`, `Use as cover`.
  - `trash.test.tsx`: `lists the trash with its count`, `Restore from the menu calls files:restoreMany without asking and reloads`, `Restore for a selection`, `Delete permanently asks with the number of files and purges on confirm`, `cancelling the confirmation sends nothing`, `Empty trash asks with the total and calls trash:empty`, `Empty trash is disabled for an empty trash`, `a partly failing purge shows "1 deleted, 1 failed"`, `the Delete key on a selection opens the confirmation`, `the trash count is refreshed after restore and after purge` (calls to `trash:summary`), `searching the trash sends the query with scope trash`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test trash dialog-menu-tabs file-browser file-dialog` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @assetforge/desktop test` → PASS. `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: add the trash screen with restore and permanent delete`.

---

### Task 10: Renderer — navigation entry with the count (lane C)

**Files:**
- Modify: `R/nav.ts`, `R/components/AppShell.tsx`, `R/components/WorkspaceShell.tsx`
- Test: `T/shell.test.tsx`

**Interfaces:**
- Consumes: Tasks 8 and 9.
- Produces: `View` gains `{ name: 'trash' }`; `Section` gains `'trash'`; the `NAV` entry `{ section: 'trash', label: TRASH_LABEL, icon: Trash2 }` directly after Inbox; `AppShell` gains the optional prop `trashCount?: number | null` — a count above 0 is shown as the entry's badge with `aria-label` `trashNavLabel(count)`, the Jobs badge keeps its wording; `WorkspaceShell` wraps its tree in `TrashProvider`, feeds `useTrash().count` to the shell, keeps `trashList: TrashListState` in `ShellState` and renders `TrashScreen` for the view.

- [ ] **Step 1: Failing tests** in `shell.test.tsx`: `Trash follows Inbox in the navigation`, `the trash entry shows its count and names it "Trash, 3 files"`, `no badge for an empty trash`, `navigating to Trash renders the trash screen`, `the trash filters survive leaving and returning`, `deleting a file in the inbox raises the count in the navigation` (WorkspaceShell with the fake API: `trash:summary` answers 0, then 1 after `files:trashMany`).
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test shell` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @assetforge/desktop test` → PASS. `pnpm typecheck`, `pnpm --filter @assetforge/desktop build`.
- [ ] **Step 5: Commit** `feat: add the trash to the navigation with its count`.
