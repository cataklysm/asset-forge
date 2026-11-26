# Image viewer — design

Date: 2026-11-26. Follows `2026-11-26-ui-redesign-design.md` ("Follow-up: image viewer"). Mockup: `docs/design/mockups/04-image-viewer.png`.

## Intent

The owner inspects images for artefacts: compression damage and fine errors of AI-generated images. For that the file detail dialog becomes an image viewer in which "100 %" shows the pixels of the stored original, not a recompressed preview. Images are at most 8K (7680 × 4320) in practice.

## Goals

- Zoom into an image up to its true pixels and beyond, with nothing between the stored file and the screen that could add or hide artefacts.
- Browse the files of the list the dialog was opened from without closing it.
- Show the pixel dimensions of an image.

## Non-goals

- Editing, cropping, saving a rotation, annotations, side-by-side comparison.
- Video, SVG, 3D and document rendering. Non-image files keep today's placeholder.
- Opening the viewer from anywhere other than the two file browsers (asset Files tab, inbox).
- Colour-management controls, histogram, EXIF display.
- A scan of the whole workspace to backfill dimensions.

## Anti-goals

- A "100 %" that silently shows resampled or recompressed pixels.
- Smoothing above 100 %.
- Unrestricted file access for the renderer: no `file://`, no path in a URL, no original of a type the browser could execute or interpret as a document.
- Loading several originals at once or shipping image bytes over IPC.
- Explanatory text in the layout (the mockup's shortcut legend is not built; shortcuts live in tooltips).

## Constraints

- All existing rules of `CLAUDE.md` and `ReadMe.md`: sandboxed renderer, media only through `assetforge-media://`, bounded worker pool for decoding, decoder pixel limits, relative paths in the DB, no absolute paths or cause messages in errors, tokens and class constants only, one `BUTTON` look, tooltips instead of text.
- Sharp runs in the existing worker pool of `packages/media`; nothing decodes on the main or renderer event loop except the browser's own `<img>` decode of the one image on screen.
- The existing dialog behaviour stays: focus return of `useFileDialog`, tag row, role control, "More" menu, the Asset block, Esc handling of nested popups.

## Approaches

1. **Original served directly; TIFF converted losslessly** — chosen by the owner. PNG, JPEG, WebP, GIF and AVIF are served unchanged through a new, narrow protocol address. TIFF, which Chromium cannot decode, gets a lossless PNG rendition from the worker, cached. Images beyond a guard limit show a reduced rendition with a visible marker. Costs two paths and the first protocol route that serves originals (ReadMe §"Original images are loaded only for an explicit detail view" foresees it).
2. **Convert everything losslessly.** One path, but an 8K lossless encode takes seconds and tens of MB of cache per image, and is pointless for formats the browser already decodes. Rejected.
3. **Originals only, TIFF without zoom.** Least work; TIFF would stay at the 1024 px preview. Rejected: does not serve the purpose.

Decided with the owner: approach 1, guard limit 8192 px on the longest edge, pixels drawn unsmoothed above 100 %, the 1024 px preview shown immediately and replaced when the original has loaded, dimensions stored at import.

## Design

### Dimensions (backend)

- `file` gains nullable integer columns `width` and `height` (one Drizzle migration). They hold the pixel size **after** EXIF orientation, i.e. what a browser displays. `FileRecord` gains `width: number | null`, `height: number | null`.
- A new core port `ImageProbe { measure(absolutePath): Promise<{ width; height } | null> }`, implemented in `packages/media` through the worker pool (Sharp `metadata()`, same pixel/byte limits as previews, `null` on any failure).
- **Import**: after the file reached its final place, a complete file with a previewable MIME type is measured and the result stored. A failed measurement never fails the import.
- **Existing files** *(my call)*: no workspace scan. A use case `measureFile(fileId)` behind the IPC channel `files:measure` (`{ fileId }` → `FileRecord`) measures a complete previewable file whose dimensions are null, stores them and returns the record; it is idempotent and returns the record unchanged when nothing can be measured. The viewer calls it when it shows such a file. Reason: the app has no released data, and "no permanent full-workspace scans" is a project rule.

### What the viewer may load (shared rule)

One pure function in `packages/core` (re-exported for the renderer through `contracts` or duplicated there if the dependency direction demands it — builder's choice, but one tested definition), `viewSource(mimeType, width, height)`:

| Result | Condition | Source |
| --- | --- | --- |
| `original` | MIME is `image/png`, `image/jpeg`, `image/webp`, `image/gif` or `image/avif`; dimensions known; longest edge ≤ 8192 | `assetforge-media://original/<file id>` |
| `converted` | `image/tiff`; dimensions known; longest edge ≤ 8192 | `assetforge-media://preview/<file id>?size=full` |
| `reduced` | previewable; dimensions known; longest edge > 8192 | `assetforge-media://preview/<file id>?size=full` |
| `preview` | previewable; dimensions unknown | `…?size=detail` (today's 1024 px preview) |
| `none` | everything else | placeholder as today |

`ORIGINAL_MAX_EDGE = 8192` is one exported constant.

### Protocol

- **`assetforge-media://original/<file uuid>`** — parsed as strictly as the preview URL (exact spelling, no query, no fragment, GET only). Served only when the file is complete, has a checksum, and `viewSource` of its stored MIME type and dimensions is `original`. The response streams the stored file (no full read into memory), with `Content-Type` taken from the stored MIME type out of the five-entry allow-list, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` *(my call: the Chromium cache must not duplicate large originals)*. Every refusal and every error is the same bare 404 as today. The path comes only from the storage adapter's resolution of the file row.
- **`?size=full`** — a third preview size next to `thumb` and `detail`: a **lossless PNG** of the oriented image, at original size when the longest edge is ≤ 8192, otherwise scaled down to 8192. Generated in the worker pool, cached by content hash in its **own directory `cache/full` with its own LRU budget of 2 GiB** *(my call)*, so a few large renditions cannot evict the 1024 px previews; its own format version in the cache key. The protocol answers `image/png` with `Cache-Control: no-store` for this size. It is served for every previewable file (the renderer only asks for it in the `converted` and `reduced` cases).
- ReadMe §570 ("originals are never served through the protocol") is rewritten to the rule above.

### Viewer (renderer)

Layout per mockup 04, inside the existing `detail` dialog (the builder may enlarge the detail size within the viewport rules):

```text
┌ name | asset ───────────────────────────  2 / 14  [<] [>]  [x] ┐
│ Details        │ [Fit] [100%]  [-] 84% [+]  [rotate] [fullscr] │
│ Name, Type,    │                                               │
│ Dimensions,    │                 image stage                   │
│ Size, Imported │                                               │
│ Role / Assign  │                                               │
│ Image tags     ├───────────────────────────────────────────────┤
│ Asset, tags    │  [thumb] [thumb] [THUMB] [thumb] [thumb] …    │
│ More           │                                               │
└────────────────┴───────────────────────────────────────────────┘
```

- **Details** gain "Dimensions" (`1600 × 2000 px`; "–" while unknown).
- **Stage.** Shows the 1024 px preview at once, sized as the original would be, and swaps to the `viewSource` image when it has loaded; a failed load keeps the preview and shows an inline alert. Only the current file's large image is mounted.
- **Zoom.** The percentage always refers to original pixels (stored dimensions). "Fit" (default for every newly shown file) scales the image into the stage and never above 100 %. "100 %" *(my call, from the intent)* is one image pixel per **device** pixel: the CSS size is the pixel size divided by `devicePixelRatio`, so on a display scaled to 125 % or 150 % nothing is resampled at 100 %. Fit is capped at that same 100 %. Steps for +/−: 10, 25, 33, 50, 67, 100, 150, 200, 300, 400, 800 %. Ctrl+wheel zooms around the pointer; plain wheel scrolls; dragging pans; a double click toggles Fit and 100 %.
- **At and above 100 %** the image is drawn with `image-rendering: pixelated`; below 100 % the browser's smooth downscaling stays.
- **Animated files** *(my call)*: an animated GIF, WebP or AVIF served as the original plays, because it is the original; the preview shown first is its first frame.
- **`reduced` and `preview` sources** *(my call)*: the percentage carries a warning marker whose tooltip says "Reduced from W × H px" or "Preview only", and "100 %" is disabled for `preview`.
- **Rotate**: 90° clockwise per press, view only, reset when another file is shown.
- **Fullscreen** *(my call)*: the stage with its toolbar goes fullscreen through the Fullscreen API (true screen fullscreen); Esc or the button leaves it and does not close the dialog.
- **Browsing.** The dialog receives the list it was opened from: the `FileBrowser`'s current items in their current order, the total, and a way to load the next page. Previous/next (header buttons and ←/→) step through **all** files of that list, images or not; "n / total" uses the list total; stepping past the loaded items loads the next page; there is no wrap-around. On close, focus returns to the tile of the file shown **last** (this changes `useFileDialog`: the remembered id follows the viewer, and the opener element is used only while that file is still the one shown); the `FileBrowser` scrolls that tile into view.
- **Film strip.** A horizontally virtualised row of 256 px thumbnails (placeholder label for non-previewable files) of the same list; the current one is marked and kept in view; a click shows that file.
- **Keyboard**, active when the focus is not in a text field, select or open popup: ←/→ browse, + / − zoom, 0 Fit, 1 100 %, R rotate, F fullscreen, Esc close (fullscreen first). Every control's `title` names its shortcut.
- **List changes under the viewer.** The viewer tracks its position by file id, not by index. Tag, role, assign and detach work as today and may reload the list. One rule covers every case: when the current file is no longer in the reloaded list (assigned, detached, or filtered out by its changed tags or role), the viewer shows the file that followed it, else the one before, else closes. The viewer therefore keeps the pages around its position loaded across a reload (its own wanted range in `usePagedList`).

## Tests

- Unit: `viewSource` table; original-URL parser (every malformed spelling is rejected); the handler refuses non-allow-listed MIME types, incomplete files, unknown or oversized dimensions, and streams with the stored type; `full` preview is lossless (pixel comparison against the source) and capped; `measureFile` idempotence; import stores oriented dimensions (an EXIF-rotated fixture).
- Migration test in the existing migration suite.
- DOM: zoom state machine (Fit/100/steps, percentage from stored dimensions), `pixelated` above 100 %, keyboard map incl. no browsing while typing in the tag input, previous/next with page loading and the counter, film strip selection, swap from preview to original, the reduced marker, focus return unchanged.
- Sharp `metadata()` and PNG output are exercised under the Electron ABI like the existing media tests.

## Left to the builder

Dialog dimensions and the film-strip height within the token grid; pan/zoom implementation (CSS transform or scroll container); how the next page is requested from `usePagedList`; whether neighbouring 1024 px previews are preloaded; the PNG compression level; icon choice; file and hook decomposition; where `viewSource` lives so that both the main process and the renderer use one definition.
