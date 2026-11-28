# Workspace backup and restore

Status: approved by the owner (2026-11-28).

## Intent

The workspace database lives in the user profile (`userData/workspaces/<id>/assetforge.sqlite`), deliberately, because
SQLite is not reliable on network shares. The files live in the workspace folder. Someone who reinstalls the machine and
keeps only the workspace folder loses every asset, tag, workflow, prompt and generation record: the files survive without
any relation to each other. Removing a workspace in the app with the folder kept deletes the local database too
(ReadMe §9.4: the catalog "starts empty" when the folder is opened again). The owner counts this as a data safety
problem.

The owner backs up with an external tool (duplicacy) and wants to decide where the database backup lies, so that the tool
picks it up.

## Goals

- A consistent copy of the database is written regularly to a place that survives the loss of the user profile; by
  default into the workspace folder itself.
- The place can be set per workspace.
- A workspace folder opened on a machine without its database can be restored from such a copy.
- A workspace whose database was damaged by an update, or that should go back to an earlier state, can be restored the
  same way.
- A failed backup is visible and names its reason.

## Non-goals

- Moving the live database out of the user profile (approaches B and C below).
- Backing up the binaries; that stays the job of the owner's backup tool.
- Verifying every file's checksum on restore (a full workspace scan) and adopting files that exist on disk but not in
  the restored database. Both belong to a later "verify workspace" feature.
- App-level settings (provider entries, analysis prompts, site profiles) inside the backup. They are not workspace
  data, and restoring them onto a machine that already has settings needs merge rules.
- API keys and site cookies: bound to the operating system account, never part of any backup.
- Encryption of the backup, backup to a remote service, a schedule the user can configure, server mode.

## Anti-goals

- A backup must never damage or slow down the live database, block the main event loop noticeably, or keep the app from
  quitting for long.
- A restore must never silently replace a database: it asks first and keeps the replaced one.
- Automatic pruning must never remove the backups of a lost database because a new, empty one started writing into the
  same folder.
- No path, file name or URL in a log line or in an error forwarded to the renderer.

## Approaches

- **A — live database stays local, backups go to the workspace (chosen by the owner).** One rule for local and NAS
  workspaces; the backup tool finds the copies with the files. Cost: changes since the last backup are lost with the
  disk.
- **B — live database in the workspace folder when the folder is local.** Simplest for local workspaces, but two
  modes, and a drive letter does not reliably tell whether a folder is a network share.
- **C — live database always in the workspace folder.** Refused: corruption risk on SMB/NAS.

## Changes to the ReadMe (decisions that change)

- §9.4 "Backup and restore": the backup is the database alone; the file checksums are part of it because they are
  stored in the `file` table. A restore validates the manifest id, the format version and the integrity of the copy,
  and asks before it replaces an existing database; it does not verify the binaries. The sentence about coordinated
  write jobs is met by SQLite's online backup, which gives a consistent snapshot while the app keeps writing.
- §9.4 "Removing a workspace": a final backup is written first; a kept folder opened again offers the restore instead
  of starting empty.
- §15.2: backup is not a persistent job. The job table lives in the database being copied, and the backup also runs
  while that database is closed.

## Design

### Database lineage

Every database gets a random lineage id when it is created (stored in its meta table; a migration gives existing
databases one). A restored database keeps the lineage of its backup. Backups carry the lineage in their file name, so
copies of different databases of the same workspace (the lost one, and an empty one started later or on a second
machine) never count as the same series.

### Where backups lie

- Default: `<workspace root>/.assetforge/backups/`.
- Chosen: a directory picked by the user (picked in the main process; the renderer gets the path only for display);
  the app writes into `<chosen>/assetforge-backups/<workspace id>/` and puts a small `backup-info.json`
  (`{ v: 1, id, name }`) beside the copies so a person can tell the folders apart.
- The choice is stored per workspace at app level in the workspace registry (`userData/settings.json`), not in the
  manifest and not in the database: it is a path of this machine and must be readable while no database is open. After
  a reinstall it is gone; backups then go to the default place until the user chooses again, and the restore can be
  pointed at a folder (below).
- Refused (`validation_failed`): a directory inside any workspace root other than the default place, inside
  `userData`, or one that cannot be written.

### What a backup is

- One SQLite file made with better-sqlite3's online backup into a temporary file in the local database directory,
  checked there (`PRAGMA quick_check`, workspace id, lineage), then copied as a stream to the target as `.tmp` and
  renamed when complete. SQLite never opens a file at the target, neither to write nor to read, so a network share is
  safe.
- Name: `assetforge-<lineage short id>-<yyyymmddThhmmssZ>-m<applied migrations>.sqlite`. Everything the list needs
  (time, lineage, applied migrations) is in the name; a backup is opened only after it was copied to the local disk.
- The online backup runs in small steps so the event loop stays responsive; the check and anything else that is
  synchronous over the whole file runs in a worker thread. One backup at a time per workspace.
- Free space is checked before the copy; too little answers `backup_no_space`.
- Temporary files have their own name pattern (distinct from the pre-migration backups and the replaced databases)
  and are swept when the workspace is opened and at app start.

### When

- When a workspace is closed (close, switch, quit) and its database changed since the last backup.
- While a workspace is open: at most once per hour, and only when the database changed since the last backup.
- On demand: `Back up now` in the settings.
- Before a workspace is removed: a final backup, made from the closed database file without opening or migrating it,
  and written before the folder is moved to the trash (with the default place the copy goes to the trash with the
  folder, which is what a person restoring the folder from the trash needs). If it cannot be written, the removal is
  refused with the reason and a second native dialog offers `Remove anyway`.
- "Changed" is a counter kept by the database layer: the connection's change count read once the open (migrations,
  derived data, recovery) has finished, compared with its value at the last successful backup. A workspace that was
  only read gets no new copy.
- A close waits for a running backup or starts the closing one; a timer never fires on a closed database. Quitting is
  capped: the backup gets at most 30 s, after which the temporary file is abandoned, and the whole shutdown (scheduler
  stop plus backup) never exceeds that cap plus the scheduler's own deadline.

### How many

Within one lineage the newest 5 are kept, plus the newest of each of the last 7 days that has one. Pruning runs after a
successful backup, touches only files of the same lineage matching the name pattern in the workspace's own backup
folder, and never the one just written. Backups of another lineage are never pruned automatically; the settings show
them and offer `Delete` (confirmed).

The pre-migration backup of the data safety package stays as it is (beside the live database, newest 3): it must work
before the storage is opened.

### Failures

A failed regular backup never fails the action that triggered it (close and quit go on). The result of the last attempt
is kept per workspace in memory and shown: one line in the shell banner area (`The last backup failed: <reason>`, with
`Settings`) while the workspace is open, and in the settings. Reasons are fixed codes with fixed messages:
`backup_location_unreachable`, `backup_no_space`, `backup_failed`. Each failure writes one safe log line (workspace id,
code, `describeError`).

### Restore

Channels (all work without an open workspace):

- `workspace:backups { id | rootPath, pickFolder? }` → the backups found for that workspace in the local database
  directory (pre-migration copies), the configured or default place and, with `pickFolder`, a directory the user
  picks in a native dialog opened by the main process: `{ backupId, createdAt, sizeBytes, appliedMigrations, origin:
  'pre_migration' | 'regular', sameLineage }[]`, newest first. `backupId` is an opaque id bound to this listing in the
  main process; the renderer never sends a path to be read, and a stale id answers `Load the backups again`.
- `workspace:restore { rootPath, backupId }` → a lifecycle step like open (jobs stopped, notifications sent, the copy
  check `rejectCopy` applied): the backup is copied to the local database directory as a temporary file and checked
  there (`quick_check`, workspace id equal to the manifest's, schema not newer than the app); then, with no connection
  open, the current database, if any, is moved aside together with its `-wal` and `-shm` side files as
  `assetforge.sqlite.replaced-<stamp>` (the newest 2 are kept), the copy takes its place and the normal open runs,
  including migrations and recovery.

Where the user meets it:

1. **Opening a folder whose database is missing here.** `workspace:open` no longer creates an empty database silently
   for an existing workspace: it answers the new code `workspace_database_missing`. The renderer shows the restore
   dialog: the list of backups (newest preselected), `Restore`, `Choose folder…`, and `Start empty` (a new database, as
   today; confirmed through `ConfirmDialog`). Creating a new workspace is unchanged.
2. **From the workspace list.** `Restore backup…` in the menu of a workspace that is not open opens the same dialog;
   because a database exists, `Restore` is confirmed through `ConfirmDialog`.
3. **A failed migration.** Drizzle rolls a failed migration back, so the database is unchanged and restoring the
   pre-migration copy would fail the same way. The open answers a fixed message instead of `internal_error`:
   `The database update failed. Nothing was changed`. The pre-migration copies are for an update that succeeded and
   still damaged data, and for going back to an older app version; they appear in the restore dialog.
4. **Settings → Backup** (for the open workspace): the location (`Workspace folder` or the chosen directory,
   `Change…`, `Reset`), the time and result of the last backup, `Back up now`, the number and total size of the
   copies, and the copies of other lineages with `Delete`. No explanatory text; explanations as tooltips.

### Known limits

- A restored database is as old as its backup. Files imported later exist on disk without a row; rows of files deleted
  later point to a missing binary and show as missing.
- Jobs that were queued or running at backup time come back and go through the normal recovery; paid generations with
  an unclear outcome are not repeated (unchanged rule).
- Up to an hour of work can be lost with the disk while the app stays open.
- With a default place on a share that is offline, the final backup before a removal fails and `Remove anyway` is the
  only way to remove.

## Left to the builder

File and function names, the ports this needs in core (`WorkspaceDatabase`, `WorkspaceHost`, `WorkspaceRegistry` have
none of them today), the layout of the dialog and the settings section within the existing components and `ui.ts`
constants, test structure. Lanes after a contract step: persistence (backup, check in a worker, change counter, lineage
migration, side-file-aware swap), core (backup service in the workspace manager, close guard, final backup, missing
database answer, restore as a lifecycle step), desktop main (registry location, stream copy, free space, handlers,
quit cap, sweep), renderer (restore dialog, list menu entry, settings section, banner line).

## Left open

- App-level settings in the backup (without keys and cookies) and their restore.
- A "verify workspace" pass: checksums of the binaries against the database and adopting ownerless files.
