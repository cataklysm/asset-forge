# Phase 2 backlog carried over from phase 1

Findings from the phase 1 reviews that were deliberately not fixed before the merge. Items under "Required" must be part of the phase 2 plan; the rest are to be triaged when that plan is written.

## Required

- **Storage reference in the schema.** File rows must hold a storage ID next to the relative path (ReadMe: "DB rows hold a storage ID plus relative paths"; phase 1 spec). The phase 1 schema has no such column. Add it with a backfill migration for existing rows.
- **Map destination errors during streaming.** In `LocalFileSystemStorage.writeStream`, an `ENOSPC`/`EACCES` raised by the destination mid-stream escapes untranslated, so the user sees `Import failed (ENOSPC)` instead of `storage_full`. Track the destination error separately (`out.once('error')`) and pass an error through untranslated only when it is the source error. Test with a failing `FileHandle.prototype.write`.

## Correctness and robustness

- Lifecycle mutex for open / close / import; `JsonWorkspaceRegistry` read-modify-write is unserialized and quarantine on read is racy.
- `JsonWorkspaceRegistry` drops unknown keys in `settings.json` and has no way to remove an entry.
- `meta.init` has no single-row guard; `markComplete` / `markFailed` silently no-op on an unknown id (check `.changes`); `insertPending` spreads its argument instead of mapping fields; list page and count are not read in one transaction.
- `database.close()` throwing inside the `open` error path masks the original error.
- `isInside` rejects valid names that start with `..` (e.g. `..config`); compare against `..` and `..` + separator.
- `writeStream` does not destroy the source stream when resolve / mkdir / open fails; a failed move leaves an empty target parent directory.
- File names are truncated by code points, so long non-ASCII names can exceed a 255-byte limit (ext4, Samba).
- The same folder reached through a drive letter and a UNC path is reported as `workspace_duplicate`.
- `EPERM` from a locked file is reported as `storage_access_denied`.
- `PathEscapeError` for a dangling link carries an absolute path in its message (`packages/storage/src/local-storage.ts`).
- Non-domain import errors are not logged anywhere; the recovery result is not logged either.
- Pre-migration database backup; migrations path for the packaged app.
- Hashing moves off the main event loop once jobs exist.

## IPC and security

- Typed error-code union in `contracts` instead of free strings; integer constraints for `sizeBytes`, `total`, `limit`, `offset`.
- Channel allowlist in the preload, so unknown channels fail there instead of at `ipcMain`.
- Track dialog-granted paths: `files:import` and `workspace:open` currently accept any absolute path sent by the renderer.
- Permission request handler on the session.
- `shutting_down` is returned before the sender check.

## Renderer

- `WorkspaceScreen` / `FilesScreen` show "Loading…" forever after a failed list call, and an error is never cleared.
- `FilesScreen` loads twice on reset to the first page and can apply paging responses out of order.
- React key collision when the same source path is imported twice; "N imported" counts duplicates; the "Importing…" label is shown while the file picker is still open.
- `formatBytes(1048575)` yields `1024.0 KiB`; no guard for NaN or negative values.

## Tooling and tests

- Split the desktop `tsconfig` into DOM (renderer) and Node (main, preload) configurations.
- Crash-recovery test on the real adapters (currently only on the fakes).
- Tests for `journal_mode=wal` / `foreign_keys=on`, a failed migration closing its handle, the dangling-link and Windows case-folding branches, temp-file cleanup in the registry, the error classes, and the "ignore removal errors" branch of `importFile`.

## Not covered by any automated check

Native file and directory dialogs, window appearance, focusing the existing window on a second launch, the `shutting_down` response, the rejected-invoke path to `ApiError`, `formatDateTime`, and the rendered messages for `storage_unreachable`, `unsupported_format_version` and `workspace_mismatch`.
