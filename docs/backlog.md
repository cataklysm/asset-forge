# Backlog

Findings from the phase 1 and phase 2 reviews that were deliberately not fixed. Nothing here blocks the next phase; triage the list whenever a plan touches the area.

## Correctness and robustness

- `JsonWorkspaceRegistry` read-modify-write is unserialized and quarantine on read is racy; it drops unknown keys in `settings.json`.
- `database.close()` throwing inside the `open` error path masks the original error.
- `isInside` rejects valid names that start with `..` (e.g. `..config`); compare against `..` and `..` + separator.
- A failed move leaves an empty target parent directory.
- `LocalStorage.move` checks for the target and then renames; a target created in between can be replaced.
- A file move whose commit fails leaves the file row pointing at the old path until the workspace is opened again.
- `assignAsset` checks for an existing assignment and then inserts (not one statement); `addRelation` returns a `createdAt` that was not stored when the relation already existed.
- Quitting the application waits for a running import; reads are not ordered against `close`.
- File names are truncated by code points, so long non-ASCII names can exceed a 255-byte limit (ext4, Samba).
- The same folder reached through a drive letter and a UNC path is reported as `workspace_duplicate`.
- `EPERM` from a locked file is reported as `storage_access_denied`.
- Error messages that carry absolute paths to the renderer: `PathEscapeError` for a dangling link (`packages/storage/src/local-storage.ts`), "Cannot read source file: …" on import, and "Storage is not reachable: …" on workspace create/open.
- Non-domain import errors are not logged anywhere; the recovery results (imports and file moves) are not logged either.
- Pre-migration database backup; migrations path for the packaged app.
- Hashing moves off the main event loop once jobs exist.
- The built-in asset type definitions generate fresh UUIDs on every open (only used when a type is missing).
- `createAsset` inserts the asset and then starts its default workflow; the two are not atomic, so a failure in between leaves an asset without the workflow of its type.
- A built-in template whose version row is missing is only repaired the next time the workspace is opened.
- The asset list computes progress with two correlated subqueries per row.
- Nothing guards against editing a built-in workflow template definition without raising its version; such an edit never reaches existing workspaces.
- Workflow use cases assert that the workflow they just wrote can be read back; a failure there surfaces as `internal_error`.

## IPC and security

- Channel allowlist in the preload, so unknown channels fail there instead of at `ipcMain`.
- Track dialog-granted paths: `files:import` and `workspace:open` currently accept any absolute path sent by the renderer.
- Permission request handler on the session.
- `shutting_down` is returned before the sender check.

## Renderer

- Lists used as pickers and filters (projects in the asset list, asset and project pickers) load at most 200 entries.
- Returning from a detail screen resets the filters and page of the list.
- `CommitInput`: Enter followed by blur can save twice before the reload; the draft reset can overwrite typing while a reload is in flight.
- Load errors are keyed by their message (duplicate React keys); two failed imports of the same source path collide the same way.
- The import failure list hardcodes its red classes instead of using `ALERT`.
- The type select on the asset form is empty when loading the asset types fails.
- The "Importing…" label is shown while the file picker is still open.
- `formatBytes(1048575)` yields `1024.0 KiB`; no guard for NaN or negative values.
- Asset detail groups files by role per loaded page; with more than one page a role shows up incompletely on several pages.
- A file whose placement failed counts as failed on the asset screen although it was imported into the inbox (the inbox screen counts it as imported).
- Two saves of the same workflow step in flight: the response that arrives last wins.
- A workflow without mandatory steps renders `<progress max="0">`.
- Removing a workflow clears the local state instead of reloading it.

## Code structure

- The asset row mapper is duplicated in three repositories.
- `safeErrorMessage` lives in `import-file.ts` although file moves use it too.
- The workflow progress rule exists three times: `progressOf` in the adapter, the SQL of the asset list, and the in-memory fake.
- The session and the import context are built from near-identical lambdas in the workspace manager.

## Tooling and tests

- Split the desktop `tsconfig` into DOM (renderer) and Node (main, preload) configurations.
- The renderer has no DOM test environment: hooks (`useLoad`) and screens are untested; the labels test only checks lengths.
- Crash-recovery test on the real adapters (currently only on the fakes).
- Tests for `journal_mode=wal`, a failed migration closing its handle, the dangling-link and Windows case-folding branches, temp-file cleanup in the registry, and the "ignore removal errors" branch of `importFile`.
- No test for a backslash in `nameContains` or for a `%` filter against a name that contains a literal `%`.
- The in-memory fakes sort with `localeCompare`, SQLite with `lower()`; the orders can differ for non-ASCII names.
- The IPC test hard-codes the number of channels; the absolute-path scan in the error tests only looks for the native separator.
- The `EACCES` test of `writeStream` does not assert that the target is absent.
- The in-memory `assetWorkflows.insert` checks fewer foreign keys than SQLite does.
- A new template version next to workflows on the old one is only tested on the fakes, not on the SQL adapter.
- No test for `workflows:remove` with an unknown asset; the `handlersFor` helper is duplicated in `acceptance.test.ts`.

## Not covered by any automated check

The native confirmation for removing a workflow, native file and directory dialogs (and therefore the "Choose location", "Open existing folder" and "Import files" buttons end to end), window appearance, focusing the existing window on a second launch, the `shutting_down` response, the rejected-invoke path to `ApiError`, `formatDateTime`, the rendered messages for `storage_unreachable`, `unsupported_format_version` and `workspace_mismatch`, and keyboard-only operation of the screens.
