# UI Redesign: Design

Renderer phase after phase 3b (`2026-11-25-phase-3b-tags-search-design.md`, Plan decision 1 of its plan), which must be merged first. Visual reference: `docs/design/mockups/01-workspaces.png` … `07-assets-gallery-variant.png` (02 and 07 are one screen; their differing sample data is noise). Builds on phase 3a (gallery, previews, cover, list state).

## Intent

The application works, but it looks like a form generator: buttons in a row at the top, every section stacked under the last. Phase 3b made the library searchable without giving it a face. This phase gives AssetForge the appearance of the mockups — a dark, calm workspace with a fixed navigation, a content area and a detail column — and delivers the renderer half of tags and search, plus the bulk actions the inbox needs to be a real sorting place. Nothing that works today is lost on the way.

## Goals

- **One look everywhere.** Dark theme from shared design tokens; fixed shell with header (workspace name, path, "Workspaces" button), left navigation (Assets, Projects, Inbox) and, on list screens, a right detail column.
- **Workspaces as a table** with name, location, last opened, "Open" and a row menu; "Open folder" and "New workspace" as page actions.
- **Assets gallery** with search field, type/status/project filters, tag filter with chips, file role and file kind filters, result count and "Clear filters"; tiles show the cover, the cover's file tags, name, type, status, progress and the asset tags; a "Selection" column for the selected asset.
- **Asset screen** with breadcrumb, header fields, asset tag row, and tabs Files / Workflow / Projects / Relations with counts. The Files tab has search, role, tag and kind filters, grid and table view.
- **File detail dialog** restyled with a details panel, role, a file tag row and the asset's tags (read-only).
- **Projects** with search, status filter, tag filter, a "Matching tags" column, a "Project details" column and "Matching content".
- **Inbox** with search, kind and tag filters, multi-select, shared tags of the selection, and assigning several files to an asset at once; failed imports stay visible with their error.
- **Search behaviour** from 3b: 250 ms debounce, newer requests supersede older ones, previous results stay visible until the new first page arrives (fixes the "Loading…" flash from the backlog).
- **Tags are always attributable:** asset tags and file tags are never shown in one undifferentiated row (labelled rows, image icon before file tags).
- **A DOM test environment** for the renderer.

## Non-goals

- The image viewer of mockup 04 (zoom, rotate, fullscreen, browsing, film strip) and image dimensions — see "Follow-up: image viewer".
- The "Asset + image tags" scope dropdown of mockups 02, 05 and 07 (owner decision): the tag filter never distinguishes where a tag sits.
- A light theme (tokens keep the door open).
- Bulk actions on assets or projects; tag renaming/merging; AI tags (phase 4); drag and drop.
- Settings screens, template editor, custom asset types (ReadMe §18).
- Packaging, custom window frame (the native title bar and menu stay).

## Anti-goals

- A feature of today disappearing because the mockup does not draw it.
- Explanatory sentences in the layout (the mockups' "Image tags" captions next to filters and the keyboard hint line of 04 become `title` tooltips).
- A second button look: link-styled actions, filled "primary" buttons, ghost buttons.
- A tag shown without telling whether it belongs to the asset or to a file.
- A screen that loads all assets, all files or all originals to render, select or filter.
- A batch action that fails silently for some items.

## Constraints

- All constraints of phases 1 to 3b hold: `contextIsolation`, sandbox, validated IPC, previews only through `assetforge-media://`, error messages without paths, virtualised and paginated lists (page size 60), no persistence logic in the renderer.
- UI rules: explanations only as `title` tooltips; every action button uses the one `BUTTON` style (icon-only buttons use the same style with square padding); navigation targets (breadcrumb, asset link in the dialog, nav items) are links, tabs are tabs; everything reachable by keyboard; focus handling as today (focus returns to the trigger when a dialog or menu closes, roving tabindex in grids).
- No database migration is needed (see "Contract and backend changes").
- Main process changes are limited to window appearance: `nativeTheme.themeSource = 'dark'`, a `backgroundColor` equal to the page token (no white flash), and a minimum window size of 1024 × 680.
- One new runtime dependency is allowed: `lucide-react` (pinned) for icons. No component library; native `<select>`, `<dialog>`, checkboxes and inputs, styled.

## Approaches

**(a) Theme implementation**

1. **Design tokens as CSS variables in Tailwind 4 `@theme`, dark only — chosen.** `index.css` declares the tokens (`--color-surface`, `--color-accent`, …); Tailwind generates utilities from them (`bg-surface`, `border-line`, `text-muted`). `ui.ts` keeps the shared class strings (`BUTTON`, `INPUT`, `CHIP`, …) built from those utilities. All `dark:` variants and slate literals disappear from components. A light theme later means a second set of variable values, not a component sweep. `color-scheme: dark` makes native controls, scrollbars and the select popup dark.
2. Utility classes with literal colours spread over components. Rejected: the current state (`dark:bg-slate-800` in a dozen files) is what makes a restyle expensive; the mockups' colours are not Tailwind defaults.
3. Dark + light now. Rejected: doubles visual review for no request; the owner asked for the dark look. The OS preference is no longer followed.

**(b) Shell and detail column structure**

1. **Shared layout components — chosen.** `AppShell` (header, nav, main slot, busy state, global alert), `Page` (title, count, actions, toolbar, content, optional `detail` slot rendered as the right column), plus shared building blocks: `FilterBar`, `SearchField`, `TagFilter`, `TagChip`, `TagRow`, `Menu`, `Tabs`, `SelectionBar`, `FileBrowser` (grid/table of files with filters and selection, used by the asset Files tab and the inbox), `Dialog`. Three screens with a detail column and two file browsers share one geometry and one keyboard model.
2. Each screen builds its own layout. Rejected: five copies of header/toolbar/column geometry drift apart, and the selection and keyboard logic of the file grid would exist twice.

## Design

### Design tokens

Proposed values, read off the mockups (CSS px at 100 % zoom):

| Token | Value | Use |
| --- | --- | --- |
| `bg` | `#060b1d` | page background |
| `surface` | `#0c1428` | dialogs, tile meta band, table header |
| `raised` | `#131d36` | buttons, inputs, menus |
| `nav-active` | `#26324d` | active nav item, pressed toggle |
| `line` | `#2a3550` | dividers, control borders |
| `line-strong` | `#4a5670` | chip border, hover border |
| `text` | `#e8ebf2` | primary text |
| `muted` | `#97a1b5` | labels ("Type", "Status"), counts |
| `accent` | `#38c6f4` | selection border, focus ring, active filter chip, links |
| `accent-soft` | `#0f2b3d` | background of selected rows |
| `danger` | `#f87171` on `#2a1015` | errors, failed imports |
| `warning` | `#fbbf24` | storage unreachable banner |

- **Typography:** `"Segoe UI Variable", "Segoe UI", system-ui, sans-serif`. Page title 28/600; workspace name 24/600; section heading 18/600; tile title 17/600; body 15/400; label and meta 14/400 in `muted`; chip 13/400. Counts next to page titles 28/400 in `muted`.
- **Spacing:** 4 px grid. Page padding 24; header height 76 with a bottom divider; nav width 200; detail column width 300 (264 below 1280 px window width); gap between columns 24 with 1 px vertical dividers; toolbar rows 40 high, 12 apart; tile gap 16.
- **Radii:** controls and chips 6; tiles and preview frames 8; dialogs 10.
- **Controls:** height 36 (toolbar) / 32 (inline); `BUTTON` = `raised` background, 1 px `line` border, `text`, radius 6, px 14, hover border `line-strong`, `aria-pressed` → `nav-active` background and `accent` border, disabled 50 % opacity. Focus ring 2 px `accent`, offset 2. Chip = 1 px `line-strong` border, transparent, height 26, px 10; a filter chip has `accent` border and text and a remove icon.
- **Tag distinction:** file tags are preceded by an image icon (`ImageIcon`, 16 px) once per row; rows are labelled "Asset tags" / "Image tags" wherever both appear. In phase 4 an `ai` origin will add a dashed border; the chip component takes `origin` already.

### Shell

- **Header:** workspace name (24/600) and root path below it in `accent` (plain text, truncated with the full path as `title`); right: "Workspaces" button with a left arrow icon, which closes the workspace (today's "Close workspace"). Divider under the header.
- **Navigation (left):** Assets, Projects, Inbox with icons; the section of the current view has `nav-active` background and `aria-current="page"`. While an import runs, the nav items and "Workspaces" are disabled with the tooltip "Import in progress" (as today).
- **Main:** the current page. **Detail column:** rendered by Assets, Projects and Inbox only; the asset and project screens use the full width.
- **Global alert region** under the header for errors that belong to no screen. **Storage unreachable:** when any call fails with `storage_unreachable`, a `warning` banner states it with a "Retry" button that reloads the current view; previews fall back to the format tile (existing `CoverImage` behaviour).
- **Keyboard:** Tab order header → nav → page toolbar → content → detail column. `Ctrl+F` focuses the page's search field (tooltip on the field says so). `Esc` in a search field clears it.

### Workspaces (01)

- **Regions:** app title "AssetForge" with divider; page title "Workspaces" with count; actions "Open folder" (folder icon; picks a folder and opens it, today's "Open existing folder") and "New workspace" (plus icon); table with columns Name (folder icon + bold name), Location, Last opened (`formatDateTime`), and per row "Open" plus a "…" menu with "Remove" (native confirmation by the host, as today). Footer line with the count ("1 workspace"). Rows sorted by last opened, newest first.
- **New workspace** opens a `Dialog`: name field (autofocus), "Choose location" button, the resolved target path (from `workspace:resolveCreatePath`) as muted text, "Create" and "Cancel". Enter without a location opens the folder picker (today's behaviour).
- **States:** loading (skeleton rows), empty (table header plus the two page actions; no prose), error (alert above the table), unreachable or missing folder on open (alert with the mapped message; the row stays).
- **Keyboard:** rows are not focusable themselves; Tab reaches "Open" and "…" per row; the menu uses arrow keys, Enter, Esc.

### Assets gallery with Selection column (02/07)

- **Title row:** "Assets" + total count of the unfiltered library (one `assets:list` call with `limit: 1`), "New asset" button → `Dialog` with name and type, creating and opening the asset (today's form).
- **Filter row 1:** search field (placeholder "Search assets", magnifier icon; `query`, 250 ms debounce), Type, Status, Project selects (first option "All …"), grid/table toggle (two icon buttons, `aria-pressed`, tooltips "Show as tiles" / "Show as table"; choice remembered per device as today).
- **Filter row 2:** Tags combobox (input with suggestions from `tags:suggest`, Enter or click adds; up to 10), Role select (file role), File type select (file kind; labels Image, 3D model, Document, Other); active tag chips with remove; right-aligned result count ("3 assets") and "Clear filters" (shown only when a filter is set).
- **Grid tile** (fixed height for virtualisation, width 240): cover frame 240 × 180 (`object-contain` on `surface`); a band of 32 at the bottom of the frame with the image icon and the cover's file tags (one line, overflow as "+n" with all names in `title`); name (17/600, truncated); meta line "Type X  Status Y" plus workflow progress right-aligned (kept from today); label "Asset tags" and one line of asset tag chips ("+n" overflow). Tile height ≈ 320, columns from the available width as today. Selected tile: 2 px `accent` border.
- **Table view:** small cover, Name, Type, Status, Progress, Asset tags, Image tags (cover), Last change; one line per cell; same selection and opening rules.
- **Selection column:** title "Selection"; for the selected asset: name, Type, Status, "Asset tags" chips, "Cover image" thumbnail with its "Image tags", Files count, Projects (names from `assignments:listByAsset`, comma-separated, "–" when none), "Open asset" button. With no selection: only the title. Loading the project names shows a placeholder dash; failure shows an inline alert in the column.
- **Interaction:** click selects (single selection), double-click or Enter opens, "Open asset" opens. Arrow keys move focus and selection together (roving tabindex as today). The selected id is part of the list state; together with filters, scroll offset and the opened index it survives navigation (3a). The list state gains `query`, `tagNames`, `fileRole`, `fileKind`, `selectedId`.
- **States:** loading (placeholder tiles), empty library ("No assets" + "New asset" in the title row), no result ("No matching assets" + "Clear filters"), page failure (Retry slot as today), boot failure (Retry).

### Asset screen (03)

- **Header:** breadcrumb "Assets / *name*" ("Assets" is a link back to the gallery with its list state); name as a heading-sized inline edit field (today's `CommitInput`, borderless until hover or focus); "Type" select and "Status" select inline (both editable as today); right: "Import files" with a role select before it ("Import as" via tooltip, default Reference). Second line: description (inline multi-line edit, collapsed to one line until focused) and the asset `TagRow` (label "Asset tags", chips with remove, an inline input with placeholder "+ Add tag" and suggestions; Enter adds, Backspace in the empty input focuses the last chip, Delete on a chip removes it and keeps focus in the row).
- **Import results** appear as a dismissible strip under the header: "n imported, m failed" and the failed source names with their error (today's list, using `ALERT`).
- **Tabs** (`role="tablist"`, arrow keys switch, Tab moves into the panel): Files *n*, Workflow, Projects *n*, Relations *n*. Counts: files from an unfiltered `files:list` with `limit: 1`, projects and relations from the lists the tabs load anyway. The active tab survives navigation within the session.
- **Files tab:** `FileBrowser` with search ("Search files"), Role, Tags (file tags only; tooltip "Image tags"), File type; grid/table toggle; footer count. Tiles: thumbnail frame with a checkbox (top left) and a "…" menu (top right), a magnifier button on hover/focus that opens the detail dialog; name, meta line "Role · FORMAT · size", file tag chips; "Cover" badge on the effective cover. "…" menu: Details, Open externally (only when `openable`), Show in folder, Use as cover / Use automatic cover, Detach. Multi-select with the inbox's selection model and a selection bar (owner decision 1). Files are no longer grouped by role (the role is in the meta line and filterable), which removes the per-page grouping defect from the backlog.
- **Workflow tab:** today's `WorkflowSection` restyled: template choice and start, step list with state select and notes, progress, remove.
- **Projects tab:** today's assignment list: project link, priority, intended use, approval, notes (`AssignmentFields`), "Remove" (tooltip as today); "Add to project" with a project select.
- **Relations tab:** relation list (kind label, linked asset, "Remove"); add with kind select and the asset picker combobox.
- **States:** loading, not found (alert + breadcrumb), per-tab load errors inside the tab panel, empty tab content as a short status ("No files", "No relations").

### File detail dialog

- **Layout** (modal, `min(92vw, 1100px)` × `min(88vh, 760px)`): header with file name | asset name and a close icon button; left panel 320 wide: "Details" (file name, format, size, imported, status when not complete, error when failed), Role select (asset files) or the assign control (inbox: role select + asset picker + "Assign"), "Image tags" `TagRow` (complete files only), divider, "Asset" link and "Asset tags" (read-only chips) for asset files, and a "More" menu button (Open externally, Show in folder, Use as cover / automatic cover, Detach). Right: the detail preview (1024 px) fitted, or the format tile.
- **Keyboard:** focus starts on the close button; Esc closes and focus returns to the tile; Tab cycles inside the dialog. The keyboard hints of mockup 04 are not shown.

### Projects with Project details and Matching content (05)

- **Title row:** "Projects" + unfiltered count, "New project" → `Dialog` (name, description), creating and opening the project (as today).
- **Filters:** search ("Search projects": name and description), Status select, Tags combobox with chips, result count, "Clear filters".
- **Table:** Project (folder icon + name), Status, Assets, Matching tags (only while a tag filter is set: the selected tags, file-matched ones after an image icon), "Open". Row click selects (`accent` border), double-click, Enter or "Open" opens the project screen. Endless scrolling with virtualised rows replaces the pager; filters, scroll offset and selection survive navigation.
- **Project details column:** Name, Status, Assets, Images (complete image files of member assets), Description (read-only, wrapped). **Matching content** (only with a tag filter): the member assets that match, each with cover, name, Type, Status, "Asset tags" and "Image tags" (cover tags plus file tags that matched), matched chips with `accent` border; each entry links to the asset. First 20 shown, "Show all" opens the asset gallery filtered by project and tags.
- **Project screen** (not in the mockups, kept): breadcrumb "Projects / *name*", inline name, status, description; member table (cover, name, type, status, priority, approval, intended use, notes in an expandable row, "Remove"); "Add asset" combobox. Endless or paged as today (paging kept; out of scope to change).
- **States:** as the assets gallery; "No projects" / "No matching projects".

### Inbox with multi-select (06)

- **Title row:** "Inbox" + unfiltered count, "Import files" (import into the inbox; result strip with imported, failed, duplicates as today).
- **Filters:** search ("Search files"), File type, Tags (tooltip "Image tags"), grid/table toggle, count, "Clear filters". Filters and scroll offset survive navigation; the selection does not.
- **Grid:** `FileBrowser` tiles with checkbox, name, "FORMAT | size", file tag chips. Pending and failed imports show their status in the frame (failed in `danger`); their error is shown in the dialog and the Selection column.
- **Selection model** (shared with the asset Files tab): click selects only this file; Ctrl+click toggles; Shift+click selects the range; checkbox and Space toggle the focused file; Ctrl+A selects the whole result (missing pages are loaded first; capped at 1000 with a tooltip on the count); Esc clears. Enter or the magnifier opens the detail dialog. `aria-multiselectable` listbox semantics; selected tiles have an `accent` border and a checked box.
- **Selection bar** (above the grid, only with ≥ 1 selected): "*n* selected", "Add tags" (moves focus to the shared tag input in the column), "Clear selection".
- **Selection column:** "Selection", "*n* files" (or "*n* images" when all are images); "Shared image tags" = tags every selected complete file carries (removing one removes it from all; "+ Add tag" adds to all); "Assign to asset": asset combobox, Role select, "Assign *n* files"; the list of selected file names (with a failed marker and the error as `title`). Failed or pending files in the selection are excluded from tagging and assigning; the button text counts only eligible files. After a batch, failures are listed per file in the column; successful files leave the inbox list.
- **States:** loading, empty inbox ("Inbox is empty" + "Import files"), no result, page failure Retry, storage unreachable banner.

## Contract and backend changes

Checked against `packages/contracts/src` and the 3b design. Already present and used as is: `WorkspaceSummary.lastOpenedAt`, `AssetSummary.fileCount`/`projectCount`/`coverFileId`, `ProjectSummary.assetCount`, `AssetDetail.tags`, `FileRecord.tags`/`kind`, `tags:suggest`, `assets:addTag/removeTag`, `files:addTag/removeTag`, `assets:list` with `query`, `tagNames`, `fileRole`, `fileKind`, `assignments:listByAsset`. Counts for titles and tabs use `total` of a `limit: 1` call; no count channel. **No migration is needed:** every new filter uses the 3b tables and indexes (`asset_tag`, `file_tag(tag_id)`, `file(asset_id, kind)`).

```ts
type MatchedTag = { name: string; displayName: string; onAsset: boolean; onFiles: boolean };
```

1. **`assets:list` items** gain `tags: TagAssignment[]` (asset tags) and `coverTags: TagAssignment[]` (tags of the effective cover file, `[]` without cover); when the request has `tagNames`, also `matchedTags: MatchedTag[]` (one per requested tag: whether it was satisfied by the asset itself and/or by a complete file). Tags are attached with one batched query per page.
2. **`files:list` request** gains `query?: string` (≤ 200; every word from `searchWords` must be a case- and diacritic-folded substring of the original name or a prefix of one of the file's tag names), `tagNames?: string[]` (≤ 10, normalised; every tag must be on the file itself), `role?: FileRole`, `kind?: FileKind`. All scopes; filters restrict within the scope's index range, no FTS for files. Unknown tag → empty page.
3. **`projects:list` request** gains `query?` (case-insensitive substring of name or description), `status?: ProjectStatus`, `tagNames?` (a project matches when at least one member asset matches all tags with the `assets:list` semantics — owner decision 2). Items gain `imageCount: number` (complete files of kind `image` over member assets) and, with `tagNames`, `matchedTags: MatchedTag[]` aggregated over matching members. Pickers keep calling it without filters.
4. **Matching content** uses `assets:list { projectId, tagNames, limit: 20 }` — no new channel.
5. **`files:assignMany`** `{ fileIds: uuid[] (1–1000, unique), assetId, role }` → `{ items: { fileId: string; file: FileRecord | null; error: IpcError | null }[] }` in request order. Core loops over the existing assign use case (each file is a journaled move, so no shared transaction); one failure does not stop the rest; errors follow the usual code/message rules.
6. **`files:addTagMany` / `files:removeTagMany`** `{ fileIds: uuid[] (1–1000, unique), name }` → `{ items: FileRecord[] }`. One transaction, all or nothing; any unknown file → `not_found`, any non-complete file → `validation_failed`; each affected asset is reindexed once.

Why batch channels rather than renderer loops over the single-item channels: a loop costs one IPC round trip, one transaction and one reindex of the target asset per file (the asset's file-name column is rebuilt every time, quadratic for a large asset), and leaves partial-failure bookkeeping to the renderer. The batch channels keep one round trip, one reindex per asset and a typed per-item result. Cost: three channels and their tests.

Not changed: `workspace:*` (last opened exists), `assets:get` (tab counts come from list totals), the media protocol.

## Testing

- **Contracts and IPC (desktop, Electron Node):** schema tests for the extended requests and responses; `library-ipc.test.ts` cases for the new filters, limits (11 tag names, 1001 file ids, duplicate ids → `invalid_request`) and the batch channels.
- **Core (fakes):** `files:list` filters (name substring with folding, tag prefix, tag filter on the file only, role, kind, per scope); `projects:list` filters and `matchedTags`; `imageCount`; `assignMany` with one failing file in the middle; tag batches all-or-nothing.
- **Persistence:** the same cases on SQLite; `EXPLAIN QUERY PLAN` for `files:list` in the inbox and asset scope and for `projects:list` with tags: no full scan of `file`, `asset`, `file_tag` or `asset_tag`; tag attachment for list items is one query per page.
- **Renderer DOM tests — introduce now (recommended).** `apps/desktop` gets a second Vitest project for `test/renderer/**/*.test.tsx` with `jsdom`, `@testing-library/react` and `@testing-library/user-event`; `window.assetForge.invoke` is replaced by a typed fake; `ResizeObserver` and element sizes are stubbed so the virtualiser renders. Covered: debounce and superseding (fake timers: only the last query's page is shown, old results stay until then), list state round trip incl. selection, tag row keyboard (add on Enter, Backspace, Delete keeps focus), selection model (click, Ctrl, Shift, Space, Ctrl+A cap, Esc), shared-tag computation, eligible-file counting, menus and dialog focus return, empty/no-result/error states, asset vs. file tag distinction in tiles, Selection column and dialog. This also closes the backlog items "no DOM test environment" and "no DOM test for gallery, dialog, keyboard".
- **End to end on the built app (manual checklist):** every screen against its mockup; every feature that exists today once (nothing lost in the new layout); tag an asset and a file, filter by both; select three inbox files, tag and assign them; restart and verify.

## Owner decisions

Decided by the owner on 2026-11-25; they bind the plan.

1. **Multi-select in the asset Files tab: yes.** The same `FileBrowser` selection as the inbox, with a selection bar offering "Add tags", "Set role" and "Detach" (role via `files:assignMany` with the same asset), no right column.
2. **Several tags are AND-combined on the found object.** A project matches a tag filter only when one member asset matches all selected tags (with the `assets:list` semantics: a tag counts when it is on the asset or on one of its complete files); tags spread over several assets of a project do not match. "Matching content" lists exactly the assets that explain the match. A file list filtered by tags requires all tags on the file itself.
3. **A single click selects** an asset tile or project row; opening is by double-click, Enter or the "Open" button.
4. **Endless scrolling everywhere:** the file grids (asset Files tab, inbox) and the project list use the gallery's virtualised loader instead of pagers; the project screen's member list keeps its pager for now.
5. **Inline editing** on the asset and project screens (name, type, description as borderless fields that look like static text until hover or focus); no separate "Edit" dialog.

## Follow-up: image viewer

A separate step after this phase turns the file detail dialog into the viewer of mockup 04: Fit / 100 % / zoom steps with a percentage, rotate (view only), fullscreen, previous/next within the current filtered file list with "1 / 4", a film strip of thumbnails, and keyboard shortcuts (←/→ browse, +/− zoom, Esc close) explained by tooltips. It needs the original or a larger preview size through a bounded, protocol-served path (never `file://`), and image dimensions in pixels, which means storing width and height on the file row (a migration plus a derived-data backfill) or reading them in the preview worker. The left details panel of this phase stays as it is and gains "Dimensions".

## Left to the builder

Exact tile and row heights within the token grid, skeleton appearance, the order of menu items, the combobox implementation (ARIA 1.2 pattern required), how the batch results strip is dismissed, the virtualised row height of the projects table, and the folding function used by the fakes for the file name match.
