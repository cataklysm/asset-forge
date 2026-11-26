# File trash — delete, restore and purge files — design

Status: draft for the owner's approval, 2026-11-26.

## Intent

Today a file can only be detached, which moves it back to the inbox; nothing can ever be removed. Failed imports stay in the inbox forever. The owner wants to get rid of images and other files for good, one at a time and as a selection, from an asset and from the inbox — without the risk that one wrong click on a large selection destroys work.

## Goals

- **Delete** a file or a selection from the asset Files tab, the inbox and the file detail dialog. The file disappears at once from the asset, the inbox, search, filters, counts and covers.
- A **trash** inside the app: its own screen listing deleted files, with **Restore**, **Delete permanently** and **Empty trash**.
- Restore brings a file back where it was (asset and role, or the inbox) with its tags, its analysis record and a waiting tag proposal.
- Only the trash removes a file from disk, and only on the owner's explicit action. Nothing is purged automatically (owner decision).
- Failed imports can be removed from the inbox.

## Non-goals

- Deleting assets or projects.
- Automatic emptying after a retention period (owner decision: by hand only). ReadMe §9.4's "defined recovery period" becomes "until the owner empties the trash".
- The operating system's recycle bin.
- Physical deduplication. Every file row owns its own binary, so purging one row never removes a binary another row needs.
- Batch detach as a main-process channel (backlog item, unrelated).

## Anti-goals

- A deleted file that still shows up anywhere outside the trash: in a list, a count, a tag filter, a search hit, a cover, a duplicate hint or an analysis target.
- A purge that removes database rows while the binary stays behind unnoticed, or removes a binary whose row survives.
- An analysis that writes tags or a proposal to a file after it was deleted.
- A confirmation dialog on Delete. The trash is the safety net; confirmations belong to the two irreversible actions only.

## Constraints

- ReadMe §9.4: deletion is logical first; physical deletion happens only after the metadata update succeeded. File system and database are not jointly atomic, so every step must be recoverable on workspace open.
- Storage operations stay inside the workspace; relative paths only in the database.
- An unreachable storage is not a missing file: no row is purged while the storage cannot be reached.
- Short transactions; file operations outside them. Batches of up to 1000 files (the `FileBrowser` selection limit).
- UI rules: no explanatory text in the layout (tooltips through `title`), buttons from `ui.ts`, tokens only.
- Architecture rules of `CLAUDE.md` (core without Electron or database, validated IPC, fixed error messages).

## Approaches

1. **Trash as a third place for a file (chosen).** A file is in an asset, in the inbox, or in the trash. Deleting is a relocation with the existing journaled move: the binary moves to a trash directory, the row loses `asset_id` and `role`, remembers where it came from and gets a deletion timestamp. Every query that goes through an asset (search index, asset tag filters, covers, file counts) excludes the file without being touched; only the queries that read files without an asset — the inbox scope and the workspace-wide ones — need a condition. Restore is the same move back.
2. **A deletion timestamp only, the file stays where it is.** Least file movement, but every asset-scoped query needs the condition too, and the asset directory on disk would keep binaries the app no longer shows. The owner opens these folders in other tools.
3. **A separate trash table.** Existing queries stay untouched, but tags, analysis, proposal and job rows would have to move with the row and back; much copying logic for no gain over approach 1.
4. **`trashed` as a fourth import status.** Conflates the technical import status with a user decision and loses the status the file had.

The owner chose an in-app trash emptied by hand; the mechanism (approach 1) is the author's call.

## Design

### Data model (migration `0008`)

`file` gains:

- `deleted_at` — ISO timestamp, null while the file is not in the trash. Indexed.
- `trashed_asset_id` — the asset the file was attached to when deleted, null for an inbox file. Foreign key to `asset` with `set null`, so a later asset deletion sends a restore to the inbox.
- `trashed_role` — the role it had there.

`file_move` gains `kind` — `relocate` (default, the existing behaviour), `trash` or `restore`. The commit of a move acts by kind: `trash` copies the row's current `asset_id`/`role` into `trashed_asset_id`/`trashed_role`, clears them and sets `deleted_at`; `restore` sets `asset_id`/`role` from the move's target and clears the three trash columns. The same commit runs in startup recovery, so an interrupted delete or restore ends in a consistent state in either direction.

Invariant: `deleted_at is not null` implies `asset_id is null and role is null`. It is enforced in the repositories and pinned by tests, not by a table CHECK: migration `0008` stays a set of `ADD COLUMN`s and does not rebuild `file`, which six tables reference (author's call). `status` is unchanged by deleting.

On disk a trashed file lives at `.assetforge/trash/<fileId>_<sanitised name>` in the same storage as before (a rename on one volume). `relative_path` follows the binary as with every relocation.

### Deleting (to the trash)

Applies to a file with status `complete`. In order:

1. Pending jobs of the file are cancelled and a running one is cancelled through the scheduler, before the file moves. Delete does not wait for the running handler to settle (a provider call may take up to the timeout); the write guard below is the guarantee.
2. The binary moves to the trash path through a journaled move of kind `trash`; the commit transaction sets `asset_id`/`role` to null, fills `deleted_at`, `trashed_asset_id`, `trashed_role`, clears a chosen cover that pointed at the file (the automatic cover then takes over) and reindexes the former asset.
3. Tags, the analysis record and a waiting proposal stay on the row untouched.

A complete file whose binary is missing on a reachable storage can still be deleted: the row goes to the trash without a move, and its `relative_path` is rewritten to the trash path all the same. Such an entry cannot be restored, only purged, and purging finds nothing to remove. Purge and sweep therefore never remove anything outside `.assetforge/trash/`. An unreachable storage refuses the operation with the existing storage error.

A **failed** file is removed outright: its row and any leftover binary in staging or the inbox are deleted, no trash entry. A **pending** file cannot be deleted (`invalid_operation`); an import in flight owns it.

The analysis must not write to a trashed file. The guard sits in the write itself: applying tags and storing a proposal check `deleted_at` inside their transaction and write nothing for a trashed or purged file. The handler also does not follow the file into the trash when it re-reads the image; a trashed file is `file_unavailable`. A job cancelled through the scheduler ends `cancelled` whatever its handler returns afterwards; a job that hits the guard without having been cancelled (a race) ends `failed` with `file_unavailable` and is not retried. No new job outcome is introduced.

Enqueueing refuses trashed files the same way it refuses files that are not analysable, checked in the transaction that inserts the job. Retry does not bring such jobs back: `jobs:retry` on a job whose file is in the trash answers `invalid_operation`, and `jobs:retryFailed` skips them.

### Restoring

The binary moves back through the journaled move: to `trashed_asset_id` with `trashed_role` when that asset still exists, otherwise to the inbox. The commit clears the three columns and reindexes the asset. The file never becomes a chosen cover again by itself. A restore whose binary is missing on a reachable storage is refused with a fixed message; the entry stays in the trash.

### Purging (Delete permanently, Empty trash)

Only files in the trash can be purged. Per file:

1. Any job of the file that is still active is cancelled through the scheduler (normally none: deleting cancelled them and retry refuses them). Then one transaction deletes its `file_tag`, `file_analysis`, `file_analysis_proposal` and `job` rows and then the `file` row. The scheduler must tolerate finishing a run whose job row is gone.
2. After the commit the binary is removed from the trash directory.

A crash between the two steps leaves a binary without a row. On every workspace open a sweep lists `.assetforge/trash/` — one bounded directory, not a workspace scan — and removes each binary whose file ID has no row. A binary that cannot be removed is left for the next sweep; the purge still counts as done.

Empty trash purges everything in the trash in chunks, with short transactions, and reports how many were purged and how many failed.

Preview cache entries are keyed by content hash, shared between duplicates and evicted LRU; purging does not touch them.

### Queries that must exclude trashed files

Everything that reads files without going through `asset_id`: the inbox scope of `files:list` and its counts, the workspace-wide file list and tag filters, `tags:suggest` usage where it counts files, duplicate detection on import (`findCompleteBySha256`: a file in the trash is not a duplicate), the analysis target reader for `files` and `fileFilter` targets and `analysis:preview`, tagging channels (`files:addTag`/`removeTag` and the batch variants refuse a trashed file) and assignment (`files:assign`, `assignMany`, `unassign` refuse it). `files:get`, `files:measure` and the media protocol still serve a trashed file, so the trash can show previews and the viewer with image dimensions. "Open externally" and "Show in folder" are not offered for it.

Each of these gets a test with one trashed file among live ones.

### IPC (`packages/contracts`)

- `files:trashMany` `{ fileIds }` (1–1000) → per-item results like `files:assignMany`; one item failing does not stop the others.
- `files:restoreMany` `{ fileIds }` → per-item results.
- `files:purgeMany` `{ fileIds }` → per-item results.
- `trash:empty` → `{ purged, failed }`.
- `trash:summary` → `{ count }`, for the navigation.
- `files:list` gains the scope `trash`, newest deletion first, with the existing search, tag and kind filters. `FileRecord` gains `deletedAt` and, for the trash, the origin: `trashedAssetId`, `trashedAssetName`, `trashedRole`.

Single-file actions use the batch channels with one ID. All run under the workspace's exclusive section like the existing relocations.

### Renderer

- **Delete** in the file menu, the file detail dialog and the selection bars of the asset Files tab and the inbox, next to Detach where that exists. The `Delete` key deletes the current selection of a `FileBrowser` when focus is not in an input. No confirmation. The result strip reports the counts as it does for other batch actions.
- In the detail dialog, deleting the shown file moves on to the next file of the viewer list, or closes the dialog when it was the last.
- A **Trash** navigation entry with the count, placed after Inbox. The screen is a `FileBrowser` over the scope `trash` (grid and table, endless, multi-select, search and filters, viewer). The table shows the deletion date and the origin (asset name or Inbox). Tags are shown read-only; Analyse, Review tags, Image to prompt, Assign, Detach, cover and the tag editors are not offered.
- Actions there: **Restore** and **Delete permanently** in the file menu, detail dialog and selection bar; **Empty trash** in the header. Delete permanently and Empty trash ask for confirmation through the shared dialog, naming the number of files; Restore does not.
- The failed tiles of the inbox get Delete as well; it removes them outright.
- The trash count refreshes after every delete, restore and purge.

### Error handling

Fixed messages only. Per-item failures carry an `AssetForgeError` code: `not_found`, `invalid_operation` (pending file, not in the trash, already in the trash), the existing storage codes for an unreachable storage, and a move collision handled like the existing relocation. A restore into an asset keeps the `<fileId>_<name>` path, so it cannot collide with another file.

### Recovery on workspace open

In this order: the existing `recoverFileMoves` (covers interrupted moves into and out of the trash through the move's `kind`), then the trash sweep for binaries without a row.

### Documentation

ReadMe §9.2 (trash directory), §9.4 (trash, purge order, sweep, "recovery period" wording), §10 (new columns, cover rule), §3.3 (Trash screen, Delete actions), the IPC list; `docs/backlog.md` (remove the request, resolve the entry on `job.file_id`/`file_analysis.file_id` without a delete rule, add what the reviews defer); `CLAUDE.md` project state.

## Testing

- Core and persistence: delete, restore and purge per state (asset file, inbox file, failed, pending, missing binary, unreachable storage); the invariant; cover handover; job cancellation on delete, the write guard with a handler that finishes after the delete, retry refusing and skipping jobs of trashed files, purge with a still active job; restore after the asset is gone; every excluded query; migration `0008` on a populated database.
- Storage consistency: a crash after the move and before the commit, in both directions; a crash between row deletion and binary removal followed by the sweep; the sweep never removes a binary that has a row.
- IPC: validation, per-item results, the exclusive section.
- Renderer (jsdom): Delete from menu, selection bar, detail dialog and key; the Trash screen's actions and confirmations; the count in the navigation; nothing forbidden offered in the trash.

## Left to the builder

- Names of core functions and repository methods, the chunk size of Empty trash, and whether the trash list is its own query or a scope of the existing one internally.
- The exact labels and tooltips, following `labels.ts`.
- Whether `trash:summary` is polled or refreshed through the existing change tokens.
- How the selection bar orders its buttons.
