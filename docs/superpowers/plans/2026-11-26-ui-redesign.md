# UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AssetForge the dark, three-column look of the mockups, deliver the renderer half of tags and search, and add the batch actions the inbox needs, without losing any feature that exists today.

**Architecture:** Four backend tasks come first. They extend `assets:list`, `files:list` and `projects:list`, and add three batch channels (contracts → core use case and fake → SQLite adapter → IPC handler), with no migration. The renderer then gets a jsdom Vitest project, Tailwind 4 `@theme` tokens and shared building blocks: shell, page, dialog, menu, tabs, tag components, search, `FileBrowser` and the selection model. Every screen is rebuilt on top of those. Data still flows Renderer → `window.assetForge.invoke` → validated IPC → core.

**Tech Stack:** Electron 45, React 19, TypeScript 7, Vite 8 / electron-vite 6, Tailwind 4 (`@tailwindcss/vite`), @tanstack/react-virtual, Zod 4, Drizzle + better-sqlite3 (FTS5), Vitest 5 (+ jsdom, @testing-library/react, @testing-library/user-event), lucide-react, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-11-26-ui-redesign-design.md` (visual reference `docs/design/mockups/01-workspaces.png` … `07-assets-gallery-variant.png`)

## Plan decisions

1. **SQL folding.** `openWorkspaceDatabase` registers two deterministic SQLite functions on the raw handle:
   - `af_fold(text)`: `foldSearchWord(text)` from `@assetforge/core`, which is NFD with marks stripped, lower-cased.
   - `af_word_prefix(text, prefix)`: returns `1` when a word of `textWords(text)` starts with `prefix` after `foldSearchWord`, otherwise `0`.

   The `files:list` and `projects:list` filters use only these two functions, so SQLite and the fakes fold the same way. The fakes call the same core functions. Null input returns null / `0`.
2. **Meaning of "prefix of one of the file's tag names".** It is a prefix of a *word* of a tag name, matching the asset FTS behaviour. Otherwise the query `sci-fi` (words `sci`, `fi`) could not find the tag `sci-fi`. A query word matches when it is a substring of `af_fold(original_name)` **or** a word prefix of one of the file's tag names. Every query word must match.
3. **`projects:list` `query`.** It is matched as an `af_fold` substring of name or description. That is case-insensitive, as the spec requires, and also folds diacritics, consistent with files.
4. **Project screen cover column: dropped.** `ProjectMember` has no cover field, and the spec changes no contract for it. The member table keeps today's columns (name, type, status, assignment fields, Remove). Adding a cover later needs `ProjectMemberSchema` to gain `coverFileId`.
5. **Multi-file "Detach" in the asset Files tab.** No batch unassign channel exists. The renderer calls `files:unassign` once per file, one after another, and lists failures per file in a results strip. No file is skipped silently.
6. **"Previous results stay visible".** This is solved in `PagedLoader`, not per screen:
   - After a key change, the loader keeps showing the previous state (`displayed`). It requests page 0 of the new key first.
   - It switches only once that page has settled.
   - The views are keyed by `displayed.key`. They remount at the top when the new results take over.
7. **Opening the app is the controller's job.** Implementers verify with tests, typecheck and build only. DOM tests call `files:openExternal` and `files:showInFolder` against the fake API only. No step triggers them for real.
8. **Unrelated files.** Do not commit or delete the untracked `docs/design/` folder unless a task says so. The mockups are read-only reference.

## Global Constraints

- Everything in the repository is English. Commit messages have no attribution lines. Every commit is followed by `git push origin ui-redesign`.
- Commands:
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm --filter @assetforge/<pkg> test <file> -t "<name>"` (no `--` separator)
  - `pnpm --filter @assetforge/desktop build`

  Tests in `packages/persistence` and `apps/desktop` run under Electron's Node.
- No database migration. No new dependency beyond these:
  - `lucide-react` as a runtime dependency of `apps/desktop`;
  - `jsdom`, `@testing-library/react`, `@testing-library/user-event` as dev dependencies of `apps/desktop`.

  All of them are pinned to exact versions (`pnpm --filter @assetforge/desktop add -E …`).
- "explanations only as `title` tooltips". No explanatory sentences in the layout.
- "every action button uses the one `BUTTON` style (icon-only buttons use the same style with square padding)". No link-styled actions, no filled primary buttons, no ghost buttons.
- "navigation targets (breadcrumb, asset link in the dialog, nav items) are links, tabs are tabs; everything reachable by keyboard; focus handling as today (focus returns to the trigger when a dialog or menu closes, roving tabindex in grids)".
- "virtualised and paginated lists (page size 60)". No screen loads all assets, all files or all originals.
- Main process: "`nativeTheme.themeSource = 'dark'`, a `backgroundColor` equal to the page token (no white flash), and a minimum window size of 1024 × 680".
- Tokens:
  - `bg #060b1d`, `surface #0c1428`, `raised #131d36`, `nav-active #26324d`
  - `line #2a3550`, `line-strong #4a5670`
  - `text #e8ebf2`, `muted #97a1b5`
  - `accent #38c6f4`, `accent-soft #0f2b3d`
  - `danger #f87171` on `#2a1015`, `warning #fbbf24`
- Font `"Segoe UI Variable", "Segoe UI", system-ui, sans-serif`. Type sizes (size/weight):
  - page title 28/600; workspace name 24/600; section heading 18/600; tile title 17/600
  - body 15/400; label and meta 14/400 `muted`; chip 13/400; counts 28/400 `muted`
- Spacing:
  - page padding 24; header height 76; nav width 200
  - detail column 300 (264 below 1280 px); column gap 24 with 1 px dividers
  - toolbar rows 40 high, 12 apart; tile gap 16
- Radii: controls and chips 6, tiles and preview frames 8, dialogs 10.
- Controls:
  - Height 36 (toolbar) / 32 (inline).
  - BUTTON: `raised` background, 1 px `line` border, `text`, radius 6, px 14, hover border `line-strong`; `aria-pressed` gives a `nav-active` background and an `accent` border; disabled is 50 % opacity.
  - Focus ring 2 px `accent`, offset 2.
  - Chip: 1 px `line-strong` border, transparent, height 26, px 10. A filter chip has an `accent` border and text, plus a remove icon.
- Tags: file tags are preceded by an image icon (`ImageIcon`, 16 px) once per row. Rows are labelled "Asset tags" / "Image tags" wherever both appear. The chip takes `origin`.
- Error messages never carry paths. Per-item batch errors follow the `AssetForgeError` → code/message and otherwise → `internal_error` rule.

## Review Focus

1. A search with different case or diacritics, or a hyphenated tag, must still find the file. `Säule` finds `saule-01.png`, and `sci-fi` finds a file tagged `sci-fi`. Pinned by Task 2 "query folds case and diacritics and matches tag word prefixes".
2. While the user types, a slow answer to an older query that arrives after the newer one is never shown, and the old results stay up until the new first page arrives. Pinned by Task 6 "a late page of a superseded key is never displayed".
3. In a batch assign where one file fails in the middle, the others still move. The failed file stays selected and listed with its message; the moved files leave the inbox. Pinned by Task 14 "a partially failed assign lists the failure and drops the moved files".
4. Pending or failed files in a selection are excluded from counts and from batch requests. The button reads "Assign 2 files" for 3 selected with 1 failed, and the request carries 2 ids. Pinned by Task 14 "failed files are excluded from the assign request and the count".
5. Tag text that normalises to nothing (`"!!!"`), or is longer than 64 characters, sends no request, keeps the input and shows an inline alert. Pinned by Task 7 "invalid tag text sends nothing and shows an alert".

---

### Task 1: `assets:list` items carry tags, cover tags and matched tags

**Model:** opus

**Files:**
- Modify: `packages/contracts/src/tags.ts`, `packages/contracts/src/library.ts`
- Modify: `packages/core/test/fakes.ts`
- Create: `packages/persistence/src/list-tags.ts`
- Modify: `packages/persistence/src/asset-repository.ts`
- Test: `packages/contracts/test/schemas.test.ts`, `packages/core/test/search.test.ts`, `packages/persistence/test/search.test.ts`, `packages/persistence/test/search-scale.test.ts`, `apps/desktop/test/library-ipc.test.ts`

**Interfaces:**
- Consumes: `TagAssignmentSchema`, `AssetSummarySchema`, `automaticCovers(tx, assetIds)`, `assetFilter`, `Tx`.
- Produces:
  - In `tags.ts`: `MatchedTagSchema = z.object({ name: z.string(), displayName: z.string(), onAsset: z.boolean(), onFiles: z.boolean() })` and `type MatchedTag`.
  - `AssetSummarySchema` gains `tags: z.array(TagAssignmentSchema)`, `coverTags: z.array(TagAssignmentSchema)` and `matchedTags: z.array(MatchedTagSchema).optional()`.
  - In `list-tags.ts`:
    - `assetTagsOf(tx: Tx, assetIds: readonly string[], coverFileIds: readonly string[]): { asset: Map<string, TagAssignment[]>; file: Map<string, TagAssignment[]> }` is one statement (UNION ALL over `asset_tag` and `file_tag`, each joined to `tag`), ordered by name, then origin.
    - `matchedTagsOf(tx: Tx, assetIds: readonly string[], tagIds: readonly string[]): Map<string, MatchedTag[]>` is one statement, with one entry per requested tag in request order.

- [ ] **Step 1: Write the failing schema test** (`schemas.test.ts`)

```ts
it('an asset summary requires tags and coverTags and accepts matchedTags', () => {
  const base = { /* existing valid AssetSummary fields */ };
  expect(AssetSummarySchema.safeParse(base).success).toBe(false);
  expect(AssetSummarySchema.safeParse({ ...base, tags: [], coverTags: [] }).success).toBe(true);
  expect(AssetSummarySchema.safeParse({ ...base, tags: [], coverTags: [],
    matchedTags: [{ name: 'oak', displayName: 'Oak', onAsset: true, onFiles: false }] }).success).toBe(true);
});
```

- [ ] **Step 2: Write the failing core-fake tests** (`packages/core/test/search.test.ts`, with the setup the file already uses)

```ts
it('list items carry asset tags and the tags of the effective cover', async () => {
  // asset A tagged "Oak"; its cover file tagged "bark"; asset B untagged, no files
  const { items } = await listAssets(s, { limit: 60, offset: 0 });
  expect(byName(items, 'A').tags.map((t) => t.name)).toEqual(['oak']);
  expect(byName(items, 'A').coverTags.map((t) => t.name)).toEqual(['bark']);
  expect(byName(items, 'B')).toMatchObject({ tags: [], coverTags: [] });
  expect(byName(items, 'A').matchedTags).toBeUndefined();
});
it('with tagNames every item reports where each requested tag was found', async () => {
  // A: "oak" on the asset, "bark" on a complete file; C: "oak" on the asset and a complete file
  const { items } = await listAssets(s, { limit: 60, offset: 0, tagNames: ['oak', 'bark'] });
  expect(byName(items, 'A').matchedTags).toEqual([
    { name: 'oak', displayName: 'Oak', onAsset: true, onFiles: false },
    { name: 'bark', displayName: 'bark', onAsset: false, onFiles: true },
  ]);
});
it('a tag on a pending file does not count as onFiles', async () => { /* expect onFiles false */ });
```

- [ ] **Step 3: Run them to verify they fail.** Run `pnpm --filter @assetforge/core test search.test.ts`. Expected: FAIL (`tags` undefined).

- [ ] **Step 4: Implement the contract change and the in-memory fake** (`fakes.ts`, the asset list of `InMemoryAssets`). `matchedTags` is present only when the normalised query had `tagNames`.

- [ ] **Step 5: Write the failing SQLite tests.**
  - `packages/persistence/test/search.test.ts`: the same three cases as Step 2.
  - `search-scale.test.ts`:

```ts
it('tag attachment does not grow with the page size', () => {
  const spy = vi.spyOn(Database.prototype, 'prepare');
  await db.assets.list({ limit: 1, offset: 0, tagNames: [seededTag] }); const one = spy.mock.calls.length;
  spy.mockClear();
  await db.assets.list({ limit: 60, offset: 0, tagNames: [seededTag] }); const sixty = spy.mock.calls.length;
  expect(sixty).toBe(one);
});
it('the tag attachment statements use the tag keys', () => {
  expect(violations(plan(/* SQL of assetTagsOf for 60 ids */))).toEqual([]);
  expect(violations(plan(/* SQL of matchedTagsOf for 60 ids, 2 tags */))).toEqual([]);
});
```

  Export the SQL builders from `list-tags.ts` (`assetTagsSql(...)`, `matchedTagsSql(...)`) so the plan test can explain them. `Database` is the default export of `better-sqlite3`.

- [ ] **Step 6: Implement `list-tags.ts` and call it in `AssetRepository.list`.** Make both calls after the page ids are known, inside the existing deferred read transaction. The cover file ids are the chosen `coverFileId` or else the automatic cover. Resolve the requested tag ids once, as `assetFilter` does.

- [ ] **Step 7: Write the IPC test** (`library-ipc.test.ts`, `describe('tags')`)

```ts
it('assets:list returns tags, coverTags and matchedTags', async () => {
  // create asset, add tag "Oak" via assets:addTag
  const page = await ok('assets:list', { limit: 10, offset: 0, tagNames: ['oak'] });
  expect(page.items[0]).toMatchObject({ tags: [{ name: 'oak', displayName: 'Oak', origin: 'manual' }], coverTags: [],
    matchedTags: [{ name: 'oak', displayName: 'Oak', onAsset: true, onFiles: false }] });
});
```

- [ ] **Step 8: Run `pnpm test` and `pnpm typecheck`.** Expected: green.

- [ ] **Step 9: Commit and push.** Message: `feat(persistence): attach tags, cover tags and matched tags to asset list items`

---

### Task 2: `files:list` filters (query, tags, role, kind)

**Model:** opus

**Files:**
- Modify: `packages/contracts/src/ipc.ts` (`'files:list'` request)
- Modify: `packages/core/src/ports.ts`, `packages/core/src/asset-files.ts`, `packages/core/test/fakes.ts`
- Create: `packages/persistence/src/sql-functions.ts`
- Modify: `packages/persistence/src/open-database.ts`, `packages/persistence/src/file-repository.ts`
- Test: `packages/contracts/test/schemas.test.ts`, `packages/core/test/asset-files.test.ts`, `packages/persistence/test/library-repositories.test.ts`, `packages/persistence/test/search-scale.test.ts`, `apps/desktop/test/library-ipc.test.ts`

**Interfaces:**
- Consumes: `searchWords`, `textWords`, `foldSearchWord`, `tagName`, `scopeMatches`, `toRecords`.
- Produces:
  - The `'files:list'` request becomes `PageRequestSchema.extend({ scope: FileScopeSchema, query: z.string().max(200).optional(), tagNames: z.array(z.string().max(200)).max(10).optional(), role: FileRoleSchema.optional(), kind: FileKindSchema.optional() })`.
  - `FileQuery extends Page { scope: FileScope; query?: string; tagNames?: string[]; role?: FileRole; kind?: FileKind }` lives in `ports.ts`. `FileRepository.list(q: FileQuery)` and `listFiles(s, q: FileQuery)` take it.
  - In `sql-functions.ts`: `registerSqlFunctions(sqlite: Database.Database): void`, which registers `af_fold` and `af_word_prefix` (Plan decision 1).
  - The use case normalises tag names with `tagName()` and dedupes them, like `listAssets`. A query with no words is dropped.

- [ ] **Step 1: Write the failing core-fake tests** (`asset-files.test.ts`)

```ts
describe('file list filters', () => {
  it('query folds case and diacritics and matches tag word prefixes', async () => {
    // inbox files: "Säule-01.png", "wall.png" tagged "sci-fi", "other.png"
    expect(names(await listFiles(s, page({ scope: inbox, query: 'saule' })))).toEqual(['Säule-01.png']);
    expect(names(await listFiles(s, page({ scope: inbox, query: 'SÄU' })))).toEqual(['Säule-01.png']);
    expect(names(await listFiles(s, page({ scope: inbox, query: 'sci-fi' })))).toEqual(['wall.png']);
    expect(names(await listFiles(s, page({ scope: inbox, query: 'fi' })))).toEqual(['wall.png']);
    expect(names(await listFiles(s, page({ scope: inbox, query: 'all sci' })))).toEqual(['wall.png']); // every word
  });
  it('tagNames require every tag on the file itself', async () => {
    // asset tagged "oak"; its file tagged "bark" only
    expect(names(await listFiles(s, page({ scope: assetScope, tagNames: ['bark'] })))).toEqual(['f.png']);
    expect((await listFiles(s, page({ scope: assetScope, tagNames: ['bark', 'oak'] }))).total).toBe(0);
  });
  it('an unknown tag gives an empty page', async () => {
    expect(await listFiles(s, page({ scope: all, tagNames: ['nope'] }))).toEqual({ items: [], total: 0 });
  });
  it('role and kind filter within the scope', async () => { /* asset scope role "texture"; inbox kind "model" */ });
});
```

- [ ] **Step 2: Run them to verify they fail.** Run `pnpm --filter @assetforge/core test asset-files.test.ts -t "file list filters"`. Expected: FAIL.

- [ ] **Step 3: Implement `FileQuery`, the use case normalisation and the fake filter.** The fake uses `foldSearchWord`/`textWords` exactly as Plan decision 1 describes.

- [ ] **Step 4: Write the failing SQLite tests.**
  - `library-repositories.test.ts`: the four cases of Step 1 against `openWorkspaceDatabase`.
  - `search-scale.test.ts`: if the seed has no inbox files, add 2 000 inbox files with tags and two `kind` values.

```ts
describe('file list plans', () => {
  it.each([
    ['inbox', { kind: 'inbox' }],
    ['asset', { kind: 'asset', assetId: uuid(1, 7) }],
  ])('the %s scope with every filter reads file, file_tag and tag only by key', (_, scope) => {
    for (const q of [{ query: 'oak' }, { tagNames: [seededTag] }, { role: 'texture' }, { kind: 'image' },
                     { query: 'oak', tagNames: [seededTag], role: 'reference', kind: 'image' }]) {
      expect(violations(plan(fileListSql({ scope, limit: 60, offset: 0, ...q })))).toEqual([]);
    }
  });
});
```

  Extend `KEY_COLUMNS.file` with the scope keys, so the inbox's `asset_id=?` (planned for `IS NULL` as `asset_id=?`) passes. Export `fileListSql(tx, q)` from `file-repository.ts` for the test (page and count statements).

- [ ] **Step 5: Implement the SQL.**
  - `registerSqlFunctions` is called in `openWorkspaceDatabase` before migrating.
  - Each query word becomes `(instr(af_fold(file.original_name), ?) > 0 or exists (select 1 from file_tag ft join tag t on t.id = ft.tag_id where ft.file_id = file.id and af_word_prefix(t.name, ?)))`, with the folded word bound.
  - Each tag id becomes `exists (select 1 from file_tag where file_id = file.id and tag_id = ?)`.
  - Tag ids are resolved first. Unknown tag → `{ items: [], total: 0 }` without running the list.
  - If the planner picks `SCAN file USING INDEX file_imported_at_idx` for the inbox, break the ordering index with unary `+file.imported_at`. The scale test decides.

- [ ] **Step 6: Write the IPC tests** (`library-ipc.test.ts`)

```ts
it('files:list rejects 11 tag names and a query over 200 characters', async () => {
  const tags = Array.from({ length: 11 }, (_, i) => `t${i}`);
  expect((await call('files:list', { scope: { kind: 'all' }, limit: 10, offset: 0, tagNames: tags })).error?.code).toBe('invalid_request');
  expect((await call('files:list', { scope: { kind: 'all' }, limit: 10, offset: 0, query: 'x'.repeat(201) })).error?.code).toBe('invalid_request');
});
it('files:list filters the inbox by query, tag and kind', async () => { /* import two files, tag one, expect one item */ });
```

- [ ] **Step 7: Run `pnpm test` and `pnpm typecheck`.** Expected: green.

- [ ] **Step 8: Commit and push.** Message: `feat(persistence): filter file lists by text, tags, role and kind`

---

### Task 3: `projects:list` filters, `imageCount` and matched tags

**Model:** opus

**Files:**
- Modify: `packages/contracts/src/library.ts`, `packages/contracts/src/ipc.ts`
- Modify: `packages/core/src/ports.ts`, `packages/core/src/projects.ts`, `packages/core/test/fakes.ts`
- Modify: `packages/persistence/src/project-repository.ts`, `packages/persistence/src/asset-filters.ts`
- Test: `packages/contracts/test/schemas.test.ts`, `packages/core/test/projects-assets.test.ts`, `packages/persistence/test/library-repositories.test.ts`, `packages/persistence/test/search-scale.test.ts`, `apps/desktop/test/library-ipc.test.ts`

**Interfaces:**
- Consumes: `MatchedTagSchema` (Task 1), `af_fold` (Task 2), the asset tag semantics of `carriesTag`.
- Produces:
  - `ProjectSummarySchema = ProjectSchema.extend({ assetCount: count, imageCount: count, matchedTags: z.array(MatchedTagSchema).optional() })`.
  - The `'projects:list'` request becomes `PageRequestSchema.extend({ query: z.string().max(200).optional(), status: ProjectStatusSchema.optional(), tagNames: z.array(z.string().max(200)).max(10).optional() })`.
  - `ProjectQuery extends Page { query?: string; status?: ProjectStatus; tagNames?: string[] }`, with `ProjectRepository.list(q: ProjectQuery)` and `listProjects(s, q: ProjectQuery)`.
  - In `asset-filters.ts`, `carriesTag` is generalised to `carriesTag(assetId: SQL, tagId: string): SQL`, and the existing call passes `outerAssetId`. Export it.
  - A project matches when `exists (select 1 from project_asset pa where pa.project_id = project.id and <carriesTag(pa.asset_id, t) for every t>)`. `matchedTags` is aggregated over exactly those member assets.

- [ ] **Step 1: Write the failing core-fake tests** (`projects-assets.test.ts`)

```ts
describe('project list filters', () => {
  it('query matches name or description, folded', async () => { /* "Forest" desc "Älter Wald" → query "alter" finds it */ });
  it('status filters', async () => {});
  it('a project matches only when one member asset carries all tags', async () => {
    // P1: asset X has "oak" and a complete file with "bark"; P2: asset Y "oak", asset Z "bark"
    const { items } = await listProjects(s, { limit: 60, offset: 0, tagNames: ['oak', 'bark'] });
    expect(items.map((p) => p.name)).toEqual(['P1']);
    expect(items[0]!.matchedTags).toEqual([
      { name: 'oak', displayName: 'oak', onAsset: true, onFiles: false },
      { name: 'bark', displayName: 'bark', onAsset: false, onFiles: true },
    ]);
  });
  it('imageCount counts complete image files over member assets', async () => {
    // 2 complete png, 1 failed png, 1 complete glb → 2
  });
  it('without filters matchedTags is absent and pickers still work', async () => {});
});
```

- [ ] **Step 2: Run them to verify they fail.** Run `pnpm --filter @assetforge/core test projects-assets.test.ts -t "project list filters"`. Expected: FAIL.

- [ ] **Step 3: Implement the contract, the use case (normalise like `listAssets`; unknown tag → empty page) and the fake.**

- [ ] **Step 4: Write the failing SQLite tests.**
  - `library-repositories.test.ts`: the cases of Step 1.
  - `search-scale.test.ts`: seed 200 projects with 50 members each, if they are absent.

```ts
it('projects:list with tags reads project_asset, asset_tag, file and file_tag only by key', () => {
  const lines = plan(projectListSql({ limit: 60, offset: 0, tagNames: [seededTag, otherTag] }));
  expect(violations(lines.filter((l) => !/^SCAN project\b/.test(l)))).toEqual([]);
});
it('matched tags of a project page take the same number of statements for 1 and 60 projects', () => { /* prepare spy as in Task 1 */ });
```

  Add `project_id` to `KEY_COLUMNS.project_asset`. Export `projectListSql(tx, q)` from `project-repository.ts`.

- [ ] **Step 5: Implement the SQL.**
  - `imageCount` is a correlated subquery joining `project_asset` and `file` on `asset_id`, with `kind = 'image' and status = 'complete'`, so it goes through `file_asset_id_kind_idx`.
  - `matchedTags` is one statement per page over `(project, tag)` for the page's ids.
  - Order stays `lower(name)`, then `id`.

- [ ] **Step 6: Write the IPC tests.** `projects:list` with 11 tag names gives `invalid_request`, with an unknown status gives `invalid_request`, and with `{ limit: 200, offset: 0 }` returns items with `imageCount`.

- [ ] **Step 7: Run `pnpm test` and `pnpm typecheck`.** Expected: green.

- [ ] **Step 8: Commit and push.** Message: `feat(persistence): filter projects by text, status and member tags`

---

### Task 4: Batch channels `files:assignMany`, `files:addTagMany`, `files:removeTagMany`

**Model:** opus

**Files:**
- Modify: `packages/contracts/src/ipc.ts`, `packages/contracts/src/files.ts`
- Modify: `packages/core/src/ports.ts`, `packages/core/src/asset-files.ts`, `packages/core/src/tags.ts`, `packages/core/test/fakes.ts`
- Modify: `packages/persistence/src/tag-repository.ts`
- Modify: `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/library-handlers.ts`
- Test: `packages/contracts/test/schemas.test.ts`, `packages/core/test/asset-files.test.ts`, `packages/core/test/tags.test.ts`, `packages/persistence/test/tag-repository.test.ts`, `apps/desktop/test/library-ipc.test.ts`

**Interfaces:**
- Consumes: `relocateFile(s, fileId, target)`, `tagName(input)`, `reindexAssets(tx, ids)`, `toRecords(tx, rows)`.
- Produces:
  - In `files.ts`:
    - `FileIdsSchema = z.array(z.uuid()).min(1).max(1000).refine(unique, 'duplicate ids')`
    - `AssignManyResultSchema = z.object({ items: z.array(z.object({ fileId: z.uuid(), file: FileRecordSchema.nullable(), error: IpcErrorSchema.nullable() })) })`
    - `FileRecordsSchema = z.object({ items: z.array(FileRecordSchema) })`

    `IpcErrorSchema` moves to its own module or `files.ts` imports it without a cycle. The implementer chooses.
  - Channels:
    - `'files:assignMany': { request: { fileIds, assetId, role }, response: AssignManyResultSchema }`
    - `'files:addTagMany'` / `'files:removeTagMany'`: `{ request: { fileIds, name: z.string().max(200) }, response: FileRecordsSchema }`
  - Core:
    - `assignFiles(s, r: { fileIds: readonly string[]; assetId: string; role: FileRole }): Promise<{ fileId: string; file: FileRecord | null; error: Error | null }[]>` loops `relocateFile` in request order and catches per item.
    - `addFileTags(s, r: { fileIds: readonly string[]; name: string }): Promise<FileRecord[]>` and `removeFileTags(...)`.
  - Port:
    - `TagRepository.addToFiles(r: { fileIds: readonly string[]; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<FileRecord[]>`
    - `TagRepository.removeFromFiles(r: { fileIds: readonly string[]; name: string; origin: TagOrigin }): Promise<FileRecord[]>`

    Each is one transaction that throws `NotFoundError` for any unknown file and `ValidationFailedError` for any non-complete file before writing. It reindexes each distinct asset once and returns the records in request order.
  - In `ipc.ts`, `toIpcError(error: unknown): IpcError` is extracted from `dispatch`'s catch, with the same logging and mapping. The handler of `files:assignMany` maps each item error with it.
  - Handlers: `'files:assignMany': (r) => manager.exclusive((s) => assignFiles(s, r))`, mapped. The tag batches use `manager.exclusive`.

- [ ] **Step 1: Write the failing schema tests**

```ts
it.each([[[]], [Array.from({ length: 1001 }, (_, i) => uuidN(i))], [[uuidN(1), uuidN(1)]]])(
  'file id lists of length 0, 1001 or with duplicates are rejected', (ids) => {
    expect(ipcContract['files:assignMany'].request.safeParse({ fileIds: ids, assetId: uuidN(9), role: 'reference' }).success).toBe(false);
    expect(ipcContract['files:addTagMany'].request.safeParse({ fileIds: ids, name: 'oak' }).success).toBe(false);
  });
```

- [ ] **Step 2: Write the failing core-fake tests**

```ts
it('assignFiles moves every file it can and reports the one failure in the middle', async () => {
  const res = await assignFiles(s, { fileIds: [a, missing, b], assetId, role: 'texture' });
  expect(res.map((r) => r.fileId)).toEqual([a, missing, b]);
  expect(res[0]!.file?.assetId).toBe(assetId);
  expect(res[1]).toMatchObject({ file: null });
  expect(res[1]!.error).toBeInstanceOf(NotFoundError);
  expect(res[2]!.file?.role).toBe('texture');
});
it('addFileTags is all or nothing', async () => {
  await expect(addFileTags(s, { fileIds: [a, pending], name: 'Oak' })).rejects.toBeInstanceOf(ValidationFailedError);
  expect((await getFile(a)).tags).toEqual([]);
  await expect(addFileTags(s, { fileIds: [a, missing], name: 'Oak' })).rejects.toBeInstanceOf(NotFoundError);
  const records = await addFileTags(s, { fileIds: [b, a], name: 'Oak' });
  expect(records.map((r) => r.id)).toEqual([b, a]);
  expect(records.every((r) => r.tags.some((t) => t.name === 'oak'))).toBe(true);
});
it('removeFileTags removes from all and ignores files without the tag', async () => {});
it('an invalid tag name fails with validation_failed before any lookup', async () => {});
```

- [ ] **Step 3: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 4: Implement the contracts, use cases, ports and fakes.**

- [ ] **Step 5: Write the failing SQLite tests** (`tag-repository.test.ts`). These are the all-or-nothing cases of Step 2 against SQLite, plus:

```ts
it('a tag batch over 300 files of one asset reindexes the asset once', async () => {
  const spy = vi.spyOn(searchIndex, 'reindexAsset');
  await db.tags.addToFiles({ fileIds: threeHundred, name: 'oak', displayName: 'oak', origin: 'manual', newId, now });
  expect(spy).toHaveBeenCalledTimes(1);
});
it('a tagged asset file is found by assets:list query afterwards', async () => {});
```

  If spying on an ES module export is not possible, the implementer may count the `asset_search` writes through the `prepare` spy instead.

- [ ] **Step 6: Implement the repository methods.**

- [ ] **Step 7: Write the IPC tests** (`library-ipc.test.ts`)

```ts
it('files:assignMany rejects 1001 ids and duplicate ids', async () => { /* invalid_request */ });
it('files:assignMany returns per-item results in request order with mapped errors', async () => {
  const res = await ok('files:assignMany', { fileIds: [f1, uuid, f2], assetId, role: 'reference' });
  expect(res.items.map((i: any) => i.error?.code ?? null)).toEqual([null, 'not_found', null]);
  expect(JSON.stringify(res)).not.toContain(base); // no absolute paths
});
it('files:addTagMany with a pending file fails with validation_failed and tags nothing', async () => {});
```

- [ ] **Step 8: Run `pnpm test` and `pnpm typecheck`.** Expected: green.

- [ ] **Step 9: Commit and push.** Message: `feat: batch channels for assigning and tagging several files`

---

### Task 5: Renderer test project, design tokens, `ui.ts`, icons, window appearance

**Model:** sonnet

**Files:**
- Modify: `apps/desktop/package.json` (add the four pinned dependencies), `pnpm-lock.yaml`
- Modify: `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/test/renderer/setup.ts`, `apps/desktop/test/renderer/fake-api.ts`, `apps/desktop/test/renderer/fixtures.ts`, `apps/desktop/test/renderer/smoke.test.tsx`
- Modify: `apps/desktop/src/renderer/src/index.css`, `apps/desktop/src/renderer/src/ui.ts`, `apps/desktop/index.html` (if it sets a light background)
- Modify: `apps/desktop/src/main/window.ts`
- Test: `apps/desktop/test/theme.test.ts`, `apps/desktop/test/renderer/smoke.test.tsx`

**Interfaces:**
- Produces:
  - Vitest config `test.projects`:
    - `{ test: { name: 'main', include: ['test/**/*.test.ts'], exclude: ['test/renderer/**'] } }`
    - `{ plugins: [react()], test: { name: 'renderer', environment: 'jsdom', include: ['test/renderer/**/*.test.tsx'], setupFiles: ['test/renderer/setup.ts'] } }`

    Both run under the existing `ELECTRON_RUN_AS_NODE=1 electron …vitest.mjs run` script. A single test runs with `pnpm --filter @assetforge/desktop test test/renderer/<file> -t "<name>"`.
  - `setup.ts` does four things:
    - stubs `ResizeObserver`, calling back once with `{ width: 1280, height: 800 }`;
    - stubs `HTMLElement.prototype` `clientWidth/clientHeight/offsetWidth/offsetHeight/getBoundingClientRect` to 1280 × 800;
    - stubs `HTMLDialogElement.prototype.showModal/close` where jsdom lacks them (set `open`, dispatch `close`), and `Element.prototype.scrollTo`;
    - runs `cleanup()` after each test.
  - In `fake-api.ts`:
    - `type FakeHandlers = { [C in IpcChannel]?: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>> }`
    - `installFakeApi(handlers: FakeHandlers): { calls: { channel: IpcChannel; request: unknown }[]; set<C extends IpcChannel>(channel: C, handler: FakeHandlers[C]): void }` defines `window.assetForge`. A handler that throws `fakeError(code: ErrorCode, message?: string)` becomes `{ ok: false, error }`. An unhandled channel gives `internal_error`.
    - `deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }`.
  - In `fixtures.ts`: `assetSummary(p?: Partial<AssetSummary>)`, `fileRecord(p?: Partial<FileRecord>)`, `projectSummary(p?: Partial<ProjectSummary>)`, `tagOf(displayName: string, origin?: TagOrigin): TagAssignment`, `pageOf<T>(items: T[], total?: number)`.
  - `index.css`: `@theme` with `--color-bg`, `--color-surface`, `--color-raised`, `--color-nav-active`, `--color-line`, `--color-line-strong`, `--color-text`, `--color-muted`, `--color-accent`, `--color-accent-soft`, `--color-danger`, `--color-danger-soft` (`#2a1015`), `--color-warning`, `--font-sans`, and the radii `--radius-control: 6px`, `--radius-tile: 8px`, `--radius-dialog: 10px`. Also `:root { color-scheme: dark }`, `body` on `bg-bg text-text font-sans text-[15px]`.
  - `ui.ts` exports `FOCUS`, `BUTTON_LOOK`, `BUTTON` (36 high, px 14), `ICON_BUTTON` (36 × 36), `BUTTON_INLINE` (32), `ICON_BUTTON_INLINE` (32 × 32), `INPUT`, `SELECT`, `CHIP`, `FILTER_CHIP`, `MUTED`, `BORDER`, `ALERT` (danger on danger-soft), `WARNING`, `LABEL` (14 muted), `PAGE_TITLE`, `SECTION_TITLE`, `TILE_TITLE`, `COUNT`. Every `*BUTTON*` contains `BUTTON_LOOK`. No `dark:` and no `slate-` anywhere in `ui.ts`.
  - In `window.ts`: `WINDOW_APPEARANCE = { backgroundColor: '#060b1d', minWidth: 1024, minHeight: 680 } as const`. `createMainWindow` sets `nativeTheme.themeSource = 'dark'` and spreads `WINDOW_APPEARANCE`.

- [ ] **Step 1: Add the dependencies.** Run `pnpm --filter @assetforge/desktop add -E lucide-react`, then `pnpm --filter @assetforge/desktop add -D -E jsdom @testing-library/react @testing-library/user-event`.

- [ ] **Step 2: Write the failing tests**

```ts
// test/theme.test.ts (main project)
it('declares every design token with the spec value', () => {
  const css = readFileSync(new URL('../src/renderer/src/index.css', import.meta.url), 'utf8');
  for (const [name, value] of Object.entries({ bg: '#060b1d', surface: '#0c1428', raised: '#131d36', 'nav-active': '#26324d',
    line: '#2a3550', 'line-strong': '#4a5670', text: '#e8ebf2', muted: '#97a1b5', accent: '#38c6f4',
    'accent-soft': '#0f2b3d', danger: '#f87171', 'danger-soft': '#2a1015', warning: '#fbbf24' }))
    expect(css).toMatch(new RegExp(`--color-${name}:\\s*${value};`, 'i'));
});
it('the window background equals the page token and the minimum size is 1024 × 680', () => {
  expect(WINDOW_APPEARANCE).toEqual({ backgroundColor: '#060b1d', minWidth: 1024, minHeight: 680 });
});
it('every button style shares one look and ui.ts has no light/dark literals', () => {
  for (const s of [BUTTON, ICON_BUTTON, BUTTON_INLINE, ICON_BUTTON_INLINE]) expect(s).toContain(BUTTON_LOOK);
  expect(readUi()).not.toMatch(/dark:|slate-/);
});
// test/renderer/smoke.test.tsx
it('renders into jsdom and reaches the fake API', async () => {
  const api = installFakeApi({ 'assetTypes:list': () => [] });
  render(<button onClick={() => void window.assetForge.invoke('assetTypes:list', {})}>x</button>);
  await userEvent.click(screen.getByRole('button'));
  expect(api.calls.map((c) => c.channel)).toEqual(['assetTypes:list']);
});
```

  Adjust the `assetTypes:list` request and response shapes to the contract.

- [ ] **Step 3: Run `pnpm --filter @assetforge/desktop test`.** Expected: the new tests FAIL and the old ones pass, which proves both projects run.

- [ ] **Step 4: Implement the config, setup, fake API, tokens, `ui.ts` and window.** Components keep compiling. Old class names in screens are replaced in their screen tasks, and Task 15 asserts that none remain.

- [ ] **Step 5: Run `pnpm test`, `pnpm typecheck` and `pnpm --filter @assetforge/desktop build`.** Expected: green.

- [ ] **Step 6: Commit and push.** Message: `feat(desktop): jsdom renderer tests, dark design tokens and window appearance`

---

### Task 6: List state, search debounce, stale-while-loading pages, selection model

**Model:** opus

**Files:**
- Modify: `apps/desktop/src/renderer/src/paged-loader.ts`, `apps/desktop/src/renderer/src/hooks/usePagedList.ts`, `apps/desktop/src/renderer/src/list-state.ts`
- Create: `apps/desktop/src/renderer/src/hooks/useDebouncedValue.ts`, `apps/desktop/src/renderer/src/selection.ts`
- Test: `apps/desktop/test/paged-loader.test.ts`, `apps/desktop/test/list-state.test.ts`, `apps/desktop/test/selection.test.ts`, `apps/desktop/test/renderer/debounce.test.tsx`

**Interfaces:**
- Produces:
  - `PagedLoader<T>`:
    - `displayed: PagedState<T>`: the state shown. It equals `state` once page 0 of the current key has settled, and holds the previous `displayed` until then.
    - `pending: boolean` is `displayed.key !== state.key`.
    - After `setKey`, `pump` requests page 0 before any wanted page.
    - `loadThrough(count: number): Promise<void>` requests every missing page with an index below `ceil(min(count, total)/PAGE_SIZE)`, within `maxInFlight`. It resolves when they have settled and rejects if the key changes meanwhile.
  - `usePagedList<T>(key, fetchPage, wantedPages): { state: PagedState<T>; pending: boolean; retry(page: number): void; loadThrough(count: number): Promise<void> }`, where `state` is now `displayed`.
  - `SEARCH_DEBOUNCE_MS = 250` and `useDebouncedValue<T>(value: T, delayMs: number): T`. An empty string passes through at once, so Esc clears immediately.
  - `list-state.ts`:

```ts
type Choice<T extends string> = T | '';
interface AssetFilters { typeId: string; status: Choice<AssetStatus>; projectId: string; query: string;
  tagNames: string[]; fileRole: Choice<FileRole>; fileKind: Choice<FileKind> }
interface AssetListState { filters: AssetFilters; scrollOffset: number; openedIndex: number | null; selectedId: string | null }
interface FileFilters { query: string; role: Choice<FileRole>; kind: Choice<FileKind>; tagNames: string[] }
interface InboxListState { filters: FileFilters; scrollOffset: number }
interface ProjectFilters { query: string; status: Choice<ProjectStatus>; tagNames: string[] }
interface ProjectListState { filters: ProjectFilters; scrollOffset: number; selectedId: string | null }
type AssetTab = 'files' | 'workflow' | 'projects' | 'relations';
const NO_FILTERS: AssetFilters; const NO_FILE_FILTERS: FileFilters; const NO_PROJECT_FILTERS: ProjectFilters;
function listKey(filters: AssetFilters | FileFilters | ProjectFilters, extra?: string): string; // keys sorted, tagNames sorted
function hasFilters(filters: AssetFilters | FileFilters | ProjectFilters): boolean;
function toAssetQuery(f: AssetFilters): Omit<IpcRequest<'assets:list'>, 'limit' | 'offset'>;   // drops '' and []
function toFileQuery(scope: FileScope, f: FileFilters): Omit<IpcRequest<'files:list'>, 'limit' | 'offset'>;
function toProjectQuery(f: ProjectFilters): Omit<IpcRequest<'projects:list'>, 'limit' | 'offset'>;
```

  `filterKey` is replaced by `listKey`. Existing callers are updated. `readView`/`writeView` stay as they are.
  - `selection.ts`:

```ts
const MAX_SELECTION = 1000;
interface FileSelection { readonly selected: ReadonlyMap<string, FileRecord>; readonly anchor: number | null }
const NO_SELECTION: FileSelection;
type ItemAt = (index: number) => FileRecord | null;            // null = not loaded
function clickSelect(sel: FileSelection, index: number, itemAt: ItemAt, mods: { ctrl: boolean; shift: boolean }): FileSelection;
function toggleSelect(sel: FileSelection, index: number, itemAt: ItemAt): FileSelection;
function selectAll(items: readonly FileRecord[]): FileSelection;   // first MAX_SELECTION, anchor null
function refreshSelected(sel: FileSelection, records: readonly FileRecord[]): FileSelection; // replace by id
function dropSelected(sel: FileSelection, ids: Iterable<string>): FileSelection;
function eligibleFiles(sel: FileSelection): FileRecord[];        // status 'complete', selection order
function sharedTags(files: readonly FileRecord[]): TagAssignment[]; // carried by every file; [] for none
```

  Shift selects the range from `anchor` to `index` over loaded items and replaces the selection, capped at `MAX_SELECTION`. Ctrl toggles and sets the anchor. A plain click selects only that item and sets the anchor.

- [ ] **Step 1: Write the failing loader tests** (`paged-loader.test.ts`, using the existing `harness`)

```ts
it('keeps the previous results displayed until page 0 of the new key settles', () => {
  const h = harness('A'); h.loader.setActive(true); h.loader.setWanted([0]); h.calls[0]!.resolve(100);
  h.loader.setKey('B'); h.loader.setWanted([1]);
  expect(h.loader.displayed.key).toContain('A'); expect(h.loader.pending).toBe(true);
  expect(h.calls.at(-1)!.offset).toBe(0);                       // page 0 first
  h.calls.at(-1)!.resolve(5);
  expect(h.loader.displayed.key).toContain('B'); expect(h.loader.pending).toBe(false);
});
it('a late page of a superseded key is never displayed', () => {
  const h = harness('A'); h.loader.setActive(true); h.loader.setWanted([0]); h.calls[0]!.resolve(100);
  h.loader.setKey('B'); const b = h.calls.at(-1)!; h.loader.setKey('C'); const c = h.calls.at(-1)!;
  c.resolve(3); b.resolve(50);
  expect(h.loader.displayed.key).toContain('C'); expect(h.loader.displayed.total).toBe(3);
});
it('a failed first page of the new key takes over so its Retry shows', () => {});
it('loadThrough requests the missing pages up to the count within maxInFlight', async () => {});
```

  `loadThrough` needs a harness that resolves automatically. The implementer may add a variant.

- [ ] **Step 2: Write the failing state tests** (`list-state.test.ts`, `selection.test.ts`)

```ts
it('listKey is independent of tag order and toAssetQuery drops empty values', () => {
  expect(listKey({ ...NO_FILTERS, tagNames: ['b', 'a'] })).toBe(listKey({ ...NO_FILTERS, tagNames: ['a', 'b'] }));
  expect(toAssetQuery({ ...NO_FILTERS, query: 'oak', fileKind: 'image' })).toEqual({ query: 'oak', fileKind: 'image' });
  expect(hasFilters(NO_FILE_FILTERS)).toBe(false);
});
describe('selection model', () => {
  it('click selects one, ctrl toggles, shift selects the range from the anchor', () => {
    let s = clickSelect(NO_SELECTION, 2, at, { ctrl: false, shift: false }); expect(ids(s)).toEqual(['f2']);
    s = clickSelect(s, 4, at, { ctrl: true, shift: false }); expect(ids(s)).toEqual(['f2', 'f4']);
    s = clickSelect(s, 0, at, { ctrl: false, shift: true }); expect(ids(s)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
  });
  it('selectAll caps at 1000', () => { expect(selectAll(files(1200)).selected.size).toBe(1000); });
  it('eligibleFiles excludes pending and failed files', () => {});
  it('sharedTags keeps only tags every file carries', () => {
    expect(sharedTags([withTags('oak', 'bark'), withTags('bark')]).map((t) => t.name)).toEqual(['bark']);
    expect(sharedTags([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Write the failing debounce DOM test** (`test/renderer/debounce.test.tsx`, fake timers)

```tsx
it('only the last query of a burst is requested after 250 ms', async () => {
  vi.useFakeTimers(); const seen: string[] = [];
  function Probe({ q }: { q: string }) { const d = useDebouncedValue(q, SEARCH_DEBOUNCE_MS); seen.push(d); return null; }
  const { rerender } = render(<Probe q="" />);
  rerender(<Probe q="o" />); rerender(<Probe q="oa" />); rerender(<Probe q="oak" />);
  act(() => vi.advanceTimersByTime(249)); expect(seen.at(-1)).toBe('');
  act(() => vi.advanceTimersByTime(1)); expect(seen.at(-1)).toBe('oak'); expect(seen).not.toContain('oa');
});
it('clearing to the empty string is not delayed', () => {});
```

- [ ] **Step 4: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 5: Implement the loader, hook, list state and selection.** Update `AssetsScreen` and `WorkspaceShell` only as far as the new types require. Default the new fields; no UI change.

- [ ] **Step 6: Run `pnpm test` and `pnpm typecheck`.** Expected: green.

- [ ] **Step 7: Commit and push.** Message: `feat(desktop): keep results while a search loads, list state and selection model`

---

### Task 7: Shared building blocks

**Model:** opus

**Files:**
- Create: `apps/desktop/src/renderer/src/components/` `Dialog.tsx`, `Menu.tsx`, `Tabs.tsx`, `Link.tsx`, `TagChip.tsx`, `TagList.tsx`, `TagCombobox.tsx`, `TagRow.tsx`, `TagFilter.tsx`, `SearchField.tsx`, `FilterBar.tsx`, `SelectionBar.tsx`
- Test: `apps/desktop/test/renderer/` `dialog-menu-tabs.test.tsx`, `tags.test.tsx`, `search-field.test.tsx`

**Interfaces:**
- Consumes: `ui.ts` (Task 5), `call`/`describeError` (`api.ts`), `normalizeTagName`, `normalizeTagPrefix`, `MAX_TAG_LENGTH`.
- Produces (props are exact; markup is the implementer's choice within the tokens):
  - `Dialog({ open, title, onClose, initialFocusRef?, size?: 'form' | 'detail', children }: { open: boolean; title: string; onClose(): void; initialFocusRef?: RefObject<HTMLElement | null>; size?: 'form' | 'detail'; children: ReactNode })`:
    - native `<dialog>` with `showModal`, `aria-labelledby` its title, radius 10;
    - `detail` = `min(92vw, 1100px)` × `min(88vh, 760px)`;
    - Esc (`cancel`) calls `onClose`;
    - on close, focus returns to the element focused before opening.
  - `interface MenuItem { label: string; onSelect(): void; disabled?: boolean; title?: string }` and `Menu({ label, items, icon? }: { label: string; items: MenuItem[]; icon?: ReactNode })`:
    - the trigger is an `ICON_BUTTON` with `aria-label={label}`, `aria-haspopup="menu"` and `aria-expanded`;
    - `role="menu"` / `menuitem`;
    - ↑/↓/Home/End move, Enter/Space select, Esc or Tab closes;
    - focus returns to the trigger; an outside click closes.
  - `Tabs<T extends string>({ tabs, active, onChange, label, children }: { tabs: { id: T; label: string; count?: number | null }[]; active: T; onChange(id: T): void; label: string; children: ReactNode })`:
    - `role="tablist"` with `aria-label`;
    - ←/→/Home/End activate and focus a tab; only the active tab has `tabIndex 0`;
    - one `role="tabpanel"` with `aria-labelledby` and `tabIndex 0`.
  - `Link({ onFollow, children, title?, className? }: { onFollow(): void; children: ReactNode; title?: string; className?: string })` renders `<a href="#">` (accent text) and calls `preventDefault`.
  - `TagChip({ tag, onRemove?, filter?, matched? }: { tag: { name: string; displayName: string; origin?: TagOrigin }; onRemove?(): void; filter?: boolean; matched?: boolean })`:
    - `data-origin`;
    - the remove control is a button with `aria-label={\`Remove ${tag.displayName}\`}`;
    - `filter` uses `FILTER_CHIP`, `matched` gets an accent border.
  - `TagList({ tags, kind, max, matched? }: { tags: readonly { name: string; displayName: string }[]; kind: 'asset' | 'file'; max: number; matched?: ReadonlySet<string> })`:
    - one line, read-only;
    - with `kind 'file'` it starts with one `ImageIcon` (16 px, `aria-label="Image tags"`); the asset kind renders `aria-label="Asset tags"` on the list;
    - overflow shows "+n" with every name joined in `title`.
  - `TagCombobox({ value, onValueChange, onCommit, placeholder, label, title?, inputRef?, onKeyDown?, disabled? }: { value: string; onValueChange(v: string): void; onCommit(text: string): void; placeholder: string; label: string; title?: string; inputRef?: Ref<HTMLInputElement>; onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void; disabled?: boolean })`:
    - ARIA 1.2: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`, and a `role="listbox"` of `role="option"`;
    - suggestions come from `tags:suggest { prefix: normalizeTagPrefix(value), limit: 8 }`, and superseded answers are dropped (`latestOnly`);
    - ↑/↓ move, Enter commits the active option's `displayName` or the typed text, Esc closes the list (and is left to the caller when it is already closed).
  - `TagRow({ label, kind, tags, onAdd, onRemove, disabled?, inputRef? }: { label: 'Asset tags' | 'Image tags'; kind: 'asset' | 'file'; tags: readonly TagAssignment[]; onAdd(displayName: string): Promise<void>; onRemove(name: string): Promise<void>; disabled?: boolean; inputRef?: Ref<HTMLInputElement> })`:
    - the input placeholder is "+ Add tag";
    - Enter adds;
    - Backspace in the empty input focuses the last chip;
    - Delete or Backspace on a focused chip removes it, and focus moves to the next chip, else the previous one, else the input;
    - text for which `normalizeTagName` returns `null` sends nothing and shows an inline `ALERT` ("Tags need a letter or digit and at most 64 characters.");
    - a rejected `onAdd`/`onRemove` shows `describeError` inline.
  - `TagFilter({ value, onChange, title? }: { value: readonly string[]; onChange(names: string[]): void; title?: string })`:
    - a combobox that adds `normalizeTagName(text)` (duplicates ignored), with filter chips showing `name` and a remove button;
    - at 10 tags the input is disabled with `title="At most 10 tags"`.
  - `SearchField({ value, onChange, placeholder, label }: { value: string; onChange(v: string): void; placeholder: string; label: string })`:
    - `type="search"`, magnifier icon, `data-search-field`, `title="Ctrl+F"`, `maxLength 200`;
    - Esc with text calls `onChange('')` and stops propagation.
  - `FilterBar({ children, resultCount, onClear, countTitle? }: { children: ReactNode; resultCount: string | null; onClear: (() => void) | null; countTitle?: string })`: toolbar rows 40 high, 12 apart; the right-aligned count; "Clear filters" only when `onClear` is set.
  - `SelectionBar({ count, onClear, children }: { count: number; onClear(): void; children: ReactNode })`: renders only for `count ≥ 1`, with "*n* selected", the action children and "Clear selection".

- [ ] **Step 1: Write the failing DOM tests**

```tsx
// dialog-menu-tabs.test.tsx
it('Esc closes the dialog and focus returns to the trigger', async () => { /* open via button, Esc, expect activeElement trigger, onClose called */ });
it('the menu opens on Enter, moves with arrows, selects with Enter and returns focus', async () => {
  // items Details, Detach; ArrowDown twice → "Detach" focused; Enter → onSelect of Detach; trigger focused; menu gone
});
it('Esc closes the menu without selecting', async () => {});
it('tabs switch with arrow keys and expose one tabpanel', async () => {
  // ArrowRight on "Files" → onChange('workflow'); only active tab tabIndex 0; tabpanel aria-labelledby = active tab id
});
// tags.test.tsx
it('Enter adds the typed tag', async () => { /* onAdd('Oak') */ });
it('Backspace in the empty input focuses the last chip and Delete removes it keeping focus in the row', async () => {
  // tags oak, bark → Backspace → activeElement is "bark" chip → Delete → onRemove('bark'); activeElement is "oak" chip
});
it('invalid tag text sends nothing and shows an alert', async () => {
  // type "!!!" Enter → onAdd not called, role alert visible, input value still "!!!"; same for 65 × "a"
});
it('the combobox shows suggestions and a superseded answer is dropped', async () => {
  // tags:suggest deferred for "o" resolves after "oa"; listbox shows only the "oa" answer; ArrowDown+Enter commits its displayName
});
it('file tag lists start with one image icon; asset tag lists do not', () => {
  render(<><TagList kind="file" tags={[tagOf('bark'), tagOf('moss')]} max={3} /><TagList kind="asset" tags={[tagOf('oak')]} max={3} /></>);
  expect(screen.getAllByLabelText('Image tags')).toHaveLength(1);
  expect(screen.getByLabelText('Asset tags').querySelector('svg')).toBeNull();
});
it('overflow shows +n with all names in the title', () => { /* 5 tags, max 3 → "+2", title "a, b, c, d, e" */ });
it('the tag filter stops at 10 tags', async () => {});
// search-field.test.tsx
it('Esc clears the search field', async () => {});
```

- [ ] **Step 2: Run them to verify they fail.** Run `pnpm --filter @assetforge/desktop test test/renderer`. Expected: FAIL.

- [ ] **Step 3: Implement the components.** Icons come from `lucide-react`: `Image as ImageIcon`, `Search`, `X`, `MoreHorizontal`, `Folder`, `Plus`, `ArrowLeft`, `LayoutGrid`, `Table`. The implementer adds others as needed.

- [ ] **Step 4: Run `pnpm test` and `pnpm typecheck`.** Expected: green.

- [ ] **Step 5: Commit and push.** Message: `feat(desktop): shared dialog, menu, tabs, tag and search components`

---

### Task 8: AppShell, Page, storage banner, Workspaces screen

**Model:** sonnet

**Files:**
- Create: `apps/desktop/src/renderer/src/components/AppShell.tsx`, `apps/desktop/src/renderer/src/components/Page.tsx`
- Modify: `apps/desktop/src/renderer/src/api.ts`, `apps/desktop/src/renderer/src/App.tsx`, `apps/desktop/src/renderer/src/components/WorkspaceShell.tsx`, `apps/desktop/src/renderer/src/screens/WorkspaceScreen.tsx`
- Test: `apps/desktop/test/renderer/shell.test.tsx`, `apps/desktop/test/renderer/workspaces.test.tsx`

**Interfaces:**
- Consumes: `Dialog`, `Menu`, `Link` (Task 7); the list-state types (Task 6).
- Produces:
  - In `api.ts`: `onStorageUnreachable(listener: () => void): () => void`. `call()` notifies the listeners whenever a result fails with `storage_unreachable`.
  - `AppShell({ workspaceName, rootPath, section, busy, onNavigate, onClose, children }: { workspaceName: string; rootPath: string; section: 'assets' | 'projects' | 'inbox' | null; busy: boolean; onNavigate(section: 'assets' | 'projects' | 'inbox'): void; onClose(): void; children: ReactNode })`:
    - The header is 76 high: name 24/600, then the path in accent with `title`, then "Workspaces" (`ArrowLeft`), which calls `onClose`.
    - The nav is 200 wide, with the links Assets, Projects and Inbox, each with an icon and `aria-current="page"` on the active one.
    - While `busy`, the nav and "Workspaces" are disabled (`aria-disabled`, no navigation) with the title "Import in progress".
    - The alert region sits under the header, with a `WARNING` banner plus "Retry" on `storage_unreachable`. Retry bumps an internal `reloadKey` that keys `children`.
    - `Ctrl+F` focuses `main [data-search-field]`.
  - `Page({ title, count?, countTitle?, actions?, toolbar?, detail?, children }: { title: ReactNode; count?: number | null; countTitle?: string; actions?: ReactNode; toolbar?: ReactNode; detail?: ReactNode; children: ReactNode })`: padding 24, title 28/600 with the count 28/400 muted, and the `detail` column 300 wide (264 below 1280 px) behind a 1 px divider.
  - `WorkspaceShell` holds `ShellState { assetList: AssetListState; projectList: ProjectListState; inboxList: InboxListState; assetTab: AssetTab }` in React state. It renders the screens inside `AppShell`. The `section` derives from `View` (`asset` → `assets`, `project` → `projects`).

**Features that must survive:**
- **Workspaces.** The list of known workspaces shows name, rootPath and last opened. Remove goes through `workspace:remove` (host confirmation) and keeps its tooltip. Open goes through `workspace:open`. The mapped error stays, and so does the row.
- **Create form.** The name field has autofocus. Choose/Change location keeps its tooltip. Enter without a location opens the picker. The resolved path is shown with `title` and is re-resolved before create.
- **Open folder.** It uses `dialog:pickDirectory` and then `workspace:open`.
- **Shell.** "Close workspace" (now "Workspaces") calls `workspace:close`. Nav is disabled while an import runs. The shell is keyed by workspace id.

- [ ] **Step 1: Write the failing DOM tests**

```tsx
it('the active section is marked and nav is disabled while busy', async () => {
  render(<AppShell section="projects" busy ... />);
  expect(screen.getByRole('link', { name: /Projects/ }).getAttribute('aria-current')).toBe('page');
  // rerender busy → click "Assets" → onNavigate not called; title "Import in progress"
});
it('a storage_unreachable failure shows the banner and Retry remounts the page', async () => {
  // child calls call('assets:list') which fails storage_unreachable → role alert with "Retry"; click → child mounted twice; banner gone
});
it('Ctrl+F focuses the page search field', async () => {});
it('workspaces are sorted by last opened, newest first, and the row menu removes', async () => {
  // two workspaces; first row name is the newer; "…" menu → Remove → calls workspace:remove with its id
});
it('New workspace opens a dialog; Enter without a location opens the folder picker', async () => {});
it('the resolved path is re-resolved before create', async () => { /* expect workspace:resolveCreatePath twice, then workspace:create */ });
it('an empty list shows the table header and both page actions, no prose', () => {});
it('a failed open shows the mapped message and the row stays', async () => {});
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement it.** The Workspaces page:
  - Header: the app title "AssetForge" with a divider, the page title "Workspaces" with the count, and the actions "Open folder" (`Folder`) and "New workspace" (`Plus`).
  - Table: Name (folder icon + bold), Location, Last opened (`formatDateTime`), then "Open" and a `Menu` with "Remove". The footer shows "1 workspace" / "n workspaces".
  - Loading shows skeleton rows.

- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck` and `pnpm --filter @assetforge/desktop build`.** Expected: green.

- [ ] **Step 5: Commit and push.** Message: `feat(desktop): application shell, page layout and workspaces table`

---

### Task 9: Assets gallery, table and Selection column

**Model:** opus

**Files:**
- Modify: `apps/desktop/src/renderer/src/screens/AssetsScreen.tsx`, `apps/desktop/src/renderer/src/components/AssetGrid.tsx`, `apps/desktop/src/renderer/src/components/AssetTable.tsx`
- Create: `apps/desktop/src/renderer/src/components/AssetSelection.tsx`, `apps/desktop/src/renderer/src/components/NewAssetDialog.tsx`
- Test: `apps/desktop/test/renderer/assets.test.tsx`

**Interfaces:**
- Consumes: `AssetSummary.tags/coverTags` (Task 1); `usePagedList` `{ state, pending }` and `AssetListState`/`toAssetQuery`/`listKey`/`hasFilters` (Task 6); `SearchField`, `TagFilter`, `FilterBar`, `TagList`, `Dialog` (Task 7); `Page` (Task 8).
- Produces:
  - `AssetsScreen({ state, onStateChange, onOpen }: { state: AssetListState; onStateChange(s: AssetListState): void; onOpen(id: string): void })`.
  - `AssetViewProps` gains `selectedId: string | null` and `onSelect(index: number, asset: AssetSummary): void`. `onOpen` stays.
  - The view remount key is `paged.state.key`.
  - Tile width 240, cover frame 240 × 180, tile height 320 (the implementer may adjust within the grid). The table row height stays 48.
  - `AssetSelection({ asset, typeName, onOpen }: { asset: AssetSummary | null; typeName(id: string): string; onOpen(): void })` loads the project names via `assignments:listByAsset`.

**Features that must survive:**
- Create an asset (name and type, then open it). Now in "New asset".
- Type, status and project filters. The name search becomes `query`.
- The count. The Grid/Table toggle with tooltips "Show as tiles" / "Show as table", remembered through `readView`/`writeView`.
- Restore of scroll offset and opened index. Boot Retry. The page Retry slot. Roving tabindex.
- The cover with fallback. Workflow progress. The table's Last change.

- [ ] **Step 1: Write the failing DOM tests**

```tsx
it('the title count comes from an unfiltered limit-1 call', async () => { /* expect a call assets:list {limit:1, offset:0} and "12" */ });
it('typing searches after 250 ms and old tiles stay until the new page arrives', async () => {
  // fake timers; first page "Oak tree"; type "pine" → after 250 ms one assets:list with query "pine" (deferred)
  // → "Oak tree" still visible; resolve → "Pine" visible, "Oak tree" gone; no "o"/"pi" request
});
it('a single click selects and fills the Selection column; double-click and Enter open', async () => {
  // click tile → aria-selected true, column shows name, "Asset tags", project names "P1, P2"; dblclick → onOpen(id)
});
it('arrow keys move focus and selection together', async () => {});
it('tiles separate cover file tags from asset tags', () => {
  // asset tags oak; coverTags bark → within tile: getByLabelText('Image tags') contains "bark", getByLabelText('Asset tags') contains "oak"
});
it('list state round trip keeps filters, selection and scroll offset', async () => {
  // onStateChange receives {filters:{query:'oak', tagNames:['bark'], fileKind:'image', …}, selectedId}; remount with it → same request and selection
});
it('empty library, no result and boot failure states', async () => {
  // total 0 unfiltered → "No assets"; filtered 0 → "No matching assets" + "Clear filters"; failure → Retry
});
it('project names that fail to load show an alert inside the column', async () => {});
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement it.**
  - Filter row 1: search ("Search assets"), then Type, Status and Project selects (first option "All types" / "All statuses" / "All projects"), then the toggle.
  - Filter row 2: `TagFilter`, Role (`label()`), File type (Image, 3D model, Document, Other), the count "n asset(s)" and "Clear filters".
  - Table columns: cover, Name, Type, Status, Progress, Asset tags, Image tags, Last change.
  - A selected tile has a 2 px accent border and `aria-selected`.

- [ ] **Step 4: Run `pnpm test` and `pnpm typecheck`.** Expected: green.

- [ ] **Step 5: Commit and push.** Message: `feat(desktop): asset gallery with search, tag filters and selection column`

---

### Task 10: FileBrowser with endless scrolling and multi-select

**Model:** opus

**Files:**
- Create: `apps/desktop/src/renderer/src/components/FileBrowser.tsx`, `apps/desktop/src/renderer/src/components/FileTable.tsx`, `apps/desktop/src/renderer/src/file-actions.ts`
- Modify: `apps/desktop/src/renderer/src/components/FileTile.tsx`
- Delete: `apps/desktop/src/renderer/src/components/FileGrid.tsx` (once nothing imports it, after Tasks 11 and 14), `Pager.tsx` stays for the project screen
- Test: `apps/desktop/test/renderer/file-browser.test.tsx`

**Interfaces:**
- Consumes: `files:list` filters (Task 2); `selection.ts`, `usePagedList.loadThrough`, `FileFilters`/`toFileQuery` (Task 6); `Menu`, `TagList`, `SearchField`, `TagFilter`, `FilterBar` (Task 7); `useVirtualRows`, `gallery.ts`.
- Produces:

```ts
interface FileBrowserProps {
  scope: FileScope;
  filters: FileFilters; onFiltersChange(f: FileFilters): void;
  showRoleFilter: boolean;                       // asset tab yes, inbox no
  view: AssetView; onViewChange(v: AssetView): void;
  restore?: ViewRestore; positionRef?: MutableRefObject<ViewPosition | null>;
  selection: FileSelection; onSelectionChange(s: FileSelection): void;
  reloadToken: number;                           // part of the list key; bump after a mutation
  coverFileId?: string | null;                   // "Cover" badge
  onOpen(file: FileRecord): void;                // Enter, magnifier, "Details"
  menuItems(file: FileRecord): MenuItem[];       // the tile "…" menu
  emptyText: string;                             // "No files" / "Inbox is empty"
  onTotal?(total: number | null): void;          // footer and tab counts
}
function FileBrowser(props: FileBrowserProps): JSX.Element;
interface FileActionContext {
  cover: { isEffective: boolean; isChosen: boolean } | null;  // null in the inbox
  onDetails(): void; onSetCover?(fileId: string | null): void; onDetach?(): void;
}
function fileMenuItems(file: FileRecord, ctx: FileActionContext): MenuItem[];
// Details; Open externally (only complete && openable) → files:openExternal; Show in folder → files:showInFolder;
// Use as cover (complete && previewable, not chosen) / Use automatic cover (chosen); Detach (when onDetach)
```

  - Grid: `role="listbox"`, `aria-multiselectable="true"`. Tiles are `role="option"` with `aria-selected` and keep `data-file-tile`/`data-file-id`.
  - Each tile has a checkbox in the top left (`aria-label={\`Select ${name}\`}`, `tabIndex -1`) and the `Menu` "…" in the top right (`label="File actions"`). A magnifier `ICON_BUTTON` (`aria-label="Details"`) shows on hover and focus.
  - The tile shows the name and the meta line "Role · FORMAT · size" (role only with an asset scope; "FORMAT | size" in the inbox), then `TagList kind="file"`.
  - Pending and failed imports show their status in the frame (failed in `danger`), as today.
  - Keys: click/Ctrl/Shift as in `clickSelect`; Space toggles the focused tile; Ctrl+A calls `loadThrough(MAX_SELECTION)` and then `selectAll`, and the count carries `title="At most 1000 files can be selected"` when total > 1000; Esc clears; Enter opens. Arrow keys follow the roving tabindex.
  - The table view has the columns Name, Role (asset scope), Type, Size, Imported and Tags, with the same selection rules.

- [ ] **Step 1: Write the failing DOM tests**

```tsx
it('click selects one, Ctrl+click toggles, Shift+click selects the range', async () => {});
it('Space toggles the focused file and Esc clears the selection', async () => {});
it('Ctrl+A loads the missing pages and selects at most 1000', async () => {
  // total 1200, page size 60 → files:list calls cover offsets 0..960; onSelectionChange receives 1000 entries; count has the cap title
});
it('Enter and the magnifier open the detail; the tile menu offers only allowed actions', async () => {
  // failed file: no "Open externally"; complete openable: "Open externally" calls files:openExternal on the fake API
});
it('pending and failed imports show their status in the frame', () => {});
it('filters go into files:list and an empty result shows the empty text', async () => {
  // query "oak" (after 250 ms), kind "image", tagNames ["bark"] → request {scope, query:'oak', kind:'image', tagNames:['bark']}
});
it('bumping reloadToken refetches', async () => {});
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement it.** Reuse `columnsForWidth`, `rowItems`, `pagesForRows`, `nextFocusIndex` and `useVirtualRows`. Remove `useFileDetail` once Tasks 11 and 14 no longer use it; it can go in its own task if needed.

- [ ] **Step 4: Run `pnpm test` and `pnpm typecheck`.** Expected: green.

- [ ] **Step 5: Commit and push.** Message: `feat(desktop): file browser with endless scrolling and multi-select`

---

### Task 11: File detail dialog

**Model:** sonnet

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/FileDetailDialog.tsx`
- Test: `apps/desktop/test/renderer/file-dialog.test.tsx`

**Interfaces:**
- Consumes: `Dialog size="detail"`, `TagRow`, `TagList`, `Menu`, `Link` (Task 7); `fileMenuItems` (Task 10).
- Produces:

```ts
interface FileDetailDialogProps {
  file: FileRecord;
  asset: { id: string; name: string; tags: readonly TagAssignment[] } | null;   // null in the inbox
  actions: FileActionContext;                  // drives the "More" menu (without "Details")
  roleControl: ReactNode;                      // asset: role select; inbox: assign control (role + asset picker + "Assign")
  onFileChange(file: FileRecord): void;        // after files:addTag / files:removeTag
  onOpenAsset?(assetId: string): void;
  onClose(): void;
}
```

  - The header shows the file name | the asset name, plus a close `ICON_BUTTON` (`aria-label="Close"`) that gets the initial focus.
  - The left panel is 320 wide:
    - "Details": file name, format, size, imported, status when not complete, `file.error` in `ALERT` when failed;
    - `roleControl`;
    - "Image tags" `TagRow` (complete files only) through `files:addTag`/`files:removeTag`;
    - a divider;
    - "Asset" `Link` and "Asset tags" `TagList kind="asset"` (asset files);
    - a "More" `Menu`.
  - On the right, the 1024 px detail preview (`previewUrl`), fitted, or the format tile.

**Features that must survive:**
- The preview. Role, Type, Size, Imported, Status and the error.
- Open externally (complete && openable). Show in folder. Use as cover / Use automatic cover, with tooltips.
- Close, with focus returning to the tile.
- The role change through `files:assign`. Detach through `files:unassign` (tooltip "The file is kept and moves to the inbox"). The inbox Assign control (role and asset picker).

- [ ] **Step 1: Write the failing DOM tests**

```tsx
it('focus starts on Close; Esc closes and focus returns to the opener', async () => {});
it('adding an image tag calls files:addTag and shows the returned tags', async () => {});
it('asset tags are read-only and labelled separately from image tags', () => {
  // getByLabelText('Asset tags') has no remove buttons; "Image tags" row has an input "+ Add tag"
});
it('a failed import shows its error and no tag row', () => {});
it('More offers Open externally only for openable complete files', async () => { /* fake API only */ });
it('the asset link follows to the asset', async () => {});
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement it.**

- [ ] **Step 4: Run `pnpm test` and `pnpm typecheck`.** Expected: green.

- [ ] **Step 5: Commit and push.** Message: `feat(desktop): file detail dialog with details panel and tag rows`

---

### Task 12: Asset screen with tabs

**Model:** opus

**Files:**
- Modify: `apps/desktop/src/renderer/src/screens/AssetScreen.tsx`, `apps/desktop/src/renderer/src/components/WorkflowSection.tsx`, `apps/desktop/src/renderer/src/components/CommitInput.tsx` (borderless variant), `apps/desktop/src/renderer/src/components/AssetPicker.tsx` (ARIA 1.2 combobox look), `apps/desktop/src/renderer/src/components/AssignmentFields.tsx`
- Create: `apps/desktop/src/renderer/src/components/AssetFilesTab.tsx`, `apps/desktop/src/renderer/src/components/ResultStrip.tsx`
- Test: `apps/desktop/test/renderer/asset-screen.test.tsx`

**Interfaces:**
- Consumes: `Tabs`, `TagRow`, `Link`, `SelectionBar`, `Dialog` (Task 7); `FileBrowser`, `fileMenuItems` (Task 10); `FileDetailDialog` (Task 11); `files:assignMany`, `files:addTagMany`/`removeTagMany` (Task 4); `AssetTab` (Task 6).
- Produces:
  - `AssetScreen({ id, tab, onTabChange, onBack, onOpenAsset, onOpenProject, onBusyChange }: { id: string; tab: AssetTab; onTabChange(t: AssetTab): void; onBack(): void; onOpenAsset(id: string): void; onOpenProject(id: string): void; onBusyChange(busy: boolean): void })`.
  - `CommitInput` gains `variant?: 'field' | 'inline'`. `inline` is borderless until hover or focus. A multiline `inline` field shows one line until it is focused.
  - `ResultStrip({ title, failures, onDismiss }: { title: string; failures: { key: string; name: string; message: string }[]; onDismiss(): void })` uses `ALERT` and keys rows by `key` (this fixes the duplicate-key backlog item). It is also used in Task 14.
  - `AssetFilesTab({ asset, onAssetChange, onCountChange })` holds its own `FileFilters`, view and `FileSelection` (not persisted). Its selection bar has three actions:
    - "Add tags" opens a `Dialog` with a `TagRow` of `sharedTags(eligibleFiles(sel))`, which adds and removes through the tag batches;
    - "Set role" opens a `Dialog` with a role select and "Apply" (`files:assignMany` with the same asset);
    - "Detach" calls `files:unassign` per file in order (Plan decision 5).

    Failures go into a `ResultStrip`, and the list reloads through `reloadToken`.

**Features that must survive:**
- Back, now the breadcrumb `Link` "Assets", which keeps the list state.
- Inline name; type and status selects; description.
- `WorkflowSection`: template choice and start, steps with the state select (skipped not offered for mandatory steps), notes, progress, and Remove workflow with its tooltip.
- **Projects tab.** Each assignment has a project link and Remove (aria-label plus tooltip "Removes the assignment only; the asset and its files are kept") and `AssignmentFields`. A "Project to add" select plus "Add to project".
- **Files tab.** Role change and Detach (tooltip). Use as cover / automatic cover.
- **Import.** The import role select ("Import as" via tooltip, default Reference), then "Import files" (`dialog:pickFiles`, then `files:import` with target), with "Importing…". The results "n imported, m failed" plus each failed source name with its error. `onBusyChange` is called while importing.
- **Relations tab.** Relations with `relationLabel`, a link to the other asset, and Remove (tooltip "Removes the relation only; both assets and their files are kept"). A kind select plus `AssetPicker` excluding self.

- [ ] **Step 1: Write the failing DOM tests**

```tsx
it('tabs show counts from list totals and the active tab survives remount', async () => {
  // files:list {scope asset, limit 1} total 7 → tab "Files 7"; Projects 2; Relations 1; ArrowRight → onTabChange('workflow')
});
it('the asset tag row adds and removes through assets:addTag/removeTag', async () => {});
it('the breadcrumb is a link back to the gallery', async () => {});
it('import shows the result strip with failed names and errors, and reports busy', async () => {});
it('selection bar: Add tags tags every eligible selected file in one call', async () => {
  // select 2 complete + 1 failed → Add tags dialog → "oak" Enter → files:addTagMany {fileIds:[c1,c2], name:'oak'}
});
it('selection bar: Set role uses files:assignMany with the same asset', async () => {});
it('selection bar: Detach unassigns each file and lists failures per file', async () => {
  // second files:unassign fails not_found → strip lists its name with the mapped message; reloadToken bumped
});
it('not found shows an alert with the breadcrumb', async () => {});
it('each tab panel shows its own load error and empty status', async () => { /* "No files", "No relations" */ });
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement it.**
  - Header row: breadcrumb, then the inline name (heading size), then Type and Status, then, on the right, the role select and "Import files".
  - Second row: the description and `TagRow label="Asset tags"`.
  - Below that, the result strip and then the tabs.

- [ ] **Step 4: Run `pnpm test` and `pnpm typecheck`.** Expected: green.

- [ ] **Step 5: Commit and push.** Message: `feat(desktop): asset screen with header, tag row and tabs`

---

### Task 13: Projects list with Project details, Matching content, and the project screen

**Model:** opus

**Files:**
- Modify: `apps/desktop/src/renderer/src/screens/ProjectsScreen.tsx`, `apps/desktop/src/renderer/src/screens/ProjectScreen.tsx`
- Create: `apps/desktop/src/renderer/src/components/ProjectDetails.tsx`, `apps/desktop/src/renderer/src/components/ProjectTable.tsx`
- Test: `apps/desktop/test/renderer/projects.test.tsx`

**Interfaces:**
- Consumes: Task 3 contracts; `ProjectListState`/`toProjectQuery` (Task 6); `TagFilter`, `TagList`, `TagChip`, `Link`, `Dialog` (Task 7); `Page` (Task 8); `usePagedList`, `useVirtualRows`.
- Produces:
  - `ProjectsScreen({ state, onStateChange, onOpen, onOpenAsset, onShowAssets }: { state: ProjectListState; onStateChange(s: ProjectListState): void; onOpen(id: string): void; onOpenAsset(id: string): void; onShowAssets(filters: Pick<AssetFilters, 'projectId' | 'tagNames'>): void })`.
  - In `WorkspaceShell`, `onShowAssets` sets `assetList` to `{ filters: { ...NO_FILTERS, ...f }, scrollOffset: 0, openedIndex: null, selectedId: null }` and switches to Assets.
  - `ProjectDetails({ project, tagNames, onOpenAsset, onShowAll }: { project: ProjectSummary | null; tagNames: readonly string[]; onOpenAsset(id: string): void; onShowAll(): void })`:
    - Name, Status, Assets, Images (`imageCount`), Description (wrapped).
    - With tags, "Matching content" from `assets:list { projectId, tagNames, limit: 20, offset: 0 }`: cover, name, Type, Status, "Asset tags", and "Image tags" (`coverTags` plus the matched file tags). Matched chips get an accent border. Each entry links to the asset.
    - "Show all" appears when total > 20.
  - Table rows are virtualised (row height is the implementer's choice). Columns: Project (folder icon + name), Status, Assets, Matching tags (only with tags; file-matched ones after an image icon), "Open". Click selects; double-click, Enter or "Open" opens.

**Features that must survive:**
- **Projects list.** Create (name; the dialog adds a description and still opens the project). The table with Name, Status, Assets. "No projects yet." becomes "No projects" / "No matching projects". The pager is replaced by endless scrolling (owner decision 4).
- **Project screen.**
  - Back becomes the breadcrumb `Link` "Projects / *name*". Inline name, status select, description.
  - The member table: asset link, type, status, `AssignmentFields` (priority, approval, intended use, notes in an expandable row), and Remove with its tooltip. The member pager of 50 stays.
  - "Add asset" via `AssetPicker`, excluding the members. No cover column (Plan decision 4).

- [ ] **Step 1: Write the failing DOM tests**

```tsx
it('search, status and tags go into projects:list after the debounce', async () => {});
it('Matching tags shows file-matched tags after an image icon', () => {
  // matchedTags oak onAsset, bark onFiles → row cell: "oak", then image icon, "bark"
});
it('selecting a project fills Project details with Images and Matching content', async () => {
  // assets:list called with {projectId, tagNames:['oak'], limit:20, offset:0}; entry link opens asset
});
it('Show all opens the gallery filtered by project and tags', async () => {});
it('list state round trip keeps filters, scroll offset and selection', async () => {});
it('empty and no-result states', async () => {});
it('the project screen keeps the member pager and member editing', async () => {});
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement it.**

- [ ] **Step 4: Run `pnpm test` and `pnpm typecheck`.** Expected: green.

- [ ] **Step 5: Commit and push.** Message: `feat(desktop): projects list with tag filter, details and matching content`

---

### Task 14: Inbox with multi-select, shared tags and batch assign

**Model:** opus

**Files:**
- Modify: `apps/desktop/src/renderer/src/screens/FilesScreen.tsx` (rename to `InboxScreen.tsx`)
- Create: `apps/desktop/src/renderer/src/components/InboxSelection.tsx`
- Delete: `apps/desktop/src/renderer/src/components/FileGrid.tsx`, `apps/desktop/src/renderer/src/components/useFileDetail.ts` (when unused)
- Test: `apps/desktop/test/renderer/inbox.test.tsx`

**Interfaces:**
- Consumes: `FileBrowser`, `fileMenuItems` (Task 10); `FileDetailDialog` (Task 11); `ResultStrip` (Task 12); the batch channels (Task 4); `eligibleFiles`, `sharedTags`, `refreshSelected`, `dropSelected` (Task 6).
- Produces:
  - `InboxScreen({ state, onStateChange, onBusyChange }: { state: InboxListState; onStateChange(s: InboxListState): void; onBusyChange(busy: boolean): void })`. The selection lives in local state and is not persisted.
  - `InboxSelection({ selection, onSelectionChange, tagInputRef, onAssigned }: { selection: FileSelection; onSelectionChange(s: FileSelection): void; tagInputRef: RefObject<HTMLInputElement | null>; onAssigned(movedIds: string[]): void })`:
    - Title "Selection", then "*n* files" ("*n* images" when every selected file has kind `image`).
    - "Shared image tags": a `TagRow` over `sharedTags(eligibleFiles(selection))`, with `files:addTagMany`/`removeTagMany` and `refreshSelected` on success.
    - "Assign to asset": `AssetPicker`, a Role select (default reference), and "Assign *k* files" where k = `eligibleFiles(selection).length` (disabled when k = 0 or no asset is picked).
    - The selected names, with a failed marker and the error as `title`. After an assign, failures are listed per file.
  - The selection bar's "Add tags" focuses `tagInputRef`.

**Features that must survive:**
- Import files into the inbox, with results for imported, failed and duplicates (a duplicate counts in both).
- The file grid, now endless.
- The detail dialog with its Assign control (Assign, role select, `AssetPicker`).
- "No files yet." becomes "Inbox is empty" plus "Import files".
- Failed imports stay visible with their error.

- [ ] **Step 1: Write the failing DOM tests**

```tsx
it('failed files are excluded from the assign request and the count', async () => {
  // select c1, c2 (complete) and f1 (failed) → button "Assign 2 files" → files:assignMany {fileIds:[c1,c2], assetId, role:'reference'}
});
it('a partially failed assign lists the failure and drops the moved files', async () => {
  // assignMany → [ {c1 ok}, {c2 error not_found} ] → column lists c2 with "This item no longer exists."; c1 gone from grid
  // (reloadToken bumped) and from the selection; c2 still selected
});
it('shared image tags show only tags every eligible file carries; removing one removes it from all', async () => {
  // c1 [oak, bark], c2 [bark] → row shows "bark" only; remove → files:removeTagMany {fileIds:[c1,c2], name:'bark'}
});
it('Add tags in the selection bar focuses the shared tag input', async () => {});
it('"n images" when every selected file is an image, else "n files"', () => {});
it('filters and scroll offset survive navigation; the selection does not', async () => {});
it('empty inbox and no-result states', async () => {});
it('import results list imported, failed and duplicates', async () => {});
```

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement it.** The inbox has these parts:
  - Title "Inbox" with the unfiltered count (`files:list { scope: inbox, limit: 1 }`) and "Import files".
  - Filters: search ("Search files"), File type, Tags (`title="Image tags"`), the toggle, the count and "Clear filters".
  - A `FileBrowser` with `showRoleFilter={false}`.
  - The detail column `InboxSelection`.

- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck` and `pnpm --filter @assetforge/desktop build`.** Expected: green.

- [ ] **Step 5: Commit and push.** Message: `feat(desktop): inbox with multi-select, shared tags and batch assign`

---

### Task 15: Docs, backlog, residue check and the manual end-to-end checklist

**Model:** sonnet

**Files:**
- Modify: `ReadMe.md` (the UI parts of §2 and §3, plus §15.1 for "previous results stay visible", the batch channels, tokens and the shell structure), `docs/backlog.md` (the controller updates `CLAUDE.md` itself)
- Test: `apps/desktop/test/theme.test.ts`

- [ ] **Step 1: Write the failing residue test** (`theme.test.ts`)

```ts
it('no renderer source uses light/dark literals', () => {
  for (const file of renderedSources()) expect(readFileSync(file, 'utf8'), file).not.toMatch(/dark:|slate-|bg-white|text-black/);
});
```

- [ ] **Step 2: Run it.** Fix any remaining literals until it passes.

- [ ] **Step 3: Update the docs.**
  - **ReadMe.** Describe the shell, the detail column, tag attribution (labelled rows, image icon), search behaviour (250 ms, superseding, stale-while-loading), the selection model and its 1000 cap, and the three batch channels and their all-or-nothing vs. per-item semantics.
  - **`docs/backlog.md`.**
    - Remove the items this phase closes: "no DOM test environment", "no DOM test for gallery, dialog, keyboard", the "Loading…" flash, the "Filter by name" label, the missing search/filter/tag-row UI, the per-page grouping of asset files, the pagers of asset files, duplicate React keys in load errors, and `ALERT` hardcoding.
    - Add: "multi-file Detach is a renderer loop over `files:unassign`"; "project member table has no cover (contract lacks it)"; "tag filter chips show the normalised name, not the display name".

- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck` and `pnpm --filter @assetforge/desktop build`.** Expected: green.

- [ ] **Step 5: Commit and push.** Message: `docs: UI redesign in the ReadMe and backlog`

- [ ] **Step 6: Hand over this manual checklist to the controller.** The controller runs it on the built app; implementers do not launch the app.

  1. Every screen against its mockup: 01 Workspaces, 02/07 Assets gallery, 03 Asset Files tab, 05 Projects, 06 Inbox; the file dialog against 04 without the viewer features.
  2. No white flash at start. The window cannot be made smaller than 1024 × 680. Native controls are dark.
  3. Everything that existed before, exercised once:
     - workspace create, open, remove, open folder;
     - asset create; type, status and project filters; grid/table toggle remembered after restart;
     - scroll position and opened tile restored after Back;
     - inline name, type, status and description edits;
     - workflow start, step state, notes, remove;
     - project assign, remove and assignment fields;
     - relation add and remove;
     - import into the asset with a role, and into the inbox (with a duplicate);
     - file role change, detach, assign from the inbox dialog;
     - cover chosen and automatic;
     - the "Open externally" and "Show in folder" menu entries visible (do not trigger them; the owner tries them);
     - nav disabled during an import.
  4. Tag an asset ("Oak") and a file ("bark"). Filter the gallery by both: the asset is found, and the tile shows "bark" under the image icon and "Oak" under "Asset tags". Search "bar" finds it. Search "OAK" finds it.
  5. Projects: filter by both tags. The project matches, Matching tags shows "bark" after the image icon, and Matching content lists the asset. "Show all" opens the gallery filtered.
  6. Inbox: import four files, one of them unreadable or failing. Select three with Ctrl+click and one with Shift+click. Shared tags show only common tags. Add "moss" to all, then assign to an asset: the moved files leave the inbox and a failure is listed with its message.
  7. Type quickly in the gallery search: there is no "Loading…" flash, and the last query wins.
  8. Make the storage unreachable (disconnect the share or rename the folder while the app runs): the warning banner and Retry appear, and previews fall back to the format tile.
  9. Restart the app and verify the tags, assignments and tab state of step 4–6 (the tab state lasts only for the session).

---

## Self-review

1. **Spec coverage.**
   - Tokens, typography and window: Task 5.
   - Shell, banner, Ctrl+F and Workspaces: Task 8.
   - Gallery, table, Selection column and list state: Tasks 6 and 9.
   - Asset screen, tabs and Files multi-select (owner decision 1): Task 12.
   - Dialog: Task 11.
   - Projects, details, Matching content and endless list (owner decision 4): Task 13.
   - Inbox: Task 14.
   - Search behaviour: Task 6.
   - Tag attribution: Tasks 7, 9, 11 and 13.
   - Contract items 1–6: Tasks 1–4 (item 4 needs no channel and is used in Task 13).
   - DOM test environment: Task 5.
   - Manual checklist: Task 15.
   - Gaps by decision: the project-screen cover column (Plan decision 4) and the batch detach channel (Plan decision 5).
2. **Step scan.** Every code step names files, signatures and the spec values. Bodies appear only for the folding semantics (Plan decision 1) and the SQL shapes, which the tests do not determine.
3. **Type consistency.** The following names are used identically in every task that consumes them: `MatchedTag`, `FileQuery`, `ProjectQuery`, `FileSelection`, `eligibleFiles`, `sharedTags`, `MenuItem`, `FileActionContext`, `fileMenuItems`, `AssetTab`, `listKey`, `toFileQuery`, `usePagedList → { state, pending, retry, loadThrough }`, `reloadToken` and `ResultStrip`.
4. **Review Focus.** Each of the five lines names its test in Tasks 2, 6, 7 and 14.
5. **Proportion.** Code blocks are tests and interfaces only; no component body is spelled out.
