# Phase 3b – Tags and Search: Design

Second half of phase 3 (`ReadMe.md` §6.1, §6.2, §10, §15.1, §17). Builds on phase 3a (`2026-11-25-phase-3a-gallery-previews-design.md`), which must be merged first.

## Intent

A library is only useful if things can be found again. Phase 3b adds the words people search by — tags on assets and files — and one search field over the gallery that finds assets by name, description, tags and file names, combined with filters, fast enough for a large library. Tags are built so that AI analysis (phase 4) can add its own without ever touching what a person entered.

## Acceptance criterion (ReadMe §17, part covered by 3b)

Search a large library: with ten thousand assets, typing a word narrows the gallery to the matching assets without a noticeable wait and without scanning every row.

## Goals

- **Tags.** Normalised tags with a display name; assignable to assets and to files; each assignment records its origin (`manual` or `ai`). Phase 3b only creates manual assignments.
- **Tag editing.** Add and remove tags on the asset screen and in the file detail dialog, with suggestions from tags already in use.
- **Full-text search** over asset name, asset description, the tags of the asset, and the original names and tags of its files. Prefix matching per word, all words must match, results ranked with name matches first.
- **Filters** combined with the search: project, asset type and asset status (existing), plus tags (every selected tag must be present on the asset itself or on at least one of its complete files — the filter does not distinguish where a tag sits), file role and file kind ("has at least one file with …").
- **File kind.** Every file gets a kind — `image`, `model`, `document`, `other` — derived from its extension by one function in `core`, stored on the row.
- **Index consistency.** The search index can always be rebuilt from the tables and repairs itself when it is out of date.
- **No programs in the library.** Importing a program, installer or shortcut is refused; "Open externally" is offered only for files of a known asset kind (an allow-list replacing the block list of phase 3a).

## Non-goals

- AI tags, tag suggestions from analysis, review status (phase 4). Only the `origin` column exists.
- Search over prompts (phase 5) and semantic search (phase 7).
- Renaming, merging or deleting tags as objects; tag hierarchies, colours, categories.
- Searching files as results of their own; inbox files are found through the inbox list as before. A file's name and tags lead to its asset.
- Saved searches, search history, query syntax for users (quotes, OR, NOT).
- Bulk tagging of several assets at once.

## Anti-goals

- User input being interpreted as FTS5 query syntax (errors or surprising results from a typed `"` or `-`).
- A search result that disagrees with the tables after any sequence of edits, moves or a crash.
- Removing or re-running an AI analysis later being able to delete a manual tag.
- A query path that reads all assets to answer one search.

## Constraints

- All constraints of phases 1 to 3a hold, including the UI rules.
- One Drizzle migration (`0004`). The FTS5 table is not expressible in the Drizzle schema; it is created by hand-written SQL inside that migration.
- Search requests from the renderer are debounced (250 ms) and paginated; a newer request supersedes an older one.

## Approaches

**Keeping the index in step with the data**

1. **One `reindexAsset(assetId)` in the persistence adapter, called inside every transaction that changes something searchable — chosen.** The index row of an asset is recomputed from the tables, so there is one definition of "what is searchable"; a rebuild is the same function over all assets; a PostgreSQL adapter can do the same later with its own index.
2. SQLite triggers. Rejected: the aggregated tag and file-name columns need triggers on five tables, written in migration SQL that no test of the domain layer sees, and nothing carries over to PostgreSQL.
3. An external-content FTS table over `asset`. Rejected: tags and file names are not columns of `asset`.

**Tag assignments and origin**

1. **Primary key (`owner`, `tag`, `origin`) — chosen.** The same tag can be present once manually and once from AI; removing every AI assignment of an asset is a delete by origin that cannot hit a manual row.
2. One row per (`owner`, `tag`) with an origin column. Rejected: a manual tag that AI also suggests needs merge rules, and those are where manual tags get lost.

**File kind**

1. **A stored column set at import; existing rows are filled when the workspace is opened — chosen.** Filterable with an index, and the extension list exists once, in `core`, instead of a second time in migration SQL.
2. Derive from the extension in every query. Rejected: string matching on names per row.

## Design

**Data model (migration `0004`).**

- `tag` — `id`, `name` (normalised, unique), `display_name`, `created_at`.
- `asset_tag` — `asset_id`, `tag_id`, `origin` (`manual` | `ai`), `created_at`; primary key over the first three; index on `tag_id`.
- `file_tag` — the same for `file_id`.
- `file.kind` — `image` | `model` | `document` | `other`, not null, default `other`; index on (`asset_id`, `kind`). The migration only adds the column; the values of existing rows are set by the derived-data step below.
- `asset_search` — FTS5 table with the columns `name`, `description`, `tags`, `file_names`; tokenizer `unicode61` with diacritics removed, prefix indexes for 2 and 3 characters.
- `asset_search_map` — `rowid` (integer primary key, the rowid of the FTS row) and `asset_id` (unique, references `asset.id`). Reindexing finds the FTS row of an asset through this table instead of scanning the index; searching joins match → map → `asset` by primary key.
- `workspace.derived_data_version` — nullable integer, the stamp of the derived-data step. (There is no key/value meta table; the `workspace` row is the place for workspace-wide values.)

**Tag normalisation.** Trim, collapse inner whitespace to one space, Unicode NFC, lower case. Empty after trimming or longer than 64 characters → `validation_failed`. The display name is the form entered first; later entries of another casing reuse the existing tag. A tag row stays when its last assignment is removed; suggestions only offer tags that are in use.

**File kinds by extension.** `image`: png, jpg, jpeg, webp, tif, tiff, gif, avif, bmp, exr, hdr, tga, psd, svg. `model`: blend, glb, gltf, fbx, obj, stl, ply, usd, usda, usdc, usdz, dae, abc, ztl, spp, sbs, sbsar. `document`: pdf, txt, md, doc, docx, odt, rtf. Everything else — including names without an extension — is `other`; the extension is compared in lower case. `core` computes the kind at import and passes it to the repository. The kind says nothing about whether a preview exists (3a decides that by MIME type).

**Refused imports.** A file whose extension is one of `exe`, `com`, `scr`, `msi`, `msp`, `msix`, `appx`, `appinstaller`, `bat`, `cmd`, `ps1`, `psm1`, `psd1`, `vbs`, `vbe`, `jse`, `wsf`, `wsh`, `ws`, `wsc`, `sct`, `hta`, `cpl`, `dll`, `sys`, `lnk`, `url`, `pif`, `reg`, `jar`, `app`, `dmg`, `pkg`, `appimage`, `iso`, `vhd` is not imported: the import of that file fails with `validation_failed` and a message naming no path, nothing is written to the workspace, and the other files of the same import are unaffected. The extension is taken as for `isOpenable` (lower case, trailing dots and spaces removed, last extension counts). Scripts and markup that belong to asset pipelines (`py`, `js`, `sh`, `html`, `svg`, …) stay importable. Rows that exist already are not touched. The list lives once in `core`, next to the kinds.

**Open externally by allow-list.** `isOpenable` becomes: the file's kind is `image`, `model` or `document`, and its extension is not `svg` (an SVG can carry script and opens in a browser). Everything else — kind `other`, which includes every script and every file without an extension — offers only "Show in folder". The block list of phase 3a is removed; its tests are replaced by tests of the allow-list and of the refused-import list.

**Use cases and IPC.** `tags:suggest { prefix, limit }` (tags in use, by normalised prefix, most used first); `assets:addTag` / `assets:removeTag { assetId, name }`; `files:addTag` / `files:removeTag { fileId, name }`. Adding an existing assignment and removing a missing one are no-ops. Asset detail and file records carry their tags (display name, origin). `assets:list` gains `query` (replacing `nameContains`), `tagNames[]` (at most 10, normalised like tags; an unknown tag yields no results; each tag matches when the asset carries it or one of its complete files does, and different tags may be satisfied by different owners), `fileRole`, `fileKind`. The role and kind filters each mean "has at least one complete file with …" and are independent of each other.

**Search behaviour changes from phase 2.** The name filter matched any substring; the search matches the beginnings of words. "swo" finds "Sword", "ord" no longer does. This is intended: it is what makes the index usable and the ranking meaningful.

**Searching.** The query text is split into words at every character that is not a letter, digit or combining mark — the same boundaries the tokenizer uses, so "sci-fi" searches for `sci` and `fi` and finds the tag "sci-fi". Each word is quoted and given a trailing `*`; the words are AND-combined; at most 16 words are used. A query with no words behaves like no query. With a query, results are ordered by BM25 with the name column weighted highest, then by name; without one, by name as today. Filters are ordinary indexed predicates joined to the match. Every search is one page (60) plus a total. The search path is hand-written SQL in the persistence adapter (Drizzle cannot express FTS5), with the total as a second statement over the same match and filters; the path without a query stays as it is today.

**Reindexing.** Only complete files contribute their names and tags. `core` has no transaction abstraction and gets none: each repository method that changes something searchable calls the shared, adapter-internal `reindexAsset` inside the transaction it already opens. These are: asset insert and update; adding or removing an asset tag; adding or removing a tag on a file that belongs to an asset; a file's placement changing (the asset it left and the asset it joined — also when a move intent is committed, during use or during repair on open); a file that belongs to an asset becoming complete. Asset type and status are not indexed; assets cannot be deleted yet. The in-memory fakes keep no index and compute search results from their tables.

**Derived-data step on open.** After migrations and the built-in types and templates, while the workspace is not yet available to the renderer: if `derived_data_version` is missing or differs from the constant in the adapter, every file's kind is recomputed from its name, the index and its map are emptied and rebuilt in batches of 500 assets (one transaction per batch), and the stamp is written last. An interrupted run leaves the old stamp and repeats on the next open. This is also how rows that existed before `0004` get their kind and their index entry; changing the extension list or the index definition later means raising the constant.

**Renderer.**

- *Assets screen:* the name filter becomes the search field; next to the existing filters a tag filter (type to add, chips to remove), a file role select and a file kind select. All of it is part of the list state that survives navigation (3a), and it applies to the grid and the table view alike; search results scroll endlessly like the unfiltered list.
- *Asset screen:* a tag row under the fields — chips with a remove control, an input that adds on Enter and offers suggestions. AI-origin tags will render differently in phase 4; the component takes the origin already.
- *File detail dialog:* the same tag row for the file.
- Wherever tags of an asset and tags of its files appear together, the two are visually distinguishable (asset tags and file tags never share one undifferentiated row). There is no control for choosing which of the two the tag filter looks at.
- Everything is reachable by keyboard; removing a chip keeps focus in the row.

## Testing

- Persistence: migration `0004` on a phase 3a database, tag uniqueness by normalised name; manual and AI assignment of the same tag coexist and a delete by origin leaves the other; every reindex trigger listed above (search finds the asset before, not after, and the reverse); the derived-data step on a missing or outdated stamp yields the same index as the incremental path, sets file kinds, and repeats after an interruption; hostile query strings (`"`, `*`, `-`, `NEAR`, `:`, only punctuation, very long) neither throw nor match wrongly; diacritics and case folding; prefix matching; ranking puts a name match before a description match.
- Scale: a synthetic workspace with 10 000 assets and tags — with a query, the plan of the search statement is driven by the FTS match and reaches `asset`, tags and files only through indexes, with no full scan of any of those tables (asserted via `EXPLAIN QUERY PLAN`), and its measured time is printed; no time threshold is asserted (ReadMe §15.4: targets after baseline measurements).
- Core: a refused extension fails only its own file and leaves no row, no staging file and no path in the error (including `Setup.EXE.`, `a.txt.exe`, `.bat`); `isOpenable` by kind (`a.exe.txt` is a document and openable, `a.svg`, `a.py` and a name without extension are not).
- Core: normalisation rules, no-op semantics, validation; the fakes implement the same search semantics for words and filters.
- Desktop: IPC contract tests for the new channels and the extended `assets:list`.
- End to end on the built app: tag an asset and a file, find the asset by tag, by file name and by a prefix, combine with filters, rename the asset and find it under the new name only, restart and find it again.

## Left to the builder

The exact FTS5 column weights, how the debounce and request superseding are implemented, the suggestion list presentation, and how the in-memory fakes approximate ranking.
