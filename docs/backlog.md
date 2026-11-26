# Backlog

Findings from the phase 1, phase 2, phase 3a, phase 3b and UI redesign reviews that were deliberately not fixed. Nothing here blocks the next phase; triage the list whenever a plan touches the area.

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
- Preview requests are not cancelled when a tile scrolls away; the worker queue is only served newest first. A tile that is revisited while its job is still queued keeps its old place at the bottom of that queue and is served after everything requested in between.
- When the preview worker module cannot load, every queued job starts a fresh worker and logs its own failure line; one scroll can print hundreds of identical lines.
- The session failure memory of the preview service also remembers worker timeouts and crashes, and it is unbounded.
- No index on `asset.cover_file_id`.
- `setCover` is not a guarded UPDATE and `getAssetDetail` reads in two steps; both are safe only under serialised writes.
- The derived-data rebuild still runs on the main process while a workspace opens (about 1.7 s at 10 000 assets); it yields to the event loop between batches of 500, but each batch blocks it. The step also runs on every new workspace.
- `asset_search_map` rowids: once assets can be deleted, the FTS row and the map row must be deleted together; otherwise rowid reuse attaches a stale index row to a new asset.
- `FileKindSchema.catch('other')` in the file repository hides an invalid stored kind.
- Adding and removing a tag are check-then-act in the use cases (safe today because one writer holds the workspace lock).
- The search plans rely on `cross join` to fix the join order in the tag filter; the scale test guards it.
- The search path without a query still orders by `lower(name)` over all assets.
- The inbox file list orders through a temporary B-tree (no index matches its sort).
- `files:assignMany` holds the exclusive workspace queue for the whole batch.
- Tags stored before the letter-or-digit rule that consist only of symbols cannot be removed through the UI; a symbol-only name in the tag filter is rejected with `validation_failed`.
- Unused tag rows are never deleted and there is no tag rename or merge.
- A drive-relative source path without a backslash (`C:a.exe::$DATA`) still passes the refused-import check; no file dialog produces such a path.
- The 200-character limit of the search query counts UTF-16 code units, not characters.
- `InMemoryStorage.absolutePath` and `LocalStorage.absolutePath` behave differently when the storage is unreachable.
- `files:measure` runs inside `manager.exclusive`; other writers wait for the probe.
- Decoder byte limit of 256 MiB: an uncompressed 16-bit RGBA 8K TIFF (about 265 MB) gets neither dimensions nor a preview. Raising the limit is an owner decision.

## IPC and security

- Channel allowlist in the preload, so unknown channels fail there instead of at `ipcMain`.
- Track dialog-granted paths: `files:import` and `workspace:open` currently accept any absolute path sent by the renderer.
- Permission request handler on the session.
- `shutting_down` is returned before the sender check.

## Renderer

- Lists used as pickers and filters (projects in the asset list, asset and project pickers) load at most 200 entries.
- The project member table still uses a pager of 50 that resets on navigation.
- `CommitInput`: Enter followed by blur can save twice before the reload; the draft reset can overwrite typing while a reload is in flight.
- The load-error lists of the screens are keyed by their message, so two identical errors share a React key.
- The type select on the asset form is empty when loading the asset types fails.
- The "Importing…" label is shown while the file picker is still open.
- `formatBytes(1048575)` yields `1024.0 KiB`; no guard for NaN or negative values.
- A file whose placement failed counts as failed on the asset screen although it was imported into the inbox (the inbox screen counts it as imported).
- No settings for the cache size and location; the preview worker timeout (30 s) is a constant.
- The preview failure memory is per session and is not invalidated when a file changes.
- `Cache-Control` max-age on previews assumes the content of a file ID never changes (true until working-file re-hashing in phase 6).
- Two saves of the same workflow step in flight: the response that arrives last wins.
- A workflow without mandatory steps renders `<progress max="0">`.
- Removing a workflow clears the local state instead of reloading it.
- `CoverImage` keeps a failed id per instance, so non-virtualised tiles stay on the format tile after the storage returns until the user navigates away and back.
- A paged loader re-activated after an inactive settle would keep stale loading entries.
- Focus is lost when a focused placeholder becomes a Retry button.
- Multi-file Detach is a renderer loop over `files:unassign`.
- The project member table has no cover (the contract lacks it).
- Tag filter chips show the normalised name, not the display name.
- `ProjectListState` has no opened index, so focus does not return to the project row after Back.
- After assigning a file from the inbox detail dialog, focus is lost when its tile leaves the list.
- The assign busy guard of the inbox selection column does not survive a remount of the column.
- Body text uses Tailwind `text-sm` (14 px) in buttons and tables where the design names 15 px.
- Retry on the storage banner during an import remounts the page and clears the busy block; navigation and "Import files" are free while the main process still imports, and the result strip is lost.
- Ctrl+F ignores an open modal: it swallows the key and focuses the field behind the dialog.
- A stale `assets:get` can overwrite a newer mutation result on the asset screen, and `fileCountError` stays after a successful reload.
- `FileBrowser` refreshes the selection from the last rendered props instead of a functional update; `usePagedList` has side effects in render, and `retry` and `loadThrough` act on the non-displayed state.
- Batch tag changes on the asset Files tab bypass the `batching` guard, `nameOf` there closes over the render-time selection (the inbox uses a ref), and cover and detach from the menu have no busy guard.
- `AssignFileControl.assign` has no in-flight guard; two different picks in quick succession make the second fail with a domain error.
- Ctrl+A after a failed page silently selects a partial result; a failed first page shows Retry without a message (assets, projects, file browser).
- A stale assign failure strip in the inbox selection column stays for later selections.
- The Selection column is empty after a remount while the selected page is not loaded.
- A failing asset-type load is silent in `ProjectDetails`, and so is a failing library count in `AssetsScreen`.
- Candidate, not verified: the tile menu in the last visible row and the "More" menu at the bottom of the file dialog panel may be clipped.
- `TagCombobox` ignores IME composition, can keep a stale active option, and `aria-controls` points at a list that is not rendered; `TagFilter` loses focus at 10 tags.
- The row "Open" link has `tabIndex -1`; focus is not restored to a neighbour after a removal; the Workspaces screen has no `h1`.
- The dialog label "Type" shows the MIME type; the design says "format".
- Image viewer, left out on purpose: neighbouring files are not preloaded; 16-bit and wide-gamut TIFF are converted to 8-bit sRGB in the PNG rendition; the viewer cannot be opened from the asset gallery (only from file lists).
- Image viewer zoom: a fast Ctrl+wheel can lose zoom steps; `devicePixelRatio` is read at render only (no `matchMedia` resolution listener), so "100 %" is stale after a monitor or scaling change until the next render; a `reduced` rendition at 100 % is upscaled by a non-integer factor.
- Image viewer browsing: stepping on and a pending `show` wait until Retry when the slot's own page failed; focus falls to `body` when the focused Previous/Next button becomes disabled at the end of the list, after which the shortcut keys only work again after a click into the dialog; `ViewerList.want` has a new identity on every render.
- Small inconsistencies: the asset breadcrumb is "Assets" only while the project one adds the name; `AssetsScreen` does not refresh `lastSelected` from a loaded page as `ProjectsScreen` does; role selects use `INPUT` instead of `SELECT`.

## Code structure

- The asset row mapper is duplicated in three repositories.
- `safeErrorMessage` lives in `import-file.ts` although file moves use it too.
- The workflow progress rule exists three times: `progressOf` in the adapter, the SQL of the asset list, and the in-memory fake.
- The session and the import context are built from near-identical lambdas in the workspace manager.
- "Details" is removed from the dialog menu by its label, with dummy `onDetails` handlers in both hosts.
- `ROLES = FileRoleSchema.options` is declared six times in the renderer; `{ name: section } as View` in `WorkspaceShell`.
- The tag-id lookup is triplicated in persistence; `ipc.ts` and `library-handlers.ts` import each other.
- `AssetsScreen`, `AssetScreen` and `FileBrowser` are large and want splitting.
- `TagList` is called with `Number.MAX_SAFE_INTEGER` in the file dialog instead of a "show all" option.
- `FileBrowser.tsx` should hand its viewer state machine to a `useViewerList` hook.
- The preview worker pool doc comments still say "none" for failed jobs.

## Tooling and tests

- Split the desktop `tsconfig` into DOM (renderer) and Node (main, preload) configurations.
- Crash-recovery test on the real adapters (currently only on the fakes).
- Tests for `journal_mode=wal`, a failed migration closing its handle, the dangling-link and Windows case-folding branches, temp-file cleanup in the registry, and the "ignore removal errors" branch of `importFile`.
- The in-memory fakes approximate BM25 by a two-bucket rule (name matches first, then the rest).
- The in-memory fakes sort with `localeCompare`, SQLite with `lower()`; the orders can differ for non-ASCII names.
- The IPC test hard-codes the number of channels; the absolute-path scan in the error tests only looks for the native separator.
- The `EACCES` test of `writeStream` does not assert that the target is absent.
- The in-memory `assetWorkflows.insert` checks fewer foreign keys than SQLite does.
- A new template version next to workflows on the old one is only tested on the fakes, not on the SQL adapter.
- `check-sharp.mjs` is a manual gate and not part of `pnpm test`; it has no worker `exit` listener.
- No test for `workflows:remove` with an unknown asset; the `handlersFor` helper is duplicated in `acceptance.test.ts`.
- `noopHost` is duplicated in three test files.
- Fake and SQLite repositories differ in error precedence for batch tag channels.
- A `toHaveLength(1)` assertion in `tag-repository.test.ts` is vacuous.
- The test setup emulates Esc, and the native-close fallback of the dialog is untested; some tests assert class substrings.
- No test for superseding on a tag change; missing tests for `usePagedList` retry, the Workspaces busy state, the asset Files tab batch tags and the inbox assign failure strip.
- `console.info` output in the tag scale test.
- Flaky jsdom tests under load (pre-existing, timing-sensitive): inbox "filters and scroll offset survive navigation", assets and projects "list state round trip".
- Preview worker pool: the reverse eviction case (thumb evicted, `full` untouched) is untested.
- Media protocol tests: the cancel test cannot fail; the upper-case UUID parity test only compares nullness.
- Image viewer tests: no tests for the anchored scroll offsets and for Fit following a stage resize; `show(125)` alone and a file shifting across a page boundary are untested; the rejected-fullscreen test would pass without the `catch`; no test for the film strip scrolling the current tile into view; no end-to-end test "import stores oriented dimensions" through the real composition.

## Not covered by any automated check

The native confirmation for removing a workflow, native file and directory dialogs (and therefore the "Choose location", "Open existing folder" and "Import files" buttons end to end), window appearance, focusing the existing window on a second launch, the `shutting_down` response, the rejected-invoke path to `ApiError`, `formatDateTime`, the rendered messages for `unsupported_format_version` and `workspace_mismatch`, and keyboard-only operation beyond the tag rows, the file selection, menus, tabs and the dialog focus return.
