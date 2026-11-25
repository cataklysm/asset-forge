# Phase 3a – Gallery and Previews: Design

First half of phase 3 (`ReadMe.md` §4, §9.3, §15.1, §16, §17). Builds on phase 2 (merged). The second half is `2026-11-25-phase-3b-tags-search-design.md`.

## Intent

Until now the library is tables of names. People who collect references and produce images recognise their assets by looking at them. Phase 3a makes the library visible: every asset shows a cover image, the files of an asset show as pictures, and a file can be handed to the application that edits it — without the renderer ever receiving an original, so that a large library stays usable.

## Acceptance criterion (ReadMe §17, part covered by 3a)

Browse a large library without loading all originals; open a BLEND file externally.

## Goals

- **Previews.** For image files, a thumbnail (longest edge 256 px) and a detail preview (longest edge 1024 px), generated on request, cached persistently, never enlarged beyond the original.
- **Media protocol.** The renderer gets previews through an internal protocol that serves nothing but cached previews of files of the open workspace.
- **Asset gallery.** The asset list becomes a grid of tiles: cover image, name, type, status, workflow progress. Same filters and pager as today, with 60 tiles per page.
- **Cover image.** By default the first image of the asset; the user can choose any image file of the asset as the cover and can go back to the automatic choice.
- **Files as pictures.** On the asset screen and in the inbox, files show their thumbnail (or a tile with the format for files without a preview). Selecting a file opens a detail view with the 1024 px preview and the file's data.
- **External applications.** "Open externally" opens a file with the application the operating system associates with it; "Show in folder" reveals it in the file manager.
- **List state survives navigation.** Going from a list to a detail screen and back restores filters and page (backlog item; a gallery makes the reset painful).

## Non-goals

- Tags, full-text search, new filters (phase 3b).
- Previews for anything but raster images: no 3D, PDF, video, EXR or SVG rendering. These files get a format tile.
- Showing the original at full resolution, zooming, comparing, editing.
- Watching working files for external changes, re-hashing, version snapshots (ReadMe §4.2; phase 6).
- Persistent jobs. Preview generation is on-demand cache filling, not a job (jobs arrive in phase 4); a lost request is simply repeated.
- Settings UI for cache size or location; the limits are constants for now.
- Storing image dimensions on the file row.
- A table view next to the grid, drag & drop, multi-selection.

## Anti-goals

- An original file, or any path outside the preview cache, reaching the renderer through the protocol.
- Decoding images on the main or renderer event loop.
- A broken, huge or hostile image taking the application down or blocking other previews.
- "Open externally" launching an imported program or script.
- A cover choice that keeps pointing at a file that no longer belongs to the asset.

## Constraints

- All constraints of phases 1 and 2 hold, including the UI rules (no explanatory text in the layout — tooltips via `title`; one button style).
- Sharp is the first new native module: it must load under Electron's ABI in tests, in `pnpm dev` and in the built app before anything is built on it. This is the first task of the plan; if it fails, stop and report. "Built app" means the output of `electron-vite build` run unpackaged, as in the earlier phases; installers and asar packaging do not exist yet and stay out of scope. Sharp is kept external to the bundle and must be resolvable from the worker entry.
- One Drizzle migration (`0003`).
- `core` and `contracts` stay free of Electron and Sharp. Preview generation lives in a new package `packages/media`; the protocol and the shell calls live in the desktop host.
- Error messages forwarded to the renderer carry no absolute paths.

## Approaches

**Who makes the previews**

1. **Sharp in a bounded pool of worker threads in the main process — chosen.** Named in the ReadMe stack; streams and limits input, handles PNG, JPEG, WebP, TIFF, GIF and AVIF; keeps decoding off both event loops. Cost: a native module and a worker entry in the build.
2. Electron `nativeImage`. Rejected: runs on the main thread, no pixel limit, no TIFF.
3. Resize in the renderer with a canvas. Rejected: ships originals to the renderer, which the ReadMe forbids.

**How previews reach the renderer**

1. **A custom protocol (`assetforge-media://`) handled in the main process — chosen.** `<img>` elements load lazily and cache natively; nothing large crosses IPC.
2. Base64 over IPC. Rejected by ReadMe §15.1.
3. `file://` URLs into the cache. Rejected by ReadMe §15.1 and §16.

**Bounding the gallery**

1. **Pages of tiles with lazily loaded images — chosen.** The existing pager already bounds the DOM and the number of requests per screen; no new renderer dependency and no untestable scroll logic.
2. Endless scrolling with a windowing library. Deferred: nicer to browse, but the renderer has no DOM test environment yet (backlog); revisit when it has.

**Where the cover choice lives**

1. **A nullable `cover_file_id` on the asset — chosen.** `null` means automatic. One column, one foreign key.
2. A flag on the file row. Rejected: needs a uniqueness rule per asset and is touched by every file move.

## Design

**Data model (migration `0003`).** `asset.cover_file_id` — nullable, references `file.id`. No other schema change.

**Effective cover.** The chosen file if `cover_file_id` is set; otherwise the image file of the asset with the earliest `imported_at` (ties by ID) among complete files; otherwise none. "Image file" means a file whose stored MIME type is in the list of previewable types — one constant in `core`, shared by the cover rule, `setCover`, the protocol handler and (through the file record) the renderer: `image/png`, `image/jpeg`, `image/webp`, `image/tiff`, `image/gif`, `image/avif`. It is a list, not an `image/*` test (`image/x-exr` is not previewable). The MIME type comes from the file extension as before; the content is not sniffed, and a file that turns out not to decode simply has no preview. `avif` is added to the extension map, and migration `0003` sets the MIME type of already imported `.avif` files. The effective covers of a list page are resolved with one additional query over the page's asset IDs, not with a subquery per row. `AssetSummary` and the asset detail carry `coverFileId` (the effective one) and the detail additionally `coverIsChosen`.

**Choosing a cover.** `assets:setCover { assetId, fileId | null }`. The file must be complete, attached to this asset and a supported image, else `validation_failed`. Whenever a file leaves an asset (detach, move to another asset), a `cover_file_id` pointing at it is set to `null` in the same transaction that commits the move — including the repair of a move intent on open. There is no transaction across repositories, so this lives inside the persistence adapter's `files.setPlacement` and `fileMoves.commit` (and in the in-memory fakes); the port signatures do not change. A file that only changes its role within the same asset stays the cover.

**Preview generation (`packages/media`).** One operation: source file → WebP of a given longest edge, written to a temporary file next to the target and renamed. Auto-orientation from EXIF is applied; metadata is stripped; animated images yield their first frame. Limits: input pixel limit 100 megapixels, input file size limit 256 MiB; beyond them, or on a decode error, the result is "no preview". A pool of 2 workers; requests for the same preview that arrive while it is being made share one result; a crashed worker is replaced and its request fails as "no preview".

**Cache.** `<userData>/cache/thumbnails/` and `<userData>/cache/previews/` (ReadMe §9.3), keyed by the file's SHA-256, the size and a format version — never by file ID, so identical content shares a preview and a changed file can never show a stale one. A complete file always has a checksum from its import; a row without one gets no preview. (ReadMe §15.1 still names the file ID as part of the key and is updated to this rule.) Each directory is limited to 2 GiB; when a limit is exceeded, least recently used entries are deleted down to 90 %. Cleanup runs off the event loop's hot path: once after a workspace opens and then after every 500 new entries. Deleting the cache directory loses nothing. A source that failed is remembered in memory for the session so that scrolling does not retry it on every tile.

**Media protocol.** `assetforge-media://preview/<file-id>?size=thumb|detail`. The scheme is registered as privileged (standard, secure) before the application is ready, and the handler is installed on the default session, which is the only session the application uses; no partition is introduced. The handler requires an open workspace, looks the file up by ID, requires it to be complete, resolves the source through the storage adapter (never from the request), fills the cache if needed and answers with the cached WebP and long-lived cache headers. Everything else — unknown ID, unsupported type, no preview, storage unreachable, malformed URL — is a `404` without a body. The renderer's CSP gains `img-src 'self' assetforge-media:`.

**Open externally / show in folder.** `files:openExternal { fileId }` and `files:showInFolder { fileId }`. The main process resolves the path from the file row and the storage root, checks that the file exists, and calls the shell. Files whose extension is on a block list of programs and scripts (`exe`, `com`, `bat`, `cmd`, `msi`, `scr`, `pif`, `lnk`, `ps1`, `vbs`, `vbe`, `js`, `jse`, `wsf`, `wsh`, `hta`, `jar`, `sh`, `app`, `command`, `desktop`, `html`, `htm`, `svg`, `url`, `reg`, `py`, `pyw`, `psm1`, `chm`, `jnlp`, `application`, `appref-ms`, `settingcontent-ms`, `library-ms`, `msc`, `cpl`, `msp`, `scf`, `inf`, `website`, `diagcab`) are never opened — `files:openExternal` answers `validation_failed` and the UI offers only "Show in folder" for them. The extension is taken from the name on disk after removing trailing dots and spaces and is compared in lower case; a name without an extension is not opened either. The list is one constant in `core`, so the file record can tell the renderer whether a file can be opened. An allow list of known asset formats was considered and rejected: asset libraries hold too many formats (`.blend`, `.spp`, `.ztl`, `.psd`, …) for a fixed list to be useful. Errors: `storage_unreachable` when the storage root is not reachable, `not_found` when the file is missing on disk; neither message contains a path.

**Renderer.**

- *Assets screen:* a responsive grid of tiles (page size 60). A tile is one link to the asset: cover thumbnail in a fixed 1:1 frame (image contained, not cropped), below it name, type, status and progress. An asset without a cover shows its type name in the frame.
- *Asset screen:* the file lists per role become thumbnail grids. A file tile shows the thumbnail or, for files without a preview, the upper-cased extension; the cover carries a "Cover" marker. Selecting a tile opens the file detail.
- *File detail:* a modal dialog (focus trapped, closes with Escape, returns focus to the tile) with the 1024 px preview or the format tile, original name, role, size, import date, and the actions "Open externally", "Show in folder", "Use as cover" / "Use automatic cover" (images of an asset only) plus the existing role and detach controls.
- *Inbox:* the same file tiles and the same detail dialog, without cover actions.
- An image that fails to load falls back to the format tile; it never shows a broken-image icon.
- *Navigation:* each list keeps its filters and page while the workspace is open; returning from a detail screen shows the list as it was left.

## Testing

- `packages/media`: real Sharp against generated fixtures — size bound, no upscaling, EXIF orientation, each supported format, pixel-limit and corrupt input → "no preview", concurrent identical requests produce one file, temp files are gone after success and failure. A test that Sharp loads under Electron's Node, like the existing better-sqlite3 one.
- Cache: key changes with content hash and size, LRU eviction down to the target, cleanup tolerates files vanishing underneath it.
- Core / persistence: effective cover (chosen, automatic, none; ordering ties), `setCover` validation, cover cleared on detach, on move to another asset and on move repair; migration `0003` on a phase 2 database.
- Desktop: the protocol handler as a function — only `preview` host, only known complete files of the open workspace, every failure a bare `404`, no path in any response; block list for open externally; IPC contract tests for the new channels; no absolute path in forwarded errors.
- End to end on the built app: import images and a `.blend`, browse the gallery, choose and reset a cover, detach the cover file, open the `.blend` externally, confirm the renderer requested only `assetforge-media://` image URLs.

## Left to the builder

Internal structure of the worker pool and of the cache index (file-system times or an in-memory map), exact tile sizes and breakpoints, the ports through which `core` asks for a preview, how the worker entry is bundled by electron-vite, and where the list state is kept in the renderer.
