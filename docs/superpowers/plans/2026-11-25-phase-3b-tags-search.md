# Phase 3b – Tags and Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the library findable: normalised tags with origin on assets and files, a stored file kind, one full-text search over asset name, description, tags and file names combined with project/type/status/tag/file-role/file-kind filters, an index that rebuilds itself, refused program imports and "Open externally" by allow-list. Contracts, use cases, persistence and IPC are complete; the renderer only follows the `nameContains` → `query` rename (screens come in a separate UI phase).

**Architecture:** `core` owns the extension lists (`fileKind`, `isRefusedImport`, `isOpenable`), tag normalisation (shared from `contracts` so a later renderer normalises the same way), query word splitting, the tag use cases and the new `TagRepository` port. The SQLite adapter keeps one FTS5 table `asset_search` (hand-written SQL in migration `0004`) plus a map table, recomputed per asset by one adapter-internal `reindexAsset(tx, assetId)` that every searchable write calls inside its own transaction. A derived-data step on open recomputes kinds and rebuilds the index when the stamp on the `workspace` row is missing or outdated. The search path is hand-written SQL driven by the FTS match; the path without a query stays the existing Drizzle query. The in-memory fakes keep no index and compute the same semantics from their tables.

**Tech Stack:** unchanged. SQLite FTS5 as compiled into the better-sqlite3 prebuild (verified in Task 2). No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-25-phase-3b-tags-search-design.md`

**Branch:** `phase-3b-tags-search` (exists).

**Models:** each task names the model for its implementer subagent. Task reviewers run on `sonnet`, except Tasks 5, 6 and 7 (`opus`). The final whole-branch review runs on the most capable model.

## Plan decisions

Decisions on what the spec leaves open, and on places where spec and code disagree.

1. **Scope: no renderer screens.** The search field, filter controls and tag rows (spec "Renderer" section, goal "Tag editing" in its UI part, the "visually distinguishable" rule) are built in a separate UI phase after a redesign. This plan changes the renderer only so that it compiles and keeps working after `nameContains` becomes `query`: the existing name field and the asset picker send `query`. The backend keeps asset tags (`AssetDetail.tags`) and file tags (`FileRecord.tags`) in separate fields so the UI can always tell them apart. The spec's end-to-end bullet is covered by an acceptance test on the real adapters through the IPC handlers (Task 8); the UI part of it moves to the UI phase.
2. **FTS5 weights:** `bm25(asset_search, 10.0, 1.0, 4.0, 2.0)` for `name`, `description`, `tags`, `file_names`, ascending (lower is better), then `lower(asset.name)`, then `asset.id`.
3. **FTS5 table kind:** a regular (content-storing) FTS5 table, `rowid` taken from `asset_search_map.rowid`. Reindexing deletes the FTS row by rowid and inserts it again with the same rowid; a new asset first inserts its map row and uses the returned rowid.
4. **Migration `0004` and drizzle-kit:** `asset_search_map`, `tag`, `asset_tag`, `file_tag`, `file.kind`, the `(asset_id, kind)` index and `workspace.derived_data_version` are in `schema.ts` and generated. The `CREATE VIRTUAL TABLE asset_search …` statement is appended by hand to the generated `0004_*.sql` after a `--> statement-breakpoint` line, as `0003` already does for its `UPDATE`. drizzle-kit's journal stores only tag, timestamp and the breakpoint flag, so it is unaffected; the `0004` snapshot describes `schema.ts` only, so the virtual table and its shadow tables (`asset_search_data`, `_idx`, `_content`, `_docsize`, `_config`) are invisible to drizzle-kit, and because drizzle-kit diffs snapshot against schema (never against a live database) a later `db:generate` neither recreates nor drops them. Verified in Task 2 by a second `db:generate` that reports no changes. Any later change to the FTS definition is again hand-written SQL in a new migration plus a raised `DERIVED_DATA_VERSION`.
5. **No CHECK constraint on `file.kind`.** Adding a check to the existing `file` table makes drizzle-kit rebuild the table. The kind is written only by `core`'s `fileKind` and read back through `FileKindSchema`. New tables (`asset_tag.origin`, `file_tag.origin`) do get CHECKs with the existing `oneOf` helper. If `db:generate` still emits a `__new_file` table rebuild, the schema change is wrong — fix it rather than accept the rebuild.
6. **Refused-import extension:** `importExtension(name)` = remove trailing dots and spaces, lower case, text after the last dot, where a leading dot counts (`.bat` → `bat`). This differs from `diskExtension`, which treats a dot-only-prefixed name as extensionless; the spec's `.bat` case needs the difference. The check runs in `importFile` on the last segment of `sourcePath` (split on `/` and `\`), before `sources.open`, so nothing is opened, no row exists, nothing is staged.
7. **Refused-import result:** `ImportResult` has no error code field and gets none. A refused file yields `{ sourcePath, file: null, error: REFUSED_IMPORT_MESSAGE, duplicateOf: [] }` where the message is the message of a `ValidationFailedError` (`'This file type cannot be imported'`), a constant with no path.
8. **Kind source:** the stored `file.kind` is `fileKind(originalName)`. `isOpenable(relativePath)` keeps its signature and evaluates the on-disk name (`fileKind(diskName(path)) !== 'other'` and the disk extension is not `svg`), because the shell opens the disk file. Sanitising keeps extensions, so both agree for every importable name.
9. **Tag normalisation lives in `contracts`** (`normalizeTagName(input): string | null`, pure, no dependencies) so a later renderer can use it; `core` wraps it and throws `ValidationFailedError` on `null`. Length is counted in code points after normalisation. `normalizeTagPrefix(input)` applies the same steps without validation (and returns `''` for whitespace).
10. **Tag filter semantics** (spec, revised): each selected tag matches when the asset carries it or at least one of its **complete** files does, in any origin; different tags may be satisfied by different owners; there is no switch between asset and file tags. Unknown normalised name → empty page without running the list query. Duplicate names after normalisation count once.
11. **Search words:** `searchWords(query)` splits on `/[^\p{L}\p{N}\p{M}]+/u`, NFC, lower case, drops empties, keeps the first 16. The adapter builds the MATCH string as `"w1"* AND "w2"*` (each word's `"` doubled, although the split already removes it). No words → the no-query path.
12. **Fake ranking:** a word matches a field when some token of the field (same split, folded by NFD + removing `\p{M}` + lower case) starts with the folded word; an asset matches when every word matches some field. Order: assets where every word matches a name token first, then `byNameThenId` as today. The fakes approximate BM25 only by this two-bucket rule; tests that compare fakes and SQL use data where both orders agree.
13. **Suggestions:** `tags:suggest { prefix, limit }` returns `{ name, displayName }[]` of tags with at least one assignment (any owner, any origin), `name >= prefix AND name < prefix || U+10FFFF` (binary collation, uses the unique index), ordered by use count descending, then name. An empty prefix lists the most used tags.
14. **Use case results:** `assets:addTag`/`removeTag` return the `AssetDetail`; `files:addTag`/`removeTag` return the `FileRecord`. Unknown asset or file → `not_found`; a file that is not `complete` → `validation_failed`. Removal deletes only the `manual` assignment; an `ai` assignment of the same tag stays.
15. **Derived-data step seam:** the port is `WorkspaceDatabase.ensureDerivedData(): Promise<void>`, called by `WorkspaceManager.doOpen` right after `ensureBuiltInWorkflowTemplates`. The adapter constant is `DERIVED_DATA_VERSION = 1`, batch size 500. `openWorkspaceDatabase` gains an optional third parameter `{ derivedData?: { batchSize?: number; afterBatch?(batchIndex: number): void } }`, used only by tests to force small batches and simulate an interruption (a throwing `afterBatch`). The index is emptied in its own transaction before the first batch.
16. **Reindex call sites** (each inside the transaction the method opens; methods that did not open one get one): `assets.insert`, `assets.update`, `tags.addToAsset`, `tags.removeFromAsset`, `tags.addToFile` / `removeFromFile` when the file has an asset, `files.setPlacement` (old asset read before the update, then old and new), `fileMoves.commit` (old and new; this is also the repair-on-open path through `recoverFileMoves`), `files.markComplete` and `files.markFailed` when the row has an asset.
17. **Temporary bridge:** Task 4 renames `nameContains` to `query` everywhere; until Task 5 replaces it, the SQL adapter answers `query` with the old name substring `LIKE`. Task 5 rewrites the persistence tests of that bridge to prefix semantics.
18. **Debounce and superseding** (spec constraint) belong to the renderer and move with it to the UI phase; the existing `PagedLoader` already drops answers for an outdated key.

## Global Constraints

- Everything in the repository is English. Commit messages follow the existing style (`feat(core): …`, `feat(persistence): …`, `test(persistence): …`, `docs: …`), no attribution lines. Every commit is followed by `git push` of `phase-3b-tags-search`.
- `core` and `contracts` never depend on Electron or a concrete database. Renderer and preload hold no persistence logic. IPC handler modules stay free of Electron imports.
- `AssetForgeError` messages that reach the renderer never contain absolute paths or cause messages; this includes import results of refused files.
- Exactly one migration: `0004`. The FTS5 table is hand-written SQL appended to the generated file (Plan decision 4).
- Kind lists (one constant in `core`): `image`: png, jpg, jpeg, webp, tif, tiff, gif, avif, bmp, exr, hdr, tga, psd, svg. `model`: blend, glb, gltf, fbx, obj, stl, ply, usd, usda, usdc, usdz, dae, abc, ztl, spp, sbs, sbsar. `document`: pdf, txt, md, doc, docx, odt, rtf. Everything else, including no extension, is `other`.
- Refused import extensions (one constant in `core`, next to the kinds): `exe`, `com`, `scr`, `msi`, `msp`, `msix`, `appx`, `appinstaller`, `bat`, `cmd`, `ps1`, `psm1`, `psd1`, `vbs`, `vbe`, `jse`, `wsf`, `wsh`, `ws`, `wsc`, `sct`, `hta`, `cpl`, `dll`, `sys`, `lnk`, `url`, `pif`, `reg`, `jar`, `app`, `dmg`, `pkg`, `appimage`, `iso`, `vhd`.
- `isOpenable`: kind `image`, `model` or `document` and extension not `svg`. `BLOCKED_OPEN_EXTENSIONS` is removed.
- Tag names: trim, collapse inner whitespace to one space, NFC, lower case; empty or more than 64 code points → `validation_failed`. Display name = first-entered form. Tag rows are never deleted.
- `asset_search`: columns `name`, `description`, `tags`, `file_names`; `tokenize = 'unicode61 remove_diacritics 2'`; `prefix = '2 3'`. Only complete files contribute names and tags. Asset type and status are not indexed.
- Search: at most 16 words, each quoted with a trailing `*`, AND-combined; page of at most 60 (the existing `PageRequestSchema` limit still applies) plus a total from a second statement over the same match and filters.
- `assets:list`: `query` replaces `nameContains` everywhere (contracts, core, fakes, persistence, handlers, renderer, tests); `tagNames` at most 10.
- Existing features keep working: grid and table view, endless scrolling, list state across navigation, the project/type/status filters, the asset picker.
- Commands: `pnpm test`, `pnpm typecheck`, single test `pnpm --filter @assetforge/<pkg> test <file> -t "<name>"` (no `--`), `pnpm --filter @assetforge/desktop build`, `pnpm --filter @assetforge/persistence db:generate`. Tests in `packages/persistence` and `apps/desktop` run under Electron's Node.
- Implementers do not launch the app, except one short smoke check where a task changes the renderer (only Task 4): build, then from `apps/desktop` run `env -u ELECTRON_RUN_AS_NODE npx electron . --user-data-dir=<fresh temp dir>`, check each listed thing once, close it. Never trigger "Open externally".
- Do not commit or delete the untracked `docs/design/` folder.
- Each task ends with `pnpm test` and `pnpm typecheck` green in the whole repository, then a commit and a push.

## Review Focus

1. A disguised program (`Setup.EXE.`, `a.txt.exe`, `.bat`) in a multi-file import → only that file fails with the fixed message, no row, no staging file, no path in the message, the other files are imported. (Task 1: `a refused extension fails only its own file and leaves nothing behind`)
2. Typed FTS syntax (`"`, `*`, `-`, `NEAR`, `:`, only punctuation, 200 characters) → never throws, never matches anything the plain words would not. (Task 5: `hostile query strings neither throw nor match wrongly`)
3. A file moved between assets, including a move intent committed during repair on open → the old asset is no longer found by the file's name or tags, the new one is. (Task 5: `a committed file move reindexes both assets`; `placement change reindexes the asset left and the asset joined`)
4. An interrupted rebuild → the stamp stays old, the next open completes it, and the result equals the index built incrementally. (Task 6: `an interrupted rebuild keeps the old stamp and completes on the next run`)
5. A manual tag and an AI assignment of the same tag → both coexist; removing the manual one through the use case or deleting by origin `ai` never touches the other. (Task 3: `manual and ai assignments of one tag coexist and a delete by origin leaves the other`)

---

### Task 1: File kinds, refused imports and "Open externally" by allow-list

**Model:** sonnet

**Files:**
- Modify: `packages/core/src/media-types.ts`, `packages/core/src/import-file.ts`, `packages/core/src/index.ts`, `packages/contracts/src/files.ts`
- Test: `packages/core/test/media-types.test.ts`, `packages/core/test/import.test.ts`, `apps/desktop/test/file-shell-ipc.test.ts` (adjust only what the allow-list changes)

**Interfaces:**
- Consumes: `diskExtension`, `diskName`, `importFile`, `ValidationFailedError`.
- Produces:

```ts
// packages/contracts/src/files.ts
export const FileKindSchema: z.ZodEnum<['image', 'model', 'document', 'other']>;
export type FileKind = z.infer<typeof FileKindSchema>;
// packages/core/src/media-types.ts
export const FILE_KIND_EXTENSIONS: Readonly<Record<Exclude<FileKind, 'other'>, readonly string[]>>;
export const REFUSED_IMPORT_EXTENSIONS: readonly string[];
export function fileKind(fileName: string): FileKind;            // via diskExtension
export function importExtension(fileName: string): string | null; // leading dot counts (Plan decision 6)
export function isRefusedImport(fileName: string): boolean;
export function isOpenable(relativePath: string): boolean;        // signature unchanged, allow-list
// packages/core/src/import-file.ts
export const REFUSED_IMPORT_MESSAGE: string; // 'This file type cannot be imported'
```

- [ ] **Step 1: Write the failing tests** in `media-types.test.ts`, replacing the block-list tests:
  - `FILE_KIND_EXTENSIONS and REFUSED_IMPORT_EXTENSIONS match the spec` — `toEqual` on the exact lists from Global Constraints.
  - `fileKind by extension` — `a.PNG` → image, `scene.blend` → model, `a.exe.txt` → document, `a.py`, `README`, `a.` → other.
  - `importExtension takes the last extension and counts a leading dot` — `Setup.EXE.` → `exe`, `a.txt.exe` → `exe`, `.bat` → `bat`, `run.Bat ` → `bat`, `README` → null.
  - `isRefusedImport` — true for `Setup.EXE.`, `a.txt.exe`, `.bat`, `x.appimage`; false for `a.py`, `a.js`, `a.sh`, `a.html`, `a.svg`, `a.exe.txt`.
  - `isOpenable by kind` — `inbox/x_a.exe.txt` true, `assets/a/working/x_scene.blend` true, `inbox/x_a.svg`, `inbox/x_a.py`, `inbox/x_README`, `inbox/x_a.zip` false; case and trailing dots/spaces still normalised (`inbox/x_Photo.PNG.` true).
- [ ] **Step 2: Write the failing import tests** in `import.test.ts`:
  - `a refused extension fails only its own file and leaves nothing behind` — import `['/src/Setup.EXE.', '/src/a.txt.exe', '/src/.bat', '/src/ok.png']` through the manager (`importFiles`) on the fakes: the three results have `file: null`, `error === REFUSED_IMPORT_MESSAGE`, no result error contains `/src`; `ok.png` is complete; the file repository holds exactly one row; the fake storage has no staging entry; the fake source `open` was never called for the refused names (count calls in `FakeSourceFiles`).
  - `importFile refuses before opening the source` — direct `importFile` call with a refused name: `sources.open` not called, `files.insertPending` not called.
- [ ] **Step 3: Run** both test files and confirm they fail for the expected reasons.
- [ ] **Step 4: Implement.** Add `FileKindSchema` to `contracts/src/files.ts` (no `FileRecord` change yet). In `media-types.ts` add the lists and functions, rewrite `isOpenable` (`fileKind(diskName(p)) !== 'other' && diskExtension(diskName(p)) !== 'svg'`), remove `BLOCKED_OPEN_EXTENSIONS`. In `importFile` check `isRefusedImport(lastSegment(sourcePath))` first and return the refused result. Export the new names from `core/src/index.ts`.
- [ ] **Step 5: Fix** tests that relied on the block list (`file-shell-ipc.test.ts` and any test that expects a `.zip` or `.html` to be openable); keep the intent of each test, use an allowed or refused name as appropriate.
- [ ] **Step 6: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 7: Commit and push** — `feat(core): file kinds, refused imports and open-externally allow-list`.

---

### Task 2: Migration 0004

**Model:** sonnet

**Files:**
- Modify: `packages/persistence/src/schema.ts`
- Create: `packages/persistence/migrations/0004_*.sql` (generated, then appended), `migrations/meta/0004_snapshot.json`, journal entry (both generated)
- Test: `packages/persistence/test/native-module.test.ts`, `packages/persistence/test/migration-0004.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Drizzle tables in `schema.ts`):

```ts
tag            { id text pk, name text not null unique, displayName text not null, createdAt text not null }
assetTag       { assetId → asset.id, tagId → tag.id, origin 'manual'|'ai' (CHECK), createdAt; pk(assetId, tagId, origin); index(tagId) }
fileTag        { fileId → file.id, tagId → tag.id, origin 'manual'|'ai' (CHECK), createdAt; pk(fileId, tagId, origin); index(tagId) }
assetSearchMap { rowid integer pk, assetId text not null unique → asset.id }
file.kind      text not null default 'other'; index file_asset_id_kind_idx (asset_id, kind)
workspace.derivedDataVersion integer (nullable)
// hand-written, appended to 0004:
// CREATE VIRTUAL TABLE asset_search USING fts5(name, description, tags, file_names,
//   tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
```

- [ ] **Step 1: FTS5 gate.** Add `native-module.test.ts` test `the bundled SQLite supports FTS5 with unicode61 remove_diacritics 2`: create the virtual table above in an in-memory database, insert `Café Sword`, assert `MATCH '"cafe"*'` and `MATCH '"swo"*'` each return the row. If FTS5 is missing from the prebuild, **stop and report BLOCKED** with the error.
- [ ] **Step 2: Schema.** Add the tables and columns above. Column names in snake case like the existing tables. No CHECK on `file.kind` (Plan decision 5).
- [ ] **Step 3: Generate.** `pnpm --filter @assetforge/persistence db:generate`. Inspect the SQL: expected `CREATE TABLE` for the four tables, `ALTER TABLE file ADD kind text DEFAULT 'other' NOT NULL`, `ALTER TABLE workspace ADD derived_data_version integer`, the indexes. No table rebuild of `file` or `workspace`.
- [ ] **Step 4: Append** `--> statement-breakpoint` and the `CREATE VIRTUAL TABLE` statement to the end of the generated SQL file. Run `db:generate` again: it must report no schema changes. Do not edit the journal or the snapshot by hand.
- [ ] **Step 5: Write the migration test** `migration-0004.test.ts`, modelled on `migration-0003.test.ts` (copy migrations `0000`–`0003` and the trimmed journal into a temp folder, migrate, insert rows, then `openWorkspaceDatabase`):
  - `0004 applies to a phase 3a database` — a phase 3a database with a workspace row, an asset and a complete file: after opening, `file.kind` is `'other'` (the derived-data step of Task 6 sets real values later), `derived_data_version` is null, `asset_search` and `asset_search_map` exist and are empty, the asset and file rows are unchanged.
  - `0004 creates the tag tables with their keys` — inserting the same (`asset_id`, `tag_id`, `origin`) twice fails; the same pair with `manual` and `ai` succeeds; `origin = 'x'` fails; a duplicate `tag.name` fails.
- [ ] **Step 6: Run** `pnpm test` and `pnpm typecheck` — green (the acceptance test in `apps/desktop` applies migrations by splitting on breakpoints; the new statement must go through it unchanged).
- [ ] **Step 7: Commit and push** — `feat(persistence): migration 0004 for tags, file kinds and the search index`.

---

### Task 3: Tags and file kinds through contracts, core, fakes and persistence

**Model:** sonnet

**Files:**
- Create: `packages/contracts/src/tags.ts`, `packages/core/src/tags.ts`, `packages/persistence/src/tag-repository.ts`
- Modify: `packages/contracts/src/files.ts`, `packages/contracts/src/library.ts`, `packages/contracts/src/index.ts`, `packages/core/src/ports.ts`, `packages/core/src/import-file.ts`, `packages/core/src/asset-cover.ts`, `packages/core/src/index.ts`, `packages/core/test/fakes.ts`, `packages/persistence/src/file-repository.ts`, `packages/persistence/src/open-database.ts`, `packages/persistence/src/index.ts`
- Test: `packages/contracts/test/schemas.test.ts`, `packages/core/test/tags.test.ts`, `packages/persistence/test/tag-repository.test.ts`, existing tests whose `toEqual` on whole `FileRecord`/`AssetDetail` objects need the new fields

**Interfaces:**
- Consumes: `FileKindSchema`, `fileKind` (Task 1); tables from Task 2.
- Produces:

```ts
// packages/contracts/src/tags.ts
export const TagOriginSchema: z.ZodEnum<['manual', 'ai']>;
export const TagAssignmentSchema: z.ZodObject<{ name: string; displayName: string; origin: TagOrigin }>;
export const TagSuggestionSchema: z.ZodObject<{ name: string; displayName: string }>;
export const MAX_TAG_LENGTH = 64;
export function normalizeTagName(input: string): string | null; // null = invalid
export function normalizeTagPrefix(input: string): string;
// files.ts: FileRecordSchema gains kind: FileKindSchema, tags: z.array(TagAssignmentSchema)
// library.ts: AssetDetailSchema gains tags: z.array(TagAssignmentSchema) — asset tags only
// packages/core/src/ports.ts
export interface TagRepository {
  suggest(q: { prefix: string; limit: number }): Promise<TagSuggestion[]>;
  addToAsset(r: { assetId: string; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<void>;
  removeFromAsset(r: { assetId: string; name: string; origin: TagOrigin }): Promise<void>;
  addToFile(r: { fileId: string; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<void>;
  removeFromFile(r: { fileId: string; name: string; origin: TagOrigin }): Promise<void>;
  listForAsset(assetId: string): Promise<TagAssignment[]>; // by name, then origin
}
// WorkspaceDatabase gains `tags: TagRepository`; FileRepository.insertPending gains `kind: FileKind`
// packages/core/src/tags.ts
export function tagName(input: string): { name: string; displayName: string }; // throws ValidationFailedError
export function suggestTags(s: WorkspaceSession, r: { prefix: string; limit: number }): Promise<TagSuggestion[]>;
export function addAssetTag(s: WorkspaceSession, r: { assetId: string; name: string }): Promise<AssetDetail>;
export function removeAssetTag(s: WorkspaceSession, r: { assetId: string; name: string }): Promise<AssetDetail>;
export function addFileTag(s: WorkspaceSession, r: { fileId: string; name: string }): Promise<FileRecord>;
export function removeFileTag(s: WorkspaceSession, r: { fileId: string; name: string }): Promise<FileRecord>;
```

`addTo*` inserts the tag when its normalised name is missing (`displayName` is used only then), then the assignment with on-conflict-do-nothing, in one transaction. `removeFrom*` deletes the one assignment of that origin; a missing tag or assignment is a no-op. `displayName` is the trimmed, whitespace-collapsed, NFC input without lower-casing.

- [ ] **Step 1: Write the failing contract and core tests.**
  - `schemas.test.ts`: `normalizeTagName` — `'  Sci   Fi '` → `'sci fi'`; `'Ｅ́'`-style decomposed input equals its NFC form; `''`, `'   '` → null; 64 code points of `'😀'` valid, 65 → null; `FileRecordSchema` rejects a missing `kind`.
  - `tags.test.ts` (fakes): `adding a tag twice is a no-op and keeps the first display name` (`'Sci Fi'`, then `'sci fi'` → one assignment, displayName `'Sci Fi'`); `removing a missing tag is a no-op`; `an empty or too long tag fails with validation_failed`; `tagging an unknown asset or file fails with not_found`; `tagging a pending or failed file fails with validation_failed`; `suggestions offer only tags in use, by prefix, most used first` (tag used twice before tag used once; a tag whose last assignment was removed is not offered; prefix `'SC'` matches `sci fi`); `asset detail carries asset tags only, file records carry file tags` (the same tag on asset and file shows up once in each, never mixed); `import stores the file kind` (`scene.blend` → model).
- [ ] **Step 2: Implement contracts and core.** Fakes: an `InMemoryTags` class owning tags and both assignment lists, wired into `InMemoryDatabase`; `InMemoryFiles` records carry `kind` and attach their tags in every method that returns a `FileRecord`; `getAssetDetail` adds `tags` from `database.tags.listForAsset`. `importFile` passes `kind: fileKind(originalName)` (Plan decision 8) and puts `kind` and `tags: []` into both record literals.
- [ ] **Step 3: Write the failing persistence tests** in `tag-repository.test.ts`:
  - `tag names are unique by normalised name` — `addToAsset` with `'sci fi'` twice for two assets creates one `tag` row.
  - `manual and ai assignments of one tag coexist and a delete by origin leaves the other` — insert `manual` through the repository and `ai` through the repository with `origin: 'ai'`; `removeFromAsset({ origin: 'ai' })` leaves the manual one; and the reverse. Same for files.
  - `suggest uses the name index range and counts both owners` — as in core, plus a prefix ending in a multi-byte character.
  - `file records carry kind and tags` — `get` and `list` return `kind` and tags ordered by name, then origin.
- [ ] **Step 4: Implement persistence.** `tag-repository.ts` with Drizzle; `file-repository.ts` writes `kind` in `insertPending`, maps `kind` in `toRecord`, and attaches tags through one batched query per call (`file_id in (…)`); wire `tags` into `openWorkspaceDatabase`. Leave the `// reindex` call sites to Task 5.
- [ ] **Step 5: Run** `pnpm test` and `pnpm typecheck` — green. Fix `toEqual` expectations elsewhere by adding `kind` and `tags`, not by loosening them.
- [ ] **Step 6: Commit and push** — `feat: tags with origin on assets and files, and stored file kinds`.

---

### Task 4: `query`, tag, file-role and file-kind filters on `assets:list`

**Model:** sonnet

**Files:**
- Create: `packages/core/src/search.ts`
- Modify: `packages/contracts/src/ipc.ts`, `packages/core/src/ports.ts`, `packages/core/src/assets.ts`, `packages/core/src/index.ts`, `packages/core/test/fakes.ts`, `packages/persistence/src/asset-repository.ts`, `apps/desktop/src/renderer/src/list-state.ts`, `apps/desktop/src/renderer/src/screens/AssetsScreen.tsx`, `apps/desktop/src/renderer/src/components/AssetPicker.tsx`
- Test: `packages/core/test/search.test.ts`, `packages/core/test/projects-assets.test.ts`, `packages/persistence/test/library-repositories.test.ts`, `apps/desktop/test/library-ipc.test.ts`, `apps/desktop/test/list-state.test.ts`

**Interfaces:**
- Consumes: `normalizeTagName` (Task 3), `FileKindSchema`, `FileRoleSchema`.
- Produces:

```ts
// contracts 'assets:list' request: PageRequestSchema.extend({
//   typeId?, status?, projectId?,
//   query: z.string().max(200).optional(),
//   tagNames: z.array(z.string().max(200)).max(10).optional(),
//   fileRole: FileRoleSchema.optional(),
//   fileKind: FileKindSchema.optional(),
// })
// core
export const MAX_SEARCH_WORDS = 16;
export function searchWords(query: string): string[];
export interface AssetQuery extends Page { typeId?; status?; projectId?; query?: string; tagNames?: string[]; fileRole?: FileRole; fileKind?: FileKind }
// listAssets normalises tagNames with tagName() (invalid → validation_failed), dedupes them,
// and drops `query` when searchWords(query) is empty, before calling the repository.
// renderer: AssetFilters.nameContains → query; filterKey and the request use `query`.
```

- [ ] **Step 1: Write the failing core tests.**
  - `search.test.ts`: `searchWords splits at non letters, digits and marks` — `'sci-fi'` → `['sci','fi']`; `'Café  "Sword"*'` → `['café','sword']`; `'"*-:'` → `[]`; `'NEAR'` → `['near']`; 20 words → first 16; decomposed `'é'` stays one word.
  - Fakes in `projects-assets.test.ts`: `query matches word prefixes in name, description, tags and complete file names` (`'swo'` finds `Sword`, `'ord'` does not; finds by description word, by asset tag, by file tag, by file original name; a failed file's name does not match); `all words must match`; `diacritics and case are folded` (`'cafe'` finds `Café`); `a name match ranks before a description match`; `tag filter matches tags on the asset or on its complete files` — asset A tagged `metal` and its file tagged `rusty`, `tagNames: ['metal','rusty']` finds A (**different owners**); asset B with `rusty` only on a failed file is not found; `an unknown tag yields no results`; `fileRole and fileKind each need one complete file and are independent` (asset with a complete `reference` image and a complete `working` model matches `fileRole: 'working', fileKind: 'image'`; an asset whose only image is pending does not match `fileKind: 'image'`); `filters combine with the query`.
- [ ] **Step 2: Implement core and fakes** (Plan decision 12 for the fake ranking and folding). Rename `nameContains` → `query` in ports, fakes and the contract.
- [ ] **Step 3: Persistence, no-query path.** In `asset-repository.ts` add the filters as `EXISTS` predicates on the existing Drizzle path: per tag id `(exists asset_tag where asset_id = asset.id and tag_id = ?) or (exists file_tag join file on file.id = file_tag.file_id where file.asset_id = asset.id and file.status = 'complete' and file_tag.tag_id = ?)`; `fileRole` and `fileKind` as `exists file where asset_id = asset.id and status = 'complete' and role|kind = ?`. Resolve tag names to ids first (`select id from tag where name in (…)`); fewer ids than names → `{ items: [], total: 0 }`. `query` keeps the substring `LIKE` on the name for now (Plan decision 17).
- [ ] **Step 4: Persistence tests.** Rename the `nameContains` tests to `query` (unchanged expectations until Task 5). Add the tag, role and kind filter cases of Step 1 (without `query`), including **different owners** and the failed-file exclusion.
- [ ] **Step 5: Desktop.** Rename in `library-ipc.test.ts` and `list-state.test.ts`; renderer: `AssetFilters.query`, the name field and `AssetPicker` send `query` (no other renderer change; keep the field's label and layout). Add to `library-ipc.test.ts`: `assets:list rejects more than 10 tag names` and `assets:list rejects an unknown file kind` (`validation_failed`).
- [ ] **Step 6: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 7: Smoke** — build, launch with a fresh `--user-data-dir`, create a workspace and two assets, type in the name field: the list narrows; switch grid/table: the filter stays; open an asset and go back: the filter and position stay. Close the app.
- [ ] **Step 8: Commit and push** — `feat: query, tag, file role and file kind filters for the asset list`.

---

### Task 5: Search index and the FTS query path

**Model:** opus

**Files:**
- Create: `packages/persistence/src/search-index.ts`
- Modify: `packages/persistence/src/asset-repository.ts`, `packages/persistence/src/file-repository.ts`, `packages/persistence/src/file-move-repository.ts`, `packages/persistence/src/tag-repository.ts`, `packages/persistence/src/like.ts` (remove if unused)
- Test: `packages/persistence/test/search.test.ts`, `packages/persistence/test/library-repositories.test.ts`

**Interfaces:**
- Consumes: `searchWords` (Task 4), tables from Task 2, repositories from Tasks 3–4.
- Produces (adapter-internal, not exported from the package index):

```ts
export function reindexAsset(tx: Tx, assetId: string): void;           // synchronous, inside a transaction
export function matchExpression(words: readonly string[]): string;     // '"w1"* AND "w2"*'
export function searchAssets(tx: Tx, q: AssetQuery & { words: string[] }): { ids: string[]; total: number };
```

`reindexAsset` reads the asset (name, description), the tag names of the asset plus the tag names of its complete files (distinct, ordered by name, space-joined), and the original names of its complete files (ordered by `imported_at`, `id`, space-joined); then upserts the FTS row through `asset_search_map` (Plan decision 3). The query path (only when `words.length > 0`):

```sql
SELECT asset.id FROM asset_search
  CROSS JOIN asset_search_map AS m ON m.rowid = asset_search.rowid
  CROSS JOIN asset ON asset.id = m.asset_id
 WHERE asset_search MATCH ? AND <filters as in Task 4>
 ORDER BY bm25(asset_search, 10.0, 1.0, 4.0, 2.0), lower(asset.name), asset.id
 LIMIT ? OFFSET ?;
SELECT count(*) FROM <same FROM and WHERE>;
```

`CROSS JOIN` fixes the loop order so the match drives the plan. The page rows are then loaded with the existing summary select (project count, file count, workflow progress, covers) for those ids and returned in the id order. Both statements run in the one deferred read transaction the list already uses. Without words the existing Drizzle path runs unchanged.

- [ ] **Step 1: Write the failing tests** in `search.test.ts` (real adapter, temp workspace; each trigger test asserts "not found before, found after" and the reverse where it applies):
  - `asset insert and update reindex` — created asset found by name; after renaming, found under the new name only; description change likewise.
  - `asset tag add and remove reindex`.
  - `file tag on an asset file reindexes; on an inbox file it does not fail` — tagging an inbox file, then placing it into an asset: the asset is found by that tag.
  - `placement change reindexes the asset left and the asset joined` — file name and file tag move from A to B.
  - `a committed file move reindexes both assets` — `fileMoves.begin` + `commit` for a move from A to B; also via `recoverFileMoves` with an open intent (the repair-on-open path).
  - `only complete files contribute` — a pending file with an asset (insert pending, then assign the asset in the same way the existing repository tests do, or by a direct SQL update in the test) is not found by its name; after `markComplete` it is; a file with an asset that `markFailed` is not.
  - `hostile query strings neither throw nor match wrongly` — for `'"'`, `'*'`, `'-'`, `'NEAR'`, `'a:b'`, `'"*-:()^'`, `'x'.repeat(200)`, `'AND OR NOT'`: no throw; punctuation-only returns the unfiltered list (no words); `'NEAR'` finds only an asset named `Nearby`; `'a:b'` behaves like `'a b'`; `'AND OR NOT'` matches only assets containing those words.
  - `diacritics and case are folded` — `Café` found by `cafe`, `CAFÉ`, `café`; `Cafe` found by `café`.
  - `prefix matching` — `swo` finds `Sword`, `ord` does not; `sci-fi` finds an asset tagged `sci-fi`.
  - `ranking puts a name match before a description match` — `Zulu sword` (name) before `Alpha` with description `sword`.
  - `search combines with every filter` — project, type, status, tags (different owners), fileRole, fileKind; `total` equals the number of matching assets across pages (page size 2).
- [ ] **Step 2: Update** the bridged `query` tests in `library-repositories.test.ts` to prefix semantics (`'GAS'` finds `Gas station` and `gas_pump`; `'_'` and `'%'` are no words → unfiltered; the old substring expectations go). Remove `containsPattern` if nothing else uses it.
- [ ] **Step 3: Implement** `search-index.ts` and call `reindexAsset` at every site in Plan decision 16; wrap `assets.insert` and `assets.update` in transactions. For `setPlacement` and `commit` read the old `asset_id` inside the transaction before the update; skip null asset ids; reindex an asset once when old and new are the same.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 5: Commit and push** — `feat(persistence): full-text search index and query path`.

---

### Task 6: Derived-data step on open

**Model:** opus

**Files:**
- Create: `packages/persistence/src/derived-data.ts`
- Modify: `packages/core/src/ports.ts`, `packages/core/src/workspace-manager.ts`, `packages/core/test/fakes.ts`, `packages/persistence/src/open-database.ts`, `packages/persistence/src/index.ts`
- Test: `packages/persistence/test/derived-data.test.ts`, `packages/persistence/test/migration-0004.test.ts`, `packages/core/test/workspace-session.test.ts`

**Interfaces:**
- Consumes: `fileKind` (Task 1), `reindexAsset` (Task 5).
- Produces:

```ts
// core port
interface WorkspaceDatabase { /* … */ ensureDerivedData(): Promise<void> }
// persistence
export const DERIVED_DATA_VERSION = 1;
export interface DerivedDataOptions { batchSize?: number; afterBatch?(batchIndex: number): void }
export function openWorkspaceDatabase(dbFilePath: string, migrationsFolder: string, options?: { derivedData?: DerivedDataOptions }): Promise<WorkspaceDatabase>;
```

`ensureDerivedData`: read `workspace.derived_data_version`; equal to `DERIVED_DATA_VERSION` → return. Otherwise (1) recompute `file.kind` from `original_name` in batches of `batchSize` file ids (keyset by id, one transaction per batch, update only rows whose kind differs); (2) empty `asset_search` and `asset_search_map` in one transaction; (3) for asset ids in keyset batches of `batchSize`, one transaction per batch calling `reindexAsset`, then `afterBatch?.(i)`; (4) write the stamp in its own statement. Runs under the manager's open, before the workspace is available.

- [ ] **Step 1: Write the failing tests.**
  - `derived-data.test.ts`: `a missing stamp rebuilds the same index as the incremental path` — build assets, tags, files and moves through the repositories, snapshot `select m.asset_id, s.name, s.description, s.tags, s.file_names from asset_search s join asset_search_map m on m.rowid = s.rowid order by m.asset_id`, set the stamp to null, run, compare equal; stamp is `DERIVED_DATA_VERSION`. `an outdated stamp rebuilds` (stamp 0). `a current stamp does nothing` (delete one FTS row by SQL; after the step it is still missing). `file kinds are recomputed` (set every kind to `other` by SQL, null stamp, run: `.blend` → model, `.png` → image). `an interrupted rebuild keeps the old stamp and completes on the next run` — 5 assets, `batchSize: 2`, `afterBatch` throws on batch 0: the open fails, stamp still null; reopen without options: stamp current and snapshot equal to the incremental one.
  - `migration-0004.test.ts`: extend `0004 applies to a phase 3a database` — after the open (which now runs the step) the pre-existing file has its real kind and the pre-existing asset is found by its name and by its file's name.
  - `workspace-session.test.ts`: `opening a workspace ensures derived data once, after the built-in templates` (fake counts calls and records the order relative to `ensureBuiltInWorkflowTemplates`).
- [ ] **Step 2: Implement** the port, the fake (recomputes kinds from `originalName`, counts calls), the manager call and `derived-data.ts`. If the step throws, the open fails like any other open error (the database is closed by the existing error path).
- [ ] **Step 3: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 4: Commit and push** — `feat: derived-data step rebuilds file kinds and the search index on open`.

---

### Task 7: Scale test with `EXPLAIN QUERY PLAN`

**Model:** opus

**Files:**
- Create: `packages/persistence/test/search-scale.test.ts`

**Interfaces:**
- Consumes: the SQL of Task 5 (export the statement builder from `search-index.ts` for tests only through a test-visible path, e.g. `packages/persistence/src/search-index.ts` imported directly by the test, not from the package index).

- [ ] **Step 1: Write the test** `search over 10 000 assets is driven by the match and uses indexes only`:
  - Seed directly with prepared statements in one transaction (not through the repositories, to keep it fast): 10 000 assets with generated names and descriptions, 200 tags, about 3 asset tags per asset, one or two complete files per asset with roles and kinds spread, about 1 file tag per file, project assignments for a third of the assets. Then run the derived-data step (null stamp) to build the index.
  - For each of: `query: 'swo'`; `query: 'red sword'` + `tagNames` of one asset tag and one tag that occurs only on files (**different owners**); `query` + `projectId` + `typeId` + `status` + `fileRole` + `fileKind`: run `EXPLAIN QUERY PLAN` on both the page and the count statement; assert that every line containing `SCAN` refers to `asset_search` (the virtual table) and no other table (`asset`, `asset_search_map`, `tag`, `asset_tag`, `file`, `file_tag`, `project_asset`, `asset_workflow`), i.e. those are reached only through `SEARCH … USING (COVERING|INTEGER PRIMARY KEY|PRIMARY) …`. `USE TEMP B-TREE FOR ORDER BY` is allowed.
  - Run each search through `assets.list` and print the elapsed time with `console.info` (`search 'swo' over 10000 assets: N ms`). Assert results are non-empty and `total` matches a brute-force count over the seeded data for one case. No time threshold.
- [ ] **Step 2:** If a plan shows a scan, fix the SQL or add an index in `schema.ts` — only if it can still go into `0004` because the branch is unmerged: regenerate `0004` (delete the generated file, snapshot and journal entry for `0004`, run `db:generate`, re-append the FTS statement) and rerun all migration tests. Record any added index in the commit message.
- [ ] **Step 3: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 4: Commit and push** — `test(persistence): search scale test with query plan assertions`.

---

### Task 8: IPC channels and the acceptance path

**Model:** sonnet

**Files:**
- Modify: `packages/contracts/src/ipc.ts`, `apps/desktop/src/main/library-handlers.ts`
- Test: `packages/contracts/test/schemas.test.ts`, `apps/desktop/test/library-ipc.test.ts`, `apps/desktop/test/acceptance.test.ts`

**Interfaces:**
- Consumes: the use cases of Task 3.
- Produces:

```ts
'tags:suggest':     { request: { prefix: z.string().max(200), limit: z.number().int().min(1).max(50) }, response: z.array(TagSuggestionSchema) }
'assets:addTag':    { request: { assetId: z.uuid(), name: z.string().max(200) }, response: AssetDetailSchema }
'assets:removeTag': { request: { assetId: z.uuid(), name: z.string().max(200) }, response: AssetDetailSchema }
'files:addTag':     { request: { fileId: z.uuid(), name: z.string().max(200) }, response: FileRecordSchema }
'files:removeTag':  { request: { fileId: z.uuid(), name: z.string().max(200) }, response: FileRecordSchema }
// handlers: writes through manager.exclusive, tags:suggest through manager.read
```

- [ ] **Step 1: Write the failing tests.**
  - `library-ipc.test.ts`: the channel count goes from 24 to 29; `tags round-trip through IPC` (add on asset and file, `assets:get` shows the asset tag only, `files:list` shows the file tag only, suggest returns both by prefix, remove is a no-op the second time); `a too long tag answers validation_failed without echoing the input`; `an unknown asset answers not_found`; `files:addTag on a pending file answers validation_failed`; `tags:suggest rejects limit 0 and 51`.
  - `acceptance.test.ts`, new `describe('phase 3b acceptance')` on the real adapters through the handlers: create a workspace, import `sword.png` and `notes.txt` into an asset `Rusty blade`, tag the asset `metal` and the file `sci-fi`; find it by `query: 'rust'`, by `query: 'sword'` (file name), by `query: 'sci'` (file tag), by `tagNames: ['metal', 'sci-fi']` (different owners), combined with `fileKind: 'image'` and its type; not by `fileKind: 'model'`; rename it to `Old axe` and find it by `axe` but not by `rusty`; import `Setup.exe` → refused result without path; close and reopen the workspace (new manager, same `userData`) and find it again by `axe` and by `metal`.
- [ ] **Step 2: Implement** the contract entries and the handlers.
- [ ] **Step 3: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 4: Commit and push** — `feat(desktop): tag channels and phase 3b acceptance test`.

---

### Task 9: Documentation

**Model:** sonnet

**Files:**
- Modify: `ReadMe.md`, `docs/backlog.md`, `CLAUDE.md` (local file, git-ignored: update "Project state" only, do not stage it)

- [ ] **Step 1: `ReadMe.md`.** §4: replace the block-list sentence of the phase 3a note with the allow-list rule and the refused-import list; mention file kinds. §6.1: "Implemented so far (phase 3b)": normalised tags with display name and origin on assets and files, suggestions from tags in use; editing UI pending the UI phase. §6.2: full-text search over name, description, tags and file names with prefix matching per word, all words required, BM25 with name first; the tag filter matches tags on the asset or its complete files; role and kind filters; the behaviour change from substring to word-prefix matching. §10: add `tag`, `asset_tag`, `file_tag`, `file.kind`, `asset_search` (FTS5, hand-written in `0004`), `asset_search_map`, `workspace.derived_data_version` and the derived-data step to the "Implemented so far" paragraph. §15.1: debounced search is a renderer rule for the UI phase; the backend pages search results like the list. §16: "Open externally" only for files of kind image/model/document except SVG; program imports are refused. §17: phase 3 backend complete; the search, filter and tag UI follows in the UI phase.
- [ ] **Step 2: `docs/backlog.md`.** Remove the deny-list entry (line "The open-externally block list is a deny-list of 42 extensions …") and the entry "No test for a backslash in `nameContains` …". Reword "\"Loading…\" flashes on every keystroke in the name filter." to refer to the search field. Add: search, filter and tag-row UI including the 250 ms debounce and request superseding (UI phase); asset and file tags must be visually distinct there; the path without a query still orders by `lower(name)` over all assets; unused tag rows are never deleted and there is no tag rename/merge; the derived-data step also runs on every new workspace; the fakes approximate BM25 by a two-bucket rule.
- [ ] **Step 3: Run** `pnpm test` and `pnpm typecheck` — green. **Commit and push** — `docs: phase 3b tags, search and file kinds`.

---

## End-to-end checklist (controller)

Run after Task 9 on the built app (`pnpm --filter @assetforge/desktop build`, launched unpackaged with a throw-away `--user-data-dir`).

- [ ] The acceptance test of Task 8 and the scale test of Task 7 pass; note the printed search times in the final report.
- [ ] Built app, fresh workspace: create assets `Sword`, `Swordfish`, `Shield`; the name field finds both swords by `swo`, nothing by `ord`; grid/table switch and back-navigation keep the field and position; the project/type/status filters still combine with it.
- [ ] Import a folder containing `Setup.exe` and a PNG through the existing import: the PNG imports, `Setup.exe` shows the refusal message without a path; the PNG's file dialog still offers "Open externally" (do not click it), a `.py` file offers only "Show in folder".
- [ ] Open a workspace created on `main` (phase 3a) with assets and files: it opens, existing assets are found by name prefix, file kinds are set (check with the SQLite CLI or a test query).
- [ ] Final whole-branch review (most capable model), one fix wave, then finish the branch.

## Self-review

- **Spec coverage.** Goals: tags (T3), tag editing — use cases and IPC (T3, T8), UI deferred (Plan decision 1); full-text search (T5); filters including the revised tag rule (T4, T5, T7); file kind (T1, T3, T6); index consistency (T5, T6); no programs (T1). Design: data model (T2); normalisation (T3); kinds (T1); refused imports (T1); allow-list (T1); use cases and IPC (T3, T8); behaviour change (T5, T9); searching (T4, T5); reindexing (T5); derived-data step (T6); renderer (deferred, minimal rename in T4). Testing: persistence bullets (T2, T3, T5, T6); scale (T7); core refused imports and `isOpenable` (T1); core normalisation, no-ops, fakes (T3, T4); desktop IPC (T8); end to end (T8 acceptance + controller checklist, UI part deferred). Constraints: one migration (T2), debounce (deferred with the renderer, Plan decision 18).
- **Green after every task.** T1 adds no contract field to `FileRecord`; T2 adds unused tables; T3 adds `kind`/`tags` to records together with every producer; T4 renames `nameContains` in one task with a temporary bridge; T5 replaces the bridge; T6 adds the port together with fake, adapter and manager; T8 adds channels together with their handlers.
- **Proportion.** Nine tasks; the opus tasks are the ones whose mistakes would be silent (index drift, query plans, interrupted rebuild). No new dependency, no new package, one migration.
