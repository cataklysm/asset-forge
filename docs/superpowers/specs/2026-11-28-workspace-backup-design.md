# Workspace backup and restore

Status: draft for the owner's approval (2026-11-28).

## Intent

The workspace database lives in the user profile (`userData/workspaces/<id>/assetforge.sqlite`), deliberately, because
SQLite is not reliable on network shares. The files live in the workspace folder. Someone who reinstalls the machine and
keeps only the workspace folder loses every asset, tag, workflow, prompt and generation record: the files survive without
any relation to each other. Forgetting a workspace in the app (`workspace:remove` with the folder kept) deletes the
database directory today, with the same result. The owner counts this as a data safety problem.

The owner backs up with an external tool (duplicacy) and wants to decide where the database backup lies, so that the tool
picks it up.

## Goals

- A consistent copy of the database is written regularly to a place that survives the loss of the user profile; by
  default into the workspace folder itself.
- The place can be set per workspace.
- A workspace folder opened on a machine without its database can be restored from such a copy.
- A failed migration says that a backup exists and the same restore path works for it.
- A failed backup is visible and names its reason.

## Non-goals

- Moving the live database out of the user profile (approaches B and C below).
- Backing up the binaries; that stays the job of the owner's backup tool.
- App-level settings (provider entries, analysis prompts, site profiles) inside the backup. They are not workspace
  data, and restoring them onto a machine that already has settings needs merge rules. Follow-up, see "Left open".
- API keys and site cookies: they are bound to the operating system account and are never part of any backup.
- Adopting files that exist on disk but not in a restored database (see "Known limits").
- Encryption of the backup, backup to a remote service, a schedule the user can configure.

## Anti-goals

- A backup must never damage or slow down the live database, block the event loop, or keep the app from quitting for long.
- A restore must never silently replace a database: the replaced file is kept.
- No path, file name or URL in a log line or in an error forwarded to the renderer.

## Approaches

- **A — live database stays local, backups go to the workspace (chosen by the owner).** One rule for local and NAS
  workspaces; the backup tool finds the copies with the files. Cost: changes since the last backup are lost with the
  disk.
- **B — live database in the workspace folder when the folder is local.** Simplest for local workspaces, but two
  modes, and a drive letter does not reliably tell whether a folder is a network share.
- **C — live database always in the workspace folder.** Refused: corruption risk on SMB/NAS.

## Design

### Where backups lie

- Default: `<workspace root>/.assetforge/backups/`.
- Chosen: a directory picked by the user; the app writes into `<chosen>/assetforge-backups/<workspace id>/` and puts a
  small `workspace.json` (`{ v: 1, id, name }`) beside the copies so a person can tell the folders apart.
- The choice is stored per workspace at app level in the workspace registry (`userData/settings.json`), not in the
  manifest and not in the database: it is a path of this machine, and it must be readable while no database is open.
  After a reinstall it is gone; the restore then asks for the folder (below).
- A chosen directory inside the workspace root other than the default is refused (`validation_failed`), so nothing is
  written between asset directories.

### What a backup is

- One SQLite file made with better-sqlite3's online backup into a temporary file beside the live database (local
  disk), checked with `PRAGMA quick_check`, then copied as a stream to the target as `.tmp` and renamed when complete.
  SQLite itself never writes to the target, so a network share is safe as a target.
- Name: `assetforge-<yyyymmddThhmmssZ>-m<applied migrations>.sqlite`.
- The work runs outside the serial workspace queue and off the main event loop where it blocks (the online backup is
  incremental; the stream copy is asynchronous). One backup at a time per workspace.
- Free space is checked before the copy; too little answers `backup_no_space`.

### When

- When a workspace is closed (close, switch, quit) and its database changed since the last backup.
- While a workspace is open: at most once per hour, and only when the database changed since the last backup.
- On demand: `Back up now` in the settings.
- Before `workspace:remove` deletes the database directory: a final backup. If it cannot be written, the removal is
  refused with the reason, and the confirmation dialog offers `Remove anyway`.
- Quitting waits for a running backup for at most 30 s; after that the temporary file is abandoned and removed on the
  next start.
- "Changed" is the connection's change counter compared with its value at the last successful backup; a workspace that
  was only read gets no new copy.

### How many

The newest 5 are kept, plus the newest of each of the last 7 days that has one. Pruning runs after a successful backup,
touches only files matching the name pattern in the workspace's own backup folder, and never the one just written.

The pre-migration backup of the data safety package stays as it is (beside the live database, newest 3): it must work
before the storage is opened. In addition, after a successful migration the regular rule applies ("changed since the
last backup"), so the migrated state reaches the backup place at the next close or hour.

### Failures

A failed regular backup never fails the action that triggered it (close and quit go on). The result of the last attempt
is kept per workspace in memory and shown: one line in the shell banner area (`The last backup failed: <reason>`, with
`Settings`) while the workspace is open, and in the settings. Reasons are fixed codes with fixed messages:
`backup_location_unreachable`, `backup_no_space`, `backup_failed`. Each failure writes one safe log line (workspace id,
code, error description).

### Restore

Channels (all work without an open workspace):

- `workspace:backups { id | rootPath, directory? }` → the backups found for that workspace in the local database
  directory (pre-migration copies), the configured or default place, and an optional directory the user picked:
  `{ backupId, createdAt, sizeBytes, appliedMigrations, origin: 'pre_migration' | 'regular' }[]`, newest first. A file
  counts only when its name matches, it is a readable SQLite database and its workspace id equals the manifest's.
- `workspace:restore { rootPath, backupId }` → opens the workspace from that backup: the copy is brought to the local
  database directory as a temporary file, checked (`quick_check`, workspace id, schema not newer than the app), the
  current database file, if any, is renamed to `assetforge.sqlite.replaced-<stamp>` (the newest 2 are kept), the copy
  takes its place and the normal open runs, including migrations and recovery. `backupId` is an opaque id from the
  list; the renderer never sends a path to be read.

Where the user meets it:

1. **Opening a folder whose database is missing here.** `workspace:open` no longer creates an empty database silently
   for an existing workspace: when the manifest's workspace has no local database it answers the new code
   `workspace_database_missing`. The renderer then shows the restore dialog: the list of backups (newest preselected),
   `Restore`, `Choose folder…` (adds a picked directory to the search), and `Start empty` (opens with a new database,
   as today; confirmed through `ConfirmDialog`). Creating a new workspace is unchanged.
2. **A failed migration.** The open answers `invalid_operation` with `The database update failed. A backup from before
   the update exists` and the same dialog is offered from the workspace list (`Restore backup…` in the workspace's
   menu, always available for a workspace that is not open).
3. **Settings → Backup** (for the open workspace): the location (`Workspace folder` or a chosen directory, `Change…`,
   `Reset`), the time and result of the last backup, `Back up now`, and the number and total size of the copies.
   No explanatory text; explanations as tooltips.

### Known limits

- A restored database is as old as its backup. Files imported later exist on disk without a row; rows of files deleted
  later point to a missing binary and show as missing. A scan that adopts ownerless files into the inbox is a separate
  feature.
- Jobs that were queued or running at backup time come back and go through the normal recovery; paid generations with
  an unclear outcome are not repeated (unchanged rule).
- Up to an hour of work can be lost with the disk while the app stays open.

## Left to the builder

File and function names, the exact change counter, how the banner line is wired, the layout of the dialog and the
settings section within the existing components and `ui.ts` constants, test structure.

## Left open

- App-level settings in the backup (without keys and cookies) and their restore.
- Adopting ownerless files after a restore.
