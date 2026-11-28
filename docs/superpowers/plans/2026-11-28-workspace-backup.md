# Workspace backup and restore — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Read "Controller rulings" at the end first: they override the text above them.

**Goal:** Write consistent copies of each workspace database to a place that survives the loss of the user profile, and restore a workspace from such a copy.

**Architecture:**
- Persistence makes the snapshot. It runs an online backup in small steps into a local temp file, then checks it in a worker thread. It also owns the change counter, the lineage and the side-file-aware swap.
- Core owns the backup service inside `WorkspaceManager` (triggers, close guard, final backup, retention, the missing-database answer, restore as a queue step). It reaches the disk only through the new ports.
- Desktop main resolves and validates the location, stream-copies to and from the target and maps backups to opaque ids. The renderer shows the restore dialog, the settings section and the banner line.

**Tech stack:** TypeScript, better-sqlite3 13.2.0 (`Database#backup` with `progress`), `node:worker_threads`, Node streams, Drizzle migrations, Zod, Electron `dialog`, React + Vitest/jsdom.

**Spec:** `docs/superpowers/specs/2026-11-28-workspace-backup-design.md`

## Global Constraints

Spec values (verbatim):

**Places**
- Default place `<workspace root>/.assetforge/backups/`.
- Chosen place `<chosen>/assetforge-backups/<workspace id>/`, with `backup-info.json` (`{ v: 1, id, name }`) beside the copies.
- The choice is stored per workspace in the registry `userData/settings.json`.
- Refused with `validation_failed`: a directory inside any workspace root other than the default place, inside `userData`, or one that cannot be written.

**Copies**
- Name: `assetforge-<lineage short id>-<yyyymmddThhmmssZ>-m<applied migrations>.sqlite`.
- Written as `.tmp`, then renamed. SQLite never opens a file at the target.
- One backup at a time per workspace. Free space is checked before the copy (`backup_no_space`).

**When**
- On close, switch and quit when the database changed.
- At most once per hour while open, only when it changed.
- `Back up now`.
- A final backup before a remove, from the closed file without opening or migrating it. If it fails, the remove is refused and a second native dialog offers `Remove anyway`.
- Quit backup capped at **30 s**. Shutdown takes at most that cap plus the scheduler deadline.

**Retention**
- Per lineage: newest **5** plus the newest of each of the last **7** days.
- Never the one just written; never another lineage.
- Pre-migration copies are unchanged (newest 3). Replaced databases: newest **2**.

**Failure codes and messages**
- Codes `backup_location_unreachable`, `backup_no_space`, `backup_failed`.
- The banner line reads `The last backup failed: <reason>`, with `Settings`.
- `Load the backups again` (stale id); `The database update failed. Nothing was changed`.

**Channels and UI**
- New error code `workspace_database_missing`.
- `workspace:backups` answers `{ backupId, createdAt, sizeBytes, appliedMigrations, origin: 'pre_migration' | 'regular', sameLineage }[]`, newest first.
- The restore dialog has `Restore`, `Choose folder…` and `Start empty`.
- The workspace list menu has `Restore backup…`.
- Settings has a Backup section: `Workspace folder`, `Change…`, `Reset`, `Back up now`, and `Delete` for other-lineage copies.

Repository rules:
- No path, file name or URL in a log line or in a renderer error. Backup errors are fixed messages without a cause.
- Log only through `logLine`/`errorLogLine` (`packages/core/src/log-line.ts`) and `describeError` (`packages/core/src/error-description.ts`).
- No explanatory text in the UI, only tooltips.
- Buttons only use the `ui.ts` constants. Every label lives in `apps/desktop/src/renderer/src/labels/`.
- A doc comment with `@param`/`@returns` on every function, written out names, and the `docs/code-style.md` guides (40 lines per function, 300 per file, `index.ts` only re-exports, no nested async function).
- `pnpm lint` ends with 0 errors, and `pnpm format` has been run before every commit.
- Tests never touch the network and never open a native dialog: `Dialogs` and pickers are fakes.
- Lane C keeps its edits to `app-shutdown.ts` and `index.ts` minimal. The log-file lane edits `main-log.ts` and the quit path first. Rebase on it and add no lines to `main-log.ts`, because core writes the backup log lines through `host.log`.

## Review Focus

1. **Retention edge cases** are tested in B2: another lineage, the copy just written, UTC midnight, a clock set back (future stamps), equal stamps, names that do not parse, `.tmp` files.
2. **A bad backup never replaces a database.** A damaged, foreign, newer or unreadable backup leaves the current database untouched. A swap that fails halfway leaves the original or the `replaced-` copy intact, side files included. Tested in A4 (swap, worker facts) and B3 (decisions).
3. **Close and quit timing** is tested in B1 and C4:
   - a backup in flight when the close comes
   - a timer that fires after close or switch
   - a deadline that aborts and removes the temp file
   - the shutdown total staying within 30 s plus the scheduler deadline
   - a failed backup never failing close or quit
4. **Path confinement** is tested in C1 and C3:
   - the chosen folder inside a workspace root (also the own root), inside `userData`, given through `..`, case, a junction, or not writable
   - the renderer never sends a path
   - a stale or foreign `backupId`
   - a picked folder that is unreadable
5. **The remove flow** is tested in B4 and C3:
   - the final backup is written before the folder is trashed, from the closed file
   - a failure refuses with the code and nothing is removed
   - `Remove anyway` removes without a backup
   - no database means no backup
   - an open workspace is closed without a second (closing) backup

## Task 0 — Contracts, ports, stubs (one worker, merged before the lanes)

**Files and contents**

`packages/contracts/src/errors.ts`
- Add to `ErrorCodeSchema`: `backup_location_unreachable`, `backup_no_space`, `backup_failed`, `workspace_database_missing`.

`packages/contracts/src/backup.ts` (new)

Constants:
```ts
export const BACKUP_KEEP_NEWEST = 5;
export const BACKUP_KEEP_DAYS = 7;
export const BACKUP_INTERVAL_MS = 3_600_000;
export const BACKUP_QUIT_DEADLINE_MS = 30_000;
export const REPLACED_KEEP_COUNT = 2;
export const BACKUP_FOLDER_NAME = 'assetforge-backups';
export const BACKUP_INFO_FILE = 'backup-info.json';
```

Messages:
```ts
export const BACKUP_FAILURE_CODES = ['backup_location_unreachable', 'backup_no_space', 'backup_failed'] as const;
export type BackupFailureCode = (typeof BACKUP_FAILURE_CODES)[number];
export const BACKUP_MESSAGES: Record<BackupFailureCode, string> = {
  backup_location_unreachable: 'The backup folder cannot be reached',
  backup_no_space: 'There is not enough free space for the backup',
  backup_failed: 'The backup could not be written',
};
export const BACKUP_STALE_MESSAGE = 'Load the backups again';
export const DATABASE_UPDATE_FAILED_MESSAGE = 'The database update failed. Nothing was changed';
export const DATABASE_MISSING_MESSAGE = 'This workspace has no database on this machine';
export const BACKUP_DAMAGED_MESSAGE = 'This backup is damaged';                         // validation_failed
export const BACKUP_FOREIGN_MESSAGE = 'This backup belongs to another workspace';         // workspace_mismatch
export const BACKUP_NEWER_MESSAGE = 'This backup is from a newer version of AssetForge'; // unsupported_format_version
export const BACKUP_UNREADABLE_MESSAGE = 'The backup could not be read';                  // invalid_operation
export const RESTORE_OPEN_MESSAGE = 'Close this workspace before restoring it';           // invalid_operation
export const BACKUP_NOT_DELETABLE_MESSAGE = 'This backup cannot be deleted';              // invalid_operation
export const LOCATION_IN_WORKSPACE_MESSAGE = 'This folder lies inside a workspace';       // validation_failed
export const LOCATION_IN_APP_DATA_MESSAGE = 'This folder lies inside the app data';      // validation_failed
export const LOCATION_NOT_WRITABLE_MESSAGE = 'This folder cannot be written';            // validation_failed
```

Schemas:
- `BackupOriginSchema = z.enum(['pre_migration','regular'])`
- `BackupEntrySchema`: `{ backupId: z.string().uuid(), createdAt: z.string().datetime(), sizeBytes: z.number().int().nonnegative(), appliedMigrations: z.number().int().nonnegative(), origin, sameLineage: z.boolean() }`
- `BackupAttemptSchema`: `{ at: datetime, ok: boolean, code: z.enum(BACKUP_FAILURE_CODES).nullable(), message: z.string().nullable() }`
- `BackupStateSchema`: `{ workspaceId: z.string().uuid().nullable(), running: z.boolean(), last: BackupAttemptSchema.nullable() }`
- `BackupStatusSchema`: `{ location: { kind: z.enum(['workspace','chosen']), path: z.string().nullable() }, reachable: z.boolean(), running, last, count: int, totalBytes: int, otherLineages: z.array(BackupEntrySchema) }`
  - `path` is only for display: the chosen directory, or null for the default place.

`packages/contracts/src/ipc-backup.ts` (new)
- `backup:state` `{}` → `BackupState`. Works without a workspace and then answers `workspaceId: null`.
- `backup:status` `{}` → `BackupStatus` (needs an open workspace).
- `backup:changeLocation` `{}` → `BackupStatus | null` (null when the pick was cancelled).
- `backup:resetLocation` `{}` → `BackupStatus`.
- `backup:now` `{}` → `BackupAttempt`.
- `backup:delete` `{ backupId: uuid }` → `BackupStatus`.

`packages/contracts/src/ipc-workspace.ts`
- `workspace:open` gains `startEmpty: z.boolean().optional()`.
- `workspace:backups`: `z.union([{ id: IdSchema }, { rootPath: string.min(1) }])` merged with `{ pickFolder: z.boolean().optional() }`, answering `BackupEntry[]`.
- `workspace:restore` `{ rootPath, backupId: uuid }` → `WorkspaceSummary`.
- Both new channels work without an open workspace.

`packages/contracts/src/ipc.ts`
- Merge `backupChannels`, and re-export from the contracts `index.ts`.

`apps/desktop/src/preload/channels.ts`
- Add the eight new channels to `KNOWN_CHANNELS`, in alphabetical order.

`packages/core/src/errors.ts`
- `BackupError extends AssetForgeError`, constructed as `new BackupError(code: BackupFailureCode, { cause? })`. The message is always `BACKUP_MESSAGES[code]`.
- `WorkspaceDatabaseMissingError`: code `workspace_database_missing`, message `DATABASE_MISSING_MESSAGE`.
- `DatabaseUpdateFailedError`: code `invalid_operation`, message `DATABASE_UPDATE_FAILED_MESSAGE`.

`packages/core/src/backup-names.ts` (new)
```ts
export const LINEAGE_SHORT_LENGTH = 12;
export const BACKUP_NAME_PATTERN = /^assetforge-([0-9a-f]{12})-(\d{8}T\d{6}Z)-m(\d{1,4})\.sqlite$/;
export const BACKUP_TEMPORARY_PATTERN = /^assetforge-[0-9a-f]{12}-\d{8}T\d{6}Z-m\d{1,4}\.sqlite\.tmp$/;
export function backupFileName(lineageId: string, at: Date, appliedMigrations: number): string;
export interface ParsedBackupName { name: string; lineageShortId: string; stamp: string; createdAt: string; appliedMigrations: number }
export function parseBackupName(name: string): ParsedBackupName | null; // null also for an impossible date such as 20261332T…
export function lineageShortId(lineageId: string): string;              // first 12 characters, lower case
```

`packages/core/src/ports/workspace-database.ts`
- `WorkspaceMeta.lineageId: string`.
- `WorkspaceMetaRepository.init(meta: Omit<WorkspaceMeta,'lineageId'>)`: persistence draws the lineage.
- `WorkspaceDatabase.changeCount(): number`
- `WorkspaceDatabase.snapshot(options: { signal: AbortSignal }): Promise<DatabaseSnapshot>`

`packages/core/src/ports/workspace-backups.ts` (new)
```ts
export interface SnapshotFacts { workspaceId: string; lineageId: string | null; formatVersion: number; appliedMigrations: number; newerThanApp: boolean }
export interface DatabaseSnapshot extends SnapshotFacts { path: string; sizeBytes: number; changeCount: number; discard(): Promise<void> } // lineageId non-null on a snapshot
export interface BackupLocation { kind: 'workspace' | 'chosen'; directory: string; chosenPath: string | null }
export interface BackupFileInfo { name: string; sizeBytes: number; modifiedAt: string }
export interface LocalBackupFile { name: string; sizeBytes: number; createdAt: string; appliedMigrations: number }
export interface BackupSource { origin: 'pre_migration' | 'regular'; directory: string | null; name: string } // directory null = the local database directory
export interface StagedRestore { facts: SnapshotFacts | null; install(): Promise<void>; discard(): Promise<void> } // facts null = unreadable as a database or quick_check not ok
export interface WorkspaceBackups {
  snapshotClosed(workspaceId: string, signal: AbortSignal): Promise<DatabaseSnapshot>;   // A
  localLineage(workspaceId: string): Promise<string | null>;                            // A
  listLocal(workspaceId: string): Promise<LocalBackupFile[]>;                           // A, pre-migration copies
  stageRestore(workspaceId: string, source: BackupSource, signal: AbortSignal): Promise<StagedRestore>; // A, uses copyIn from C
  locationOf(workspace: { id: string; name: string; rootPath: string }): Promise<BackupLocation>;     // C
  write(snapshot: DatabaseSnapshot, location: BackupLocation, fileName: string, signal: AbortSignal): Promise<void>; // C, throws BackupError
  list(directory: string): Promise<BackupFileInfo[]>;                                    // C, throws BackupError('backup_location_unreachable')
  remove(directory: string, name: string): Promise<void>;                                // C, refuses names outside BACKUP_NAME_PATTERN
}
export interface BackupTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
```

`packages/core/src/ports/workspace-host.ts`
- Add `backups: WorkspaceBackups`, `databaseExists(workspaceId: string): Promise<boolean>` and `timers?: BackupTimers`.

`packages/core/src/backup-types.ts` (new)
```ts
export interface ListedBackup { source: BackupSource; createdAt: string; sizeBytes: number; appliedMigrations: number; origin: 'pre_migration' | 'regular'; sameLineage: boolean }
export interface BackupFolderStatus { location: BackupLocation; reachable: boolean; running: boolean; last: BackupAttempt | null; count: number; totalBytes: number; otherLineages: ListedBackup[] }
```
- `BackupAttempt` and `BackupState` are imported from contracts.

`packages/core/src/workspace-manager.ts`

Final signatures with stub bodies that throw `InvalidOperationError('Not implemented')` where they are new:
```ts
open(request: { rootPath: string; startEmpty?: boolean }): Promise<WorkspaceSummary>;
close(options?: { backupDeadlineMs?: number }): Promise<void>;
remove(request: { id: string; trashFolder: boolean; skipFinalBackup?: boolean }): Promise<{ folderTrashed: boolean }>;
listBackups(request: { workspace: { id: string } | { rootPath: string }; extraDirectory: string | null }): Promise<ListedBackup[]>;
restore(request: { rootPath: string; source: BackupSource }): Promise<WorkspaceSummary>;
backupNow(): Promise<BackupAttempt>;
backupState(): BackupState;
backupStatus(): Promise<BackupFolderStatus>;
deleteBackup(source: BackupSource): Promise<void>;
```
- Existing behaviour of `open`, `close` and `remove` is unchanged in Task 0.

`packages/core/src/index.ts`
- Re-export the new files.

`packages/core/test/fakes.ts`
- `FakeWorkspaceBackups implements WorkspaceBackups`, in memory. It records calls and has settable failures and a `writeDelay` gate.
- Fake `changeCount` and `snapshot` on the in-memory database, and `databaseExists` (default true) on the fake host.

`packages/persistence/src/open-database.ts`
- Stub `changeCount()` (`total_changes()`), and a `snapshot` that throws.
- `getMeta` answers `lineageId: ''` until A1 adds the column. `init` keeps its current body.

`apps/desktop/src/main/host-actions.ts`
- `Dialogs.confirmRemoveWithoutBackup(workspace: WorkspaceSummary, message: string): Promise<boolean>`.
- Every test fake of `Dialogs` (`grep confirmRemoveWorkspace apps/desktop/test`) gets `async () => false`.
- `apps/desktop/src/main/electron-dialogs.ts` gets a stub that answers false.

`apps/desktop/src/main/composition.ts`
- `backups`: a stub whose methods throw `BackupError('backup_failed')`.
- `databaseExists: true` until C2.

`apps/desktop/test/renderer/fake-api.ts`
- Default handlers for the new channels: an empty list, and state `{ workspaceId: null, running: false, last: null }`.

**Plan decision:** `WorkspaceMeta.lineageId` is drawn in persistence (`init` takes the meta without it). Reason: the lineage is a database fact, and `claimDatabase` stays unchanged.

**Plan decision:** Task 0 does not write migration 0021. Reason: the schema, the journal and the snapshot belong together in lane A, and the stub keeps every lane compiling.

**Tests (Task 0)**
- `packages/contracts/test/backup.test.ts`:
  - `BackupEntrySchema refuses a path-like backupId` (a non-uuid fails)
  - `workspace:backups accepts id or rootPath, not neither`
  - `every backup failure code is in ErrorCodeSchema`
- `packages/core/test/backup-names.test.ts`:
  - `backupFileName` for lineage `0123456789abcdef…`, `2026-11-28T09:05:03.999Z` and 21 gives `assetforge-0123456789ab-20261128T090503Z-m21.sqlite`
  - `parseBackupName` round-trips and gives `createdAt` `2026-11-28T09:05:03.000Z`
  - null for upper-case hex, for `.tmp`, for month 13 and for a pre-migration name `assetforge.sqlite.backup-3-20261128090503`
- `apps/desktop/test/preload.test.ts` (existing) stays green, because it pins `KNOWN_CHANNELS` against the contract.

**Command:** `pnpm typecheck && pnpm test && pnpm lint && pnpm format`
**Commit:** `Add workspace backup contracts, ports and stubs`, then push and merge to main.

## Lane A — Persistence

Owned files:
- `packages/persistence/migrations/0021_workspace_lineage.sql`
- `migrations/meta/_journal.json`
- `migrations/meta/0021_snapshot.json`
- `src/schema/workspace.ts`
- `src/meta-repository.ts`
- `src/open-database.ts`
- `src/migrate-with-backup.ts`
- `src/migration-state.ts`
- `src/database-backup.ts`
- `src/database-snapshot.ts` (new)
- `src/backup-check.ts` (new)
- `src/backup-check-worker.ts` (new)
- `src/database-swap.ts` (new)
- `src/database-backups.ts` (new)
- `src/index.ts`
- `package.json`
- `vitest.config.ts`
- `test/global-setup.ts` (new)
- tests

### A1 — Lineage migration and change counter

**Schema:** `workspace.lineage_id text` (nullable in SQL).

**Migration 0021**, written by hand. Use `db:generate` for the snapshot and journal, then cut the SQL down to:
```sql
ALTER TABLE `workspace` ADD `lineage_id` text;--> statement-breakpoint
UPDATE `workspace` SET `lineage_id` = lower(hex(randomblob(16))) WHERE `lineage_id` IS NULL;
```

**Meta repository**
- `initMeta` writes `randomBytes(16).toString('hex')`.
- `getMeta` returns `lineageId`. A null (impossible after 0021) reads as `''` and is never written.

**`changeCount()`:** `sqlite.prepare('select total_changes() as n').get().n`.

**Tests**
- `test/migration-0021.test.ts`:
  - `existing workspace row gets a 32-hex lineage`
  - `two databases get different lineages`
  - `a fresh database gets one through init`
- `test/database.test.ts`:
  - `changeCount grows with a write and not with a read`

### A2 — Failed migration message

**`migrate-with-backup.ts`:** wrap `migrate(...)` and rethrow as `new DatabaseUpdateFailedError({ cause })`. The backup-refusal path is unchanged.

**`migration-state.ts`:** `readMigrationState` additionally answers `newerThanApp: boolean`. It is true when the newest applied `created_at` is greater than the newest journal `when`.

**Tests**
- `test/database-backup.test.ts`:
  - `a failing migration answers DatabaseUpdateFailedError and leaves the file unchanged`: use a migrations folder with a broken 0001, and compare checksums before and after.
- `test/migration-state.test.ts` (existing file or new):
  - `newerThanApp is true for a database migrated by a longer journal`

### A3 — Snapshot of the open and of a closed database, check in a worker

**`database-snapshot.ts`**
```ts
export const SNAPSHOT_STEP_PAGES = 100;
export function snapshotTemporaryName(): string;  // `assetforge.sqlite.snapshot-<uuid>.tmp`
export function restoreTemporaryName(): string;   // `assetforge.sqlite.restore-<uuid>.tmp`
export const LOCAL_TEMPORARY_PATTERN: RegExp;     // ^assetforge\.sqlite\.(snapshot|restore)-[0-9a-f-]{36}\.tmp(-journal|-wal|-shm)?$
export async function sweepLocalTemporary(databaseDirectory: string): Promise<void>; // best effort
export async function snapshotOpenDatabase(sqlite: Database.Database, databaseFilePath: string, check: BackupChecker, signal: AbortSignal): Promise<DatabaseSnapshot>;
export async function snapshotClosedDatabase(databaseFilePath: string, check: BackupChecker, signal: AbortSignal): Promise<DatabaseSnapshot>;
```

`snapshotOpenDatabase`:
1. Read `changeCount` before the backup starts.
2. Run `sqlite.backup(temp, { progress: () => { if (signal.aborted) throw abortError; return SNAPSHOT_STEP_PAGES; } })`.
3. Run `check(temp)`. Facts that are null, or a lineage that is null, throw `BackupError('backup_failed')`.
4. Every failure removes the temp file with its side files.

`snapshotClosedDatabase`:
- No connection to the live file. It copies `assetforge.sqlite` and, when present, `-wal` to `temp` and `temp-wal` with `copyFile`, then runs `check(temp)`. The worker's open folds the WAL in.
- A missing file throws `BackupError('backup_failed')`.
- `changeCount` is 0.

**Plan decision:** the closed snapshot is a file copy plus a worker check, not an online backup. Reason: the spec says "without opening", and no other connection can exist after the close.

**`backup-check.ts`**
```ts
export type BackupChecker = (path: string) => Promise<SnapshotFacts | null>;
export function createBackupChecker(options: { workerUrl: URL; migrationsFolder: string; timeoutMs?: number }): BackupChecker;
```
- One worker per call. It is terminated after the answer, after the timeout (default 120 000 ms, then null) or on an error (null).

**`backup-check-worker.ts`:** opens the path read-write, then:
1. `PRAGMA journal_mode = DELETE` (folds in and removes the WAL)
2. `PRAGMA quick_check`, which must be exactly one row `ok`
3. reads `workspace` (`id`, `format_version`, `lineage_id`; a missing column is null)
4. reads `readMigrationState`
5. closes the database and posts the facts

Any throw posts null.

**Size:** `sizeBytes` comes from `stat` after the check.

**Test wiring**
- `package.json` devDependency `esbuild` at media's version.
- `test/global-setup.ts` builds the worker into `.test-build/backup-check-worker.mjs`, as in `packages/media/test/global-setup.ts`.
- `vitest.config.ts` gets `globalSetup`.

**Tests**
- `test/database-snapshot.test.ts`:
  - `snapshot of an open database while writes go on holds a consistent row count`: interleave inserts between steps with a tiny database.
  - `aborted snapshot leaves no temp file`
  - `closed snapshot includes rows still in the WAL`
  - `the live file and its -wal are unchanged by a closed snapshot`: compare checksums.
  - `snapshot facts carry id, lineage and applied count`
- `test/backup-check.test.ts`:
  - `a truncated file answers null`
  - `a non-SQLite file answers null`
  - `a database without lineage_id answers lineageId null`
  - `a newer journal state answers newerThanApp`

### A4 — Local backups, restore staging and swap

**`database-swap.ts`**
```ts
export function replacedName(at: Date): string; // `assetforge.sqlite.replaced-<yyyymmddThhmmssZ>`
export async function installDatabase(databaseFilePath: string, stagedPath: string, now: Date): Promise<void>;
export async function pruneReplaced(databaseFilePath: string): Promise<void>; // keep REPLACED_KEEP_COUNT newest stamps with side files
```

`installDatabase` is called with no connection open. Its order:
1. Fold the staged copy's mode: it is already in DELETE mode from the check, so no side files.
2. If the live file exists, rename `-wal`, then `-shm`, then the main file to `replaced-<stamp>` plus the suffix. Any failure renames back what was moved and throws `BackupError('backup_failed')`.
3. Rename the staged copy to the live name. A failure renames the replaced files back.
4. Run `pruneReplaced`.

Edge case: equal stamps within one second add the suffix `-2`, `-3` and so on.

**`database-backup.ts`:** export `listPreMigrationBackups(databaseFilePath): Promise<LocalBackupFile[]>`, which parses the existing pattern and reads the stamp as UTC.

**`database-backups.ts`**
```ts
export interface DatabaseBackupsOptions {
  databaseFilePathOf(workspaceId: string): string;
  check: BackupChecker;
  copyIn(source: BackupSource, destinationPath: string, signal: AbortSignal): Promise<void>; // from desktop, used for regular sources
  now?: () => Date;
}
export function createDatabaseBackups(options: DatabaseBackupsOptions): Pick<WorkspaceBackups, 'snapshotClosed' | 'localLineage' | 'listLocal' | 'stageRestore'>;
```
- `localLineage` opens the file `{ readonly: true, fileMustExist: true }`, reads `lineage_id` and closes it. Any failure gives null.
- `stageRestore` copies the source to `restoreTemporaryName()` in the database directory:
  - a `pre_migration` source with `copyFile`, only when its name matches the pre-migration pattern
  - any other source through `copyIn`
  - a copy failure throws `InvalidOperationError(BACKUP_UNREADABLE_MESSAGE)` and removes the temp file
- It then checks the copy and answers `{ facts, install: () => installDatabase(...), discard }`.

**`open-database.ts`**
- Calls `sweepLocalTemporary(dirname(path))` before the open.
- Wires `snapshot: ({ signal }) => snapshotOpenDatabase(sqlite, path, options.check, signal)`.
- New option `check?: BackupChecker`. Without it, `snapshot` throws `BackupError('backup_failed')`.

**Tests**
- `test/database-swap.test.ts`:
  - `install moves db, -wal and -shm aside under one stamp`
  - `install without a live database just places the copy`
  - `a failing rename of the main file restores -wal and -shm`: inject a rename that throws.
  - `only the newest 2 replaced sets are kept`
  - `replaced files are never matched by the pre-migration or temp patterns`
- `test/database-backups.test.ts`:
  - `stageRestore of a damaged copy answers facts null and leaves the live file untouched`
  - `discard removes the restore temp`
  - `a pre_migration source with a regular name is refused`
  - `localLineage of a missing file is null`
  - `sweep removes snapshot/restore temps with side files and nothing else`

**Command:** `pnpm --filter @assetforge/persistence test && pnpm typecheck && pnpm lint && pnpm format`
**Commits:** one per task, for example `Add database lineage and change counter`, then push.

## Lane B — Core

Owned files:
- `packages/core/src/workspace-backup.ts` (new)
- `src/backup-retention.ts` (new)
- `src/workspace-restore.ts` (new)
- `src/backup-listing.ts` (new)
- `src/workspace-manager.ts`
- `src/workspace-open.ts`
- `src/index.ts`
- `test/fakes.ts`
- `test/workspace-backup.test.ts`
- `test/backup-retention.test.ts`
- `test/workspace-restore.test.ts`
- `test/workspace-lifecycle.test.ts`

### B1 — Backup service, triggers and close guard

**`workspace-backup.ts`:** private class `WorkspaceBackupService`, owned by `WorkspaceManager`.
```ts
constructor(host: WorkspaceHost);
startSession(session: { summary: WorkspaceSummary; database: WorkspaceDatabase; hasSameLineageBackup: boolean }): void;
backupNow(): Promise<BackupAttempt>;                         // runs even if unchanged; joins a running one, then starts its own
endSession(options: { backupDeadlineMs?: number; skip?: boolean }): Promise<void>; // never rejects
finalBackup(summary: WorkspaceSummary, signal: AbortSignal): Promise<void>;          // throws BackupError
state(): BackupState;
lastAttempt(workspaceId: string): BackupAttempt | null;
```

Rules:
- **Baseline:** set at `startSession` to `database.changeCount()`, read by the caller after `prepareWorkspace`.
- **Changed:** `changeCount() !== baseline`, or no successful backup yet in this session and `hasSameLineageBackup` false (see Q1).
- **One at a time:** `inFlight: Promise<void> | null`. A second trigger awaits it, and runs again only if still changed.
- **Timer:** armed `BACKUP_INTERVAL_MS` after the session starts and after every attempt, through `host.timers ?? globalTimers`.
  - The callback checks that the session object is still the current one. If not, it does nothing.
  - It is cleared in `endSession` before anything else.
- **`endSession`:**
  1. Clear the timer.
  2. Await `inFlight`.
  3. If changed and not `skip`, run one backup with an `AbortController` that fires after `backupDeadlineMs`, when given.
  4. Swallow every error, after recording it.
- **One attempt:**
  1. `location = host.backups.locationOf(summary)`
  2. `snapshot = database.snapshot({ signal })`
  3. `name = backupFileName(snapshot.lineageId, now(), snapshot.appliedMigrations)`
  4. `host.backups.write(...)`
  5. prune: `host.backups.list(location.directory)`, then `pruneSelection(...)`, then `remove` for each. A failing list or remove is ignored.
  6. `snapshot.discard()` in `finally`
  7. On success, `baseline = snapshot.changeCount`.
- **Recording:** `lastAttempt` is kept in a `Map` by workspace id. It survives the session.
- **Failure code:** a `BackupError` keeps its code; anything else becomes `backup_failed`. An abort is `backup_failed`.
- **Log line on failure:** `errorLogLine('Backup failed', { workspace: id, code }, error)`.
- **`finalBackup`:** the same steps with `host.backups.snapshotClosed`. It throws the `BackupError` instead of recording it, but records the attempt too.

**Manager wiring**
- `doOpen` calls `startSession` after `openWorkspaceDatabase`.
- `hasSameLineageBackup` comes from a best-effort `host.backups.list(location.directory)` that checks for the short id. Any failure counts as true, so no extra backup is forced.
- `doClose(options)` calls `endSession(options)` before `database.close()`.
- `close(options)` passes `backupDeadlineMs`. A switch (`open` while one is open) and a plain close pass `BACKUP_QUIT_DEADLINE_MS` too (see Q4).

**Plan decision:** scheduled and on-demand backups run outside the `SerialQueue`, tracked as `inFlight`. Reason: a NAS copy must not block imports, and `doClose` inside the queue can await it without a deadlock.

**Tests** (`test/workspace-backup.test.ts`, fake timers, `FakeWorkspaceBackups`):
- `close after a change writes one backup named with lineage, UTC stamp and m<count>`
- `close after only reads writes none`
- `hourly timer writes only when changed and re-arms`
- `timer firing after close or switch touches nothing`: check the fake's call log.
- `a close during a running backup waits for it and then writes the closing one only if changed since`
- `backupNow while one runs joins it, then runs its own`
- `deadline aborts the snapshot or write, discard is called, close resolves`
- `a failing write never fails close; lastAttempt carries code and fixed message; one log line with workspace and code but no path`
- `non-BackupError becomes backup_failed`
- `first open with no same-lineage backup counts as changed`

### B2 — Retention

**`backup-retention.ts`**
```ts
export function pruneSelection(names: readonly string[], lineageId: string, justWritten: string, now: Date): string[]; // names to delete
```

Rule (exact):
- **Considered:** `parseBackupName(name) !== null` and `lineageShortId === lineageShortId(lineageId)`. Everything else is never returned: other lineages, `.tmp` files, `backup-info.json`, pre-migration and replaced names.
- **Order:** stamp descending (string compare of `yyyymmddThhmmssZ` is chronological), then `appliedMigrations` descending, then name descending. This gives a total order, so ties are deterministic.
- **Keep set:** the first `BACKUP_KEEP_NEWEST` (5) of that order, plus, for each UTC calendar date `D` in `today(now)`, `today−1`, …, `today−6` (7 dates, `today` being the `now` UTC date), the first entry in the order whose stamp date equals `D`.
  - Days without a backup keep nothing and do not extend the window.
  - The just-written name is always kept, even if a clock set back made it older than 5 others. It then still counts among the newest 5 only if it is in them by order.
- **Future stamps** (later than `now`) take newest-5 slots but match no day.
- **Result:** the considered names minus the keep set minus `justWritten`. At most 12 are kept.

**Tests** (`test/backup-retention.test.ts`):
- `keeps the newest 5 of 20 within one day`
- `keeps one per day for the last 7 UTC days, the newest of each`
- `a backup at 23:59:59Z and one at 00:00:00Z fall on different days`
- `day 8 back is pruned unless among the newest 5`
- `another lineage, tmp, info file and pre-migration names are never selected`
- `just written survives when its stamp is older than all others`
- `equal stamps: higher m wins, then name`
- `empty or single list selects nothing`

### B3 — Missing database, listing and restore

**`workspace-open.ts`**
- `openWorkspaceDatabase(host, storage, manifest, rootPath, options: { startEmpty: boolean })`.
- Before `host.openDatabase`, `if (!startEmpty && !(await host.databaseExists(manifest.id))) throw new WorkspaceDatabaseMissingError()`.
- It runs after `rejectCopy`. `doCreate` passes `startEmpty: true`.

**`backup-listing.ts`**
```ts
export async function listWorkspaceBackups(host: WorkspaceHost, workspace: { id: string; name: string; rootPath: string }, extraDirectory: string | null, liveLineage: string | null): Promise<ListedBackup[]>;
```
- **Sources:**
  - `host.backups.listLocal(id)` gives `pre_migration` entries with `directory: null`.
  - `list(locationOf(...).directory)` gives `regular` entries.
  - With `extraDirectory`, also `list(extra)` and `list(join(extra, BACKUP_FOLDER_NAME, id))`.
- **Any source that throws contributes nothing.**
- **Regular names:** only parseable names. Entries are unique by `directory + name`.
- **`sameLineage`:**
  - regular: `liveLineage !== null && shortId === lineageShortId(liveLineage)`
  - `pre_migration`: `liveLineage !== null`
- **Order:** `createdAt` descending, then `appliedMigrations` descending.

**Plan decision:** the lineage of a closed live database is read through a read-only open (`localLineage`), not stored in the registry. Reason: there is one source of truth, and the meta row is small.

**`workspace-restore.ts`**
```ts
export async function stageCheckedRestore(host: WorkspaceHost, manifest: WorkspaceManifest, source: BackupSource, signal: AbortSignal): Promise<StagedRestore>;
```
Checks in this order:
1. facts null gives `ValidationFailedError(BACKUP_DAMAGED_MESSAGE)`
2. `workspaceId !== manifest.id` gives `WorkspaceMismatchError(BACKUP_FOREIGN_MESSAGE)`
3. `formatVersion > WORKSPACE_FORMAT_VERSION || newerThanApp` gives `UnsupportedFormatVersionError(BACKUP_NEWER_MESSAGE)`

Every refusal calls `discard()` before throwing.

**Manager**
- `listBackups`:
  - `{ id }` resolves through `registry.get` (`WorkspaceNotFoundError` if absent).
  - `{ rootPath }` resolves through `requireReachable` and `readManifest`.
  - `liveLineage`: the open session's lineage if this workspace is open; else `databaseExists ? localLineage : null`.
  - Runs outside the queue.
- `restore` runs in the queue:
  1. Refused with `RESTORE_OPEN_MESSAGE` when `rootPath` is the open workspace.
  2. Otherwise `doClose()` (with its closing backup) for another open one.
  3. `createStorage`, `requireReachable`, `readManifest`, `rejectCopy`.
  4. `stageCheckedRestore`.
  5. `staged.install()`.
  6. `openWorkspaceDatabase(..., { startEmpty: true })`.
  7. `startSession` with `hasSameLineageBackup: true`, so the restored state is not copied at once.
- `open({ rootPath, startEmpty })`: `startEmpty` passes through.

**Tests** (`test/workspace-restore.test.ts`):
- `open of a folder without its database answers workspace_database_missing and writes nothing`: no `openDatabase` call, no registry upsert.
- `open with startEmpty creates the database as before`
- `create is unchanged`
- `rejectCopy still wins over the missing database`
- `damaged, foreign and newer backups are refused with their codes and messages, discard called, install never called`
- `restore installs, then opens, migrates and recovers; summary returned`
- `restore of the open workspace is refused`
- `restore while another workspace is open closes it first`
- `listing merges local, location and picked folder (both shapes), drops unreadable places, newest first, sameLineage per rule`
- `with the database missing every entry has sameLineage false`

### B4 — Final backup on remove, status and delete

- **`doRemove(id, trashFolder, skipFinalBackup)`:**
  1. If open, `doClose({ skip: true })`.
  2. If `!skipFinalBackup && await host.databaseExists(id)`, run `finalBackup(summary, signal)` with no deadline. It throws `BackupError`, and the registry, the database and the folder stay untouched.
  3. Then trash, `deleteDatabase` and `registry.remove`, as today.
- **`backupStatus()`:**
  - Needs a session.
  - `location` from `locationOf`.
  - `list` failure gives `reachable: false`, `count: 0`, `totalBytes: 0`, `otherLineages: []`.
  - `count` and `totalBytes` cover same-lineage regular copies only.
  - `otherLineages` holds the parseable other-lineage entries as `ListedBackup`.
- **`deleteBackup(source)`:** allowed only when:
  - `origin === 'regular'`
  - `source.directory` is the current location directory
  - the name parses
  - the lineage is not the session's

  Otherwise it answers `InvalidOperationError(BACKUP_NOT_DELETABLE_MESSAGE)`. It runs `host.backups.remove`.
- **`backupNow`/`backupState`** delegate to the service. `backupNow` without a session answers `NoWorkspaceOpenError`.

**Tests** (`test/workspace-lifecycle.test.ts`, extended):
- `remove writes the final backup from the closed file before moveToTrash`: check the order in a shared call log.
- `a failed final backup refuses the remove with its code; registry, database and folder untouched`
- `skipFinalBackup removes without a backup`
- `no database means no backup and the remove goes on`
- `removing the open workspace closes it without a closing backup and writes exactly one final backup`
- `deleteBackup refuses same lineage, pre_migration and another directory`
- `status counts only same-lineage copies`
- The existing test `kept folder opened again starts empty` becomes `answers workspace_database_missing`.

**Command:** `pnpm --filter @assetforge/core test && pnpm typecheck && pnpm lint && pnpm format`
**Commits:** one per task, then push.

## Lane C — Desktop main

Owned files:
- `apps/desktop/src/main/json-registry.ts`
- `src/main/backup-location.ts` (new)
- `src/main/backup-target.ts` (new)
- `src/main/backup-ids.ts` (new)
- `src/main/backup-handlers.ts` (new)
- `src/main/workspace-handlers.ts`
- `src/main/electron-dialogs.ts`
- `src/main/composition.ts`
- `src/main/app-shutdown.ts`
- `src/main/index.ts`
- `apps/desktop/electron.vite.config.ts`
- tests under `apps/desktop/test/` except `renderer/`

### C1 — Location: registry key, resolution, validation

**`json-registry.ts`**
- `backupDirectory(id: string): Promise<string | null>`
- `setBackupDirectory(id: string, directory: string | null): Promise<void>`
- The value is the entry key `backupDirectory`. It is kept across `upsert` like other entry keys, through the serial queue and the atomic write.

**`backup-location.ts`**
```ts
export function resolveLocation(workspace: { id: string; rootPath: string }, chosen: string | null): BackupLocation;
export async function validateChosenDirectory(candidate: string, context: { workspaceRoots: readonly string[]; userDataPath: string }): Promise<void>;
```
- `resolveLocation`:
  - default place `join(rootPath, '.assetforge', 'backups')`, `kind: 'workspace'`
  - chosen place `join(chosen, BACKUP_FOLDER_NAME, id)`, `kind: 'chosen'`, `chosenPath: chosen`
- `validateChosenDirectory`:
  1. `realpath` of the candidate (a missing path gives `LOCATION_NOT_WRITABLE_MESSAGE`).
  2. Compare with `realpath` of each root and of `userData`, case-insensitively on win32 and by path segments (`isSameOrInside`).
  3. Inside a root, the root itself included, gives `LOCATION_IN_WORKSPACE_MESSAGE`. Inside `userData` gives `LOCATION_IN_APP_DATA_MESSAGE`.
  4. Write and remove a probe file `.assetforge-probe-<uuid>`. A failure gives `LOCATION_NOT_WRITABLE_MESSAGE`.

  All of these are `ValidationFailedError`.

**Plan decision:** the own root counts as "a workspace root" too, so the chosen place is never inside the workspace. Reason: the default place already covers that case, and `Reset` returns to it.

**Tests** (`test/backup-location.test.ts`, temp directories):
- `refuses own root, a subfolder of another root, userData and a path written with .. into a root`
- `refuses case-changed root on win32`
- `refuses a junction into a root` (only on win32, junction through `fs.symlink(..., 'junction')`)
- `refuses an unwritable or missing folder`
- `accepts a sibling folder`
- `resolveLocation gives both shapes`
- `registry keeps backupDirectory across upsert and drops it on remove`

### C2 — Target copy, listing, wiring

**`backup-target.ts`**
```ts
export function createBackupTarget(options: { registry: JsonWorkspaceRegistry; freeBytes?: (directory: string) => Promise<number | null> }): Pick<WorkspaceBackups, 'locationOf' | 'write' | 'list' | 'remove'> & { copyIn: DatabaseBackupsOptions['copyIn'] };
```
- **`write` errors:**
  - root or chosen folder not reachable (`stat` of `rootPath` or `chosenPath` fails) gives `backup_location_unreachable`
  - `freeBytes < snapshot.sizeBytes` gives `backup_no_space` (null means not measurable, so it goes on)
  - any other failure gives `backup_failed`
- **`write` steps:**
  1. `mkdir -p` the directory.
  2. Remove names matching `BACKUP_TEMPORARY_PATTERN` (best effort).
  3. For `chosen`, write `backup-info.json` `{ v: 1, id, name }` when it is missing or different.
  4. `pipeline(createReadStream(snapshot.path), createWriteStream(final + '.tmp'), { signal })`, then `rename` over `final`.
  5. Remove the `.tmp` on any failure.
- **`list`:** `readdir` with file types, regular files only, `stat` size and mtime. A failure gives `BackupError('backup_location_unreachable')`.
- **`remove`:** refuses with `BackupError('backup_failed')` a name that does not match `BACKUP_NAME_PATTERN` or contains a separator.
- **`copyIn`:** a stream copy of `join(source.directory, source.name)` to the destination path. It requires `parseBackupName(source.name)`.
- **`freeBytes` default:** `statfs` of the nearest existing ancestor.

**`composition.ts`**
- `backups = { ...createBackupTarget(...), ...createDatabaseBackups({ databaseFilePathOf, check: createBackupChecker({ workerUrl, migrationsFolder }), copyIn }) }`
- `databaseExists`: `stat` of the database file.
- `openDatabase` passes `check`.
- New `CompositionOptions.backupWorkerUrl: URL`.
- Export `sweepAllLocalTemporary(userDataPath)` for the app start, best effort, over `userData/workspaces/*`.

**`electron.vite.config.ts`:** add a main input `'backup-check-worker': resolve('../../packages/persistence/src/backup-check-worker.ts')`, beside `preview-worker`.

**`index.ts`:** passes `new URL('./backup-check-worker.js', import.meta.url)` and calls `sweepAllLocalTemporary` inside `whenReady`.

**Tests** (`test/backup-target.test.ts`):
- `write streams to .tmp and renames; no file opened by SQLite at the target`: the target has no `-wal`/`-shm`/`-journal` afterwards.
- `free space below size answers backup_no_space and writes nothing`
- `missing chosen folder answers backup_location_unreachable`
- `abort removes the .tmp`
- `stale .tmp of the pattern is swept, other files untouched`
- `backup-info.json written once for a chosen place, never for the default place`
- `remove refuses ../x and a non-pattern name`
- `copyIn refuses a non-pattern name`

### C3 — Handlers and opaque ids

**`backup-ids.ts`**
```ts
export class BackupIdTable {
  issue(workspaceId: string, backups: readonly ListedBackup[]): BackupEntry[]; // new uuids; drops every earlier id of that workspace
  resolve(workspaceId: string, backupId: string): BackupSource;               // throws InvalidOperationError(BACKUP_STALE_MESSAGE)
}
```
- An id of another workspace counts as stale.

**`workspace-handlers.ts`**
- `workspace:open`: passes `startEmpty`.
- `workspace:backups`:
  1. Resolve the workspace id (from `id`, or the manifest via `manager.listBackups`, which answers the source list; the id table is keyed by the manifest id the manager reports).
  2. With `pickFolder`, call `dialogs.pickDirectory()`. Cancel gives the listing without an extra folder.
  3. Issue the ids.
- `workspace:restore`: `resolve`, then a lifecycle step through `withNotifications`, then `manager.restore`.
- `workspace:remove`:
  1. On a `BackupError` from `manager.remove`, call `dialogs.confirmRemoveWithoutBackup(workspace, error.message)`.
  2. If true, call `manager.remove({ ..., skipFinalBackup: true })`.
  3. If false, answer `{ removed: false, folderTrashed: false }`.

**Plan decision:** declining `Remove anyway` answers "not removed" rather than the error. Reason: the user saw the reason in the native dialog, and a second message would repeat it.

**`backup-handlers.ts`:** `createBackupHandlers(manager, dialogs, registry, ids, userDataPath)` for the six `backup:*` channels.
- `changeLocation`: `pickDirectory`, then `validateChosenDirectory` with the roots of every registry entry, then `setBackupDirectory`, then `status`.
- `delete`: `ids.resolve`, then `manager.deleteBackup`.
- `status`: issues the ids for `otherLineages`.

**`electron-dialogs.ts`:** `confirmRemoveWithoutBackup` is a modal message box with the buttons `Cancel` and `Remove anyway`, default and cancel id 0. Its detail is the fixed message.

**Tests**
- `test/backup-ipc.test.ts`:
  - `backup:changeLocation refuses a folder inside a workspace with validation_failed and stores nothing`
  - `cancelled pick answers null`
  - `stale backupId answers Load the backups again`
  - `an id from another workspace is stale`
  - `backup:delete of a same-lineage copy is refused`
  - `renderer requests with a path field are refused by the contract`
- `test/ipc.test.ts` (existing, extended):
  - `remove with failing final backup asks Remove anyway; true removes, false answers removed false`
  - `workspace:open answers workspace_database_missing`
- Update the existing tests that reopen a kept folder: pass `startEmpty: true` where they relied on the empty catalog.

### C4 — Quit cap

**`app-shutdown.ts`**
- `ShutdownParts.manager` becomes `Pick<WorkspaceManager, 'cancelImport' | 'close'>`.
- It calls `manager.close({ backupDeadlineMs: BACKUP_QUIT_DEADLINE_MS })` after `services.workspaceClosing()`, so the scheduler deadline comes first. That is a one-line change next to the log lane's `flush()`, and nothing else moves.

**Tests** (`test/app-shutdown.test.ts`):
- `close receives the 30 s deadline after the scheduler stop`
- `a backup hanging past the deadline lets closeApp resolve`: fake timers and a manager fake whose close honours the deadline.
- `a failing backup does not reject closeApp`

**Command:** `pnpm --filter @assetforge/desktop test && pnpm typecheck && pnpm lint && pnpm format`
**Commits:** one per task, then push.

## Lane D — Renderer

Owned files under `apps/desktop/src/renderer/src/`:
- `labels/backup.ts` (new)
- `labels.ts`
- `screens/RestoreDialog.tsx` (new)
- `screens/WorkspaceScreen.tsx`
- `screens/WorkspaceTable.tsx`
- `screens/BackupSettings.tsx` (new)
- `screens/SettingsScreen.tsx`
- `components/BackupBanner.tsx` (new)
- `components/AppShell.tsx`
- `components/WorkspaceShell.tsx`
- `hooks/useBackupState.ts` (new)
- `apps/desktop/test/renderer/fake-api.ts`
- new tests in `apps/desktop/test/renderer/`

**Labels** (`labels/backup.ts`):
- `RESTORE_BACKUP_LABEL = 'Restore backup…'`, `RESTORE_LABEL = 'Restore'`, `CHOOSE_FOLDER_LABEL = 'Choose folder…'`, `START_EMPTY_LABEL = 'Start empty'`
- `BACKUP_SECTION_TITLE = 'Backup'`, `WORKSPACE_FOLDER_LABEL = 'Workspace folder'`, `CHANGE_LOCATION_LABEL = 'Change…'`, `RESET_LABEL = 'Reset'`, `BACK_UP_NOW_LABEL = 'Back up now'`, `DELETE_LABEL` (reused from common if present)
- `backupFailedLine(reason) => 'The last backup failed: ' + reason`
- Tooltips for the pre-migration marker, the other-lineage marker and every button
- Confirm titles: `Restore this backup?`, `Start with an empty catalog?`, `Delete this backup?`

### D1 — Restore dialog and workspace list

**`RestoreDialog.tsx`**
```ts
export function RestoreDialog(props: { open: boolean; target: { id: string } | { rootPath: string }; rootPath: string; databaseExists: boolean; onRestored(summary: WorkspaceSummary): void; onClose(): void }): JSX.Element;
```
- **Loading:** loads `workspace:backups` on open. `Choose folder…` calls it again with `pickFolder: true` and replaces the list.
- **Rows:** a radio list of rows (local date and time, size, `m<n>` and markers as icons with tooltips), newest preselected. An empty list disables `Restore`.
- **Restore:** when `databaseExists`, it confirms through `ConfirmDialog`, then calls `workspace:restore`.
  - A `Load the backups again` error reloads the list and shows the message.
  - Other errors show `messageOf(error)`.
- **Start empty:** shown only when `!databaseExists`. It confirms, then calls `workspace:open { rootPath, startEmpty: true }`.
- Busy states disable every button.

**`WorkspaceScreen.tsx`:** `openPath` catches `ApiError` with code `workspace_database_missing` and opens the dialog `{ rootPath }`, `databaseExists: false`, instead of showing the error.

**`WorkspaceTable.tsx`:** the menu item `Restore backup…` opens the dialog `{ id }`, `databaseExists: true`.

**Tests** (`test/renderer/restore-dialog.test.tsx`):
- `missing database on open shows the dialog with the newest preselected`
- `Restore without existing database needs no confirmation`
- `from the list Restore asks ConfirmDialog first`
- `Choose folder sends pickFolder and shows the new list`
- `stale id reloads the list`
- `Start empty confirms and opens with startEmpty`
- `no backups disables Restore`
- `no explanatory text: only labels and tooltips` (snapshot of visible text)

### D2 — Settings section and banner line

**`BackupSettings.tsx`:** loads `backup:status` and shows:
- the location text (`Workspace folder` or the path)
- `Change…` (`backup:changeLocation`; null keeps the view), and `Reset`, disabled for the default place
- the last attempt time and result, or the failure message
- `Back up now`, busy while it runs, which then reloads
- the count and total size
- the other-lineage rows with `Delete`, through `ConfirmDialog`, then `backup:delete`

It is added to `SettingsScreen` only while a workspace is open.

**`useBackupState.ts`:** `useBackupState(active: boolean): BackupState | null`.
- Polls `backup:state` every `BACKUP_STATE_POLL_MS = 5000`, one request at a time.
- A failed poll keeps the last value.

**`BackupBanner.tsx`:** shown when `last?.ok === false`. It shows `backupFailedLine(last.message)` with the `Settings` button (`BUTTON`, `WARNING`).

**`AppShell.tsx`** gets the prop `backupFailure: string | null`, rendered after `PauseBanner`. **`WorkspaceShell.tsx`** feeds it from the hook.

**Tests**
- `test/renderer/backup-settings.test.tsx`:
  - `shows Workspace folder and disables Reset for the default place`
  - `Change cancelled keeps the view`
  - `validation message shown on a refused folder`
  - `Back up now disables while running`
  - `Delete of another lineage asks first`
- `test/renderer/backup-banner.test.tsx`:
  - `failed last attempt shows the line with Settings that navigates`
  - `a later success hides it`
  - `a failed poll keeps the line`

`test/theme.test.ts` must stay green, so no colour literals.

**Command:** `pnpm --filter @assetforge/desktop test renderer && pnpm typecheck && pnpm lint && pnpm format`
**Commits:** one per task, then push.

## Final integration task (controller, after the four lanes are merged)

1. **Acceptance test** `apps/desktop/test/backup-acceptance.test.ts`. It uses real persistence, the real worker build, temp `userData` and workspace folders, and fake dialogs.
   1. Create a workspace and add an asset. `workspace:close` leaves one file in `<root>/.assetforge/backups/` matching `BACKUP_NAME_PATTERN`.
   2. Delete `userData/workspaces/<id>`. `workspace:open` answers `workspace_database_missing`.
   3. `workspace:backups { rootPath }` lists one regular entry with `sameLineage: false`.
   4. `workspace:restore` opens with the asset present and the same lineage as the backup.
   5. Restore over an existing database leaves `assetforge.sqlite.replaced-*`.
   6. Remove with a kept folder writes the final backup first. A chosen place that cannot be reached refuses the remove until `Remove anyway`.
   7. A broken migrations folder answers `The database update failed. Nothing was changed`.
   8. Assert that no log line contains the temp root path.
2. **ReadMe §9.4.**
   - Rewrite "Backup and restore": the backup is the database alone (checksums included through the `file` table); the restore validates the manifest id, format version and integrity and asks before replacing; the online backup meets the coordinated-writes sentence; the binaries are not verified.
   - Rewrite "Removing a workspace": the final backup comes first, and a kept folder opened again offers the restore instead of starting empty.
   - **§15.2:** backup is not a persistent job, because the job table is in the copied database and the backup also runs on a closed one.
3. **`CLAUDE.md` project state:** add one paragraph for this feature, in the existing style.
4. **`docs/backlog.md`.**
   - Remove the bullet "Database backup: a failed migration surfaces as `internal_error`…".
   - Add only entries that meet "What belongs here":
     - deferred: app-level settings in the backup, and a "verify workspace" pass, both from the spec's "Left open"
     - a manual check: a real NAS target and quit with a slow share
   - Nothing else.
5. **Full checks:** `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnp## Controller rulings (binding; they override the text above)

1. **First backup.** "No backup of this lineage exists in the location" counts as changed, as B1 builds it. A listing that fails counts as "exists", so an offline place never forces a copy.
2. **`workspace:backups` answers `{ backups: BackupEntry[], unreachable: boolean }`**, not a bare array. `unreachable` is true when the configured or default place could not be listed (the local copies and a picked folder do not set it). `WorkspaceManager.listBackups` answers `{ backups: ListedBackup[]; unreachable: boolean }`, and `listWorkspaceBackups` returns the same shape. Task 0 writes the schema this way; the fake API default is `{ backups: [], unreachable: false }`. The restore dialog shows `BACKUP_MESSAGES.backup_location_unreachable` as an alert above the list when it is true; `Choose folder…` stays usable.
3. **Failed migration.** Persistence throws the core-defined `DatabaseUpdateFailedError` (A2).
4. **Deadline on every close.** Close, switch and quit all pass `BACKUP_QUIT_DEADLINE_MS`; a backup cut off by it is recorded as `backup_failed`. The final backup before a remove gets the same deadline (the text of B4 says "no deadline"; that is replaced), and a cut-off there refuses the remove like any other failure.
5. **Closed snapshot.** The file copy of the database and its `-wal`, checked in the worker, is accepted.
6. **Order of the lanes.** Task 0 first. Then lanes A, B and D in parallel. Lane C starts after A and B are merged, because its handler tests run against the real manager and the real persistence parts.
7. **Tests of A3 on Windows.** A test that checks "no temp file is left" waits for the worker to exit before it looks; an open handle keeps a file alive on Windows.
8. **No path in any message.** `BackupStatus.location.path` is the only path that reaches the renderer, and only for display in the settings. No error message, log line or `BackupAttempt.message` carries a path or file name.
