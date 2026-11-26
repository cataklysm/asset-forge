# Rename and Merge Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tag can be renamed workspace-wide from any editable tag chip; renaming onto an existing name merges the two tags.

**Architecture:** One use case `renameTag` and one query `tagUsage` in `core`, backed by two new `TagRepository` methods; the SQLite repository does the whole rename or merge (links, proposals, search index) in one transaction. Two IPC channels (`tags:usage`, `tags:rename`). In the renderer a `TagsProvider` at shell level owns one shared `RenameTagDialog` and a "tags changed" signal that lists reload on; record copies no reload reaches are rewritten by pure functions.

**Tech Stack:** TypeScript, Zod, better-sqlite3 + Drizzle, React, Vitest (+ jsdom).

**Spec:** `docs/superpowers/specs/2026-11-26-tag-rename-merge-design.md` — read it; it is the authority.

## Global Constraints

- Everything in the repository is English. No attribution lines in commit messages. Commit, do not push (the controller pushes).
- `core` and `contracts` do not depend on Electron or a database. Renderer and preload hold no persistence logic.
- Error messages are fixed strings; never interpolate cause messages, paths or tag text supplied by a provider. The three messages of this feature, verbatim:
  - `not_found`: `Tag does not exist`
  - `invalid_operation`: `A tag with this name already exists`
  - `validation_failed`: the existing ``A tag needs a letter or digit and at most ${MAX_TAG_LENGTH} characters`` (through `tagName()` in `packages/core/src/tags.ts`)
- An owner carries a tag at most once and manual wins. A merge never turns a manual assignment into an AI one.
- Rename and merge are one database transaction including the proposal rewrite and the reindex.
- No migration: the schema does not change. Do not raise `DERIVED_DATA_VERSION`.
- UI: no explanatory text in the layout (tooltips through `title`); buttons use `BUTTON` / `ICON_BUTTON` / `BUTTON_INLINE` from `apps/desktop/src/renderer/src/ui.ts`; tokens only, no colour literals (`test/theme.test.ts` guards it); enum labels through `labels.ts`.
- Never launch the app, never call "Open externally" / "Show in folder", never touch Docker containers or host port 11434.
- Commands: `pnpm --filter @assetforge/<package> test <file>` (no `--`), `pnpm typecheck`. Known flaky test, not yours: `inbox.test.tsx > filters and scroll offset survive navigation`.

## Review Focus

1. **An owner carrying both tags in a merge, with a manual source and an AI target** — the remaining link must be `manual` (primary key is `(owner, tag, origin)`; a naive `update … set tag_id` collides or leaves two rows). Tests: Task 2.
2. **A waiting proposal that still holds the old name** — accepting it later must not bring the old tag back. Tests: Task 2 (rewrite, then `acceptProposal`).
3. **The target tag appears between the dialog's lookup and the confirm** — the call with `merge: false` writes nothing and the dialog then offers the merge. Tests: Task 1 (core), Task 3 (dialog).
4. **A tag row without any link as merge target or source** (unused rows are never deleted) — `tagUsage` answers `exists: true` with zeros; the merge still removes the source row. Tests: Task 2.
5. **Names with `%`, `_`, `"` or `\`** (legal tag text) in the proposal rewrite — the lookup must not treat them as wildcards or break the JSON. Tests: Task 2.

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/tags.ts` | `TagUsageSchema`, `TagRenameResultSchema` |
| `packages/contracts/src/ipc.ts` | channels `tags:usage`, `tags:rename` |
| `packages/core/src/ports.ts` | `TagRepository.usage`, `TagRepository.rename` |
| `packages/core/src/tags.ts` | `tagUsage`, `renameTag` |
| `packages/core/test/fakes.ts` | in-memory `usage` / `rename` |
| `packages/persistence/src/tag-repository.ts` | SQLite `usage` / `rename` |
| `apps/desktop/src/main/library-handlers.ts` | the two handlers |
| `apps/desktop/src/renderer/src/tag-rename.ts` | pure rewrite functions |
| `apps/desktop/src/renderer/src/tags-context.tsx` | `TagsProvider`, `useTags` |
| `apps/desktop/src/renderer/src/components/RenameTagDialog.tsx` | the dialog |
| `apps/desktop/src/renderer/src/components/TagChip.tsx`, `TagRow.tsx` | the pencil |
| screens and `WorkspaceShell.tsx` | reload on the signal, rewrite filters and record copies |

Lanes after Task 1: **A** = Task 2; **B** = Task 3, then Task 4. Task 5 runs last.

---

### Task 1: Contract, core use cases, handlers

**Files:**
- Modify: `packages/contracts/src/tags.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/test/schemas.test.ts`
- Modify: `packages/core/src/ports.ts`, `packages/core/src/tags.ts`, `packages/core/test/fakes.ts`, `packages/core/test/tags.test.ts`
- Modify: `packages/persistence/src/tag-repository.ts` (placeholders only)
- Modify: `apps/desktop/src/main/library-handlers.ts`, `apps/desktop/test/library-ipc.test.ts`

**Interfaces — Produces:**

```ts
// contracts/src/tags.ts
export const TagUsageSchema = z.object({
  exists: z.boolean(),
  name: z.string(),          // normalised; '' when the text is not a valid tag name
  displayName: z.string(),   // '' when the tag does not exist
  assets: z.number().int().min(0),
  files: z.number().int().min(0),
});
export type TagUsage = z.infer<typeof TagUsageSchema>;
export const TagRenameResultSchema = z.object({ name: z.string(), displayName: z.string(), merged: z.boolean() });
export type TagRenameResult = z.infer<typeof TagRenameResultSchema>;

// contracts/src/ipc.ts
'tags:usage':  { request: z.object({ name: z.string().max(200) }), response: TagUsageSchema },
'tags:rename': { request: z.object({ from: z.string().max(200), to: z.string().max(200), merge: z.boolean() }), response: TagRenameResultSchema },

// core/src/ports.ts — TagRepository
/** The tag with this normalised name: its display name, the assets that carry it themselves and the files not in the trash that carry it. Null without a tag row. */
usage(name: string): Promise<{ displayName: string; assets: number; files: number } | null>;
/**
 * One transaction. `from` and `name` are normalised. Throws NotFoundError('Tag does not exist') without a tag `from`.
 * from === name: sets the display name. Otherwise, no tag `name`: renames the row (name and display name).
 * Otherwise a merge: throws InvalidOperationError('A tag with this name already exists') unless `merge`; moves every
 * link of `from` to `name` (an owner carrying both keeps one link, manual when either was manual, with the earlier
 * createdAt), sets the target's display name and deletes the source row.
 * Except for from === name: rewrites waiting proposals that hold `from` and reindexes the assets affected.
 */
rename(r: { from: string; name: string; displayName: string; merge: boolean }): Promise<{ merged: boolean }>;

// core/src/tags.ts
export function tagUsage(s: WorkspaceSession, r: { name: string }): Promise<TagUsage>;
export function renameTag(s: WorkspaceSession, r: { from: string; to: string; merge: boolean }): Promise<TagRenameResult>;
```

- [ ] **Step 1: Contract tests** in `schemas.test.ts`: `tags:usage` accepts `{ name: 'Front View' }` and `{ name: '' }`, rejects a 201-character name; `tags:rename` accepts `{ from: 'front view', to: 'Front', merge: false }`, rejects a missing `merge` and a non-boolean `merge`. Run: `pnpm --filter @assetforge/contracts test schemas` — FAIL.
- [ ] **Step 2:** Add the schemas and channels above. Run again — PASS.
- [ ] **Step 3: Core tests** in `packages/core/test/tags.test.ts` (new `describe('rename and merge')`, using the existing in-memory database):
  - `tagUsage` of `'  Front   View '` on a workspace where one asset and two files carry `front view` (display `Front View`), one of the files in the trash → `{ exists: true, name: 'front view', displayName: 'Front View', assets: 1, files: 1 }`.
  - `tagUsage` of `'unknown'` → `{ exists: false, name: 'unknown', displayName: '', assets: 0, files: 0 }`; of `'!!!'` and of `''` → `{ exists: false, name: '', displayName: '', assets: 0, files: 0 }`.
  - `renameTag({ from: 'front view', to: 'Frontal', merge: false })` → `{ name: 'frontal', displayName: 'Frontal', merged: false }`; the asset and file now list `frontal` with their old origins; `tagUsage('front view').exists` is false.
  - `renameTag({ from: 'front', to: 'FRONT', merge: false })` → `{ name: 'front', displayName: 'FRONT', merged: false }`; the same result with `merge: true`.
  - `from` is normalised: `renameTag({ from: ' Front  View ', to: 'x', merge: false })` works.
  - Unknown `from` (`'nope'`) and a `from` that is no valid name (`'!!!'`) → `not_found`, message `Tag does not exist`.
  - `to: '!!!'` and a 65-character `to` → `validation_failed`; nothing changed.
  - Target exists, `merge: false` → `invalid_operation`, message `A tag with this name already exists`; both tags and all links unchanged.
  - Target exists, `merge: true` → `{ name: 'front', displayName: 'front', merged: true }` with `to: 'front'`; for a file carrying source `ai` + target `manual`, source `manual` + target `ai`, both `ai`, both `manual`, only source (`ai`), only target: the file carries `front` exactly once with origin `manual`, `manual`, `ai`, `manual`, `ai`, and its old origin. The same six cases for assets.
  - `merge: true` when no tag carries the target name is a rename (`merged: false`).
  - A waiting proposal `[front view, metal]` reads `[frontal, metal]` after the rename; a proposal `[front view, front]` reads one entry `front` after the merge.
  Run: `pnpm --filter @assetforge/core test tags` — FAIL.
- [ ] **Step 4:** Add the two port methods; implement them on `InMemoryTags` in `fakes.ts` (it is keyed by name; wire the proposals store into it the way `this.tags.files = this.files` is wired). Implement `tagUsage` (normalise with `normalizeTagName`; null → the empty answer) and `renameTag` (`from` through `normalizeTagName`, null → `NotFoundError('Tag does not exist')`; `to` through `tagName()`; returns `{ name, displayName, merged }` from the repository's `merged`). Export both from the core index like the other tag use cases. Run — PASS.
- [ ] **Step 5:** In `packages/persistence/src/tag-repository.ts` add `usage` and `rename` that throw `new Error('not implemented')` (Task 2 replaces them). In `library-handlers.ts` add both channels to the `LibraryHandlers` pick and the map: `'tags:usage': (r) => manager.read((s) => tagUsage(s, r))`, `'tags:rename': (r) => manager.exclusive((s) => renameTag(s, r))`. In `library-ipc.test.ts` add both to the "no workspace" request table (`'tags:usage': { name: 'metal' }`, `'tags:rename': { from: 'metal', to: 'steel', merge: false }`) and raise its count from 33 to 35.
- [ ] **Step 6:** Run `pnpm typecheck`, `pnpm --filter @assetforge/core test`, `pnpm --filter @assetforge/contracts test`, `pnpm --filter @assetforge/desktop test library-ipc` — all PASS.
- [ ] **Step 7:** Commit: `Add tag usage and rename contract, use cases and handlers`.

---

### Task 2: SQLite rename and merge (lane A)

**Files:**
- Modify: `packages/persistence/src/tag-repository.ts`
- Test: `packages/persistence/test/tag-repository.test.ts`, `packages/persistence/test/search.test.ts`, `packages/persistence/test/proposal-repository.test.ts`, `apps/desktop/test/library-ipc.test.ts`

**Interfaces — Consumes:** `TagRepository.usage` / `rename` as documented in Task 1. `reindexAssets(tx, assetIds)` from `search-index.ts` (accepts nulls). The index stores normalised tag names of the asset and of its complete files.

- [ ] **Step 1: Failing tests** (follow the fixtures of each file):
  - `usage`: counts as in Task 1's first core test, on SQLite; an asset whose only carrier is one of its files counts under `files` only; a tag row without links → `{ displayName, assets: 0, files: 0 }`; unknown name → `null`.
  - `rename`, free name: the `tag` row keeps its `id` and `created_at`; `asset_tag` / `file_tag` rows are untouched.
  - `rename`, same name: only `display_name` changes; identical display name writes nothing (the row is equal before and after).
  - `rename`, merge: the six origin cases of Task 1 for files and for assets, asserting on the raw `asset_tag` / `file_tag` rows (exactly one row per owner and target tag); `created_at` of an owner carrying both is the earlier one; a link that only moved keeps its origin and `created_at`; the source `tag` row is gone; the target row keeps its `id` and gets the new `display_name`; a file in the trash is merged too and carries the new name after a restore.
  - Merge with `merge: false` throws `InvalidOperationError` and leaves `tag`, `asset_tag`, `file_tag`, `file_analysis_proposal` and `asset_search` byte-for-byte equal (compare full table dumps).
  - Merge where the source tag has no links, and where the target has none: succeeds, source row gone.
  - 3000 files carrying the source, 1500 of them also the target: the merge succeeds (guards SQLite's bound-parameter limit — do not build `IN (…)` lists of owner ids).
  - Search (`search.test.ts`): after a rename, and after a merge, `assets:list`-level query for the old name finds nothing and the new name finds the asset tagged itself and the asset tagged only through a complete file.
  - Proposals (`proposal-repository.test.ts`): `[front view, metal]` → `[frontal, metal]` with the target's display name; `[front view, front]` → one entry at the first position; model, prompt name, sha256 and `created_at` unchanged; a proposal without the source is byte-equal; source names `50%`, `a_b`, `say "hi"`, `back\slash` are rewritten and a proposal holding only `50x` is not touched by renaming `50%`; after the rewrite `acceptProposal` with the new name returns true and the file carries the new tag, and with the old name returns false.
  - `library-ipc.test.ts`: `tags:rename` end to end (rename, then `invalid_operation` without `merge`, then merge) and `tags:usage` for a valid, an unknown and an invalid text.
  Run the four files — FAIL.
- [ ] **Step 2:** Implement `usage` and `rename` in one `db.transaction`. Order inside a merge: collect the affected asset ids (assets linked to the source; assets of files linked to the source) → raise target links to `manual` where the same owner has a manual source link → lower their `created_at` to the earlier one → delete source links of owners that carry the target → repoint the remaining source links → delete the source row (the foreign keys have no `on delete`, so the links go first) → set the target's display name → rewrite proposals → `reindexAssets`. Use set-based statements with subqueries. Find proposals with `instr(tags, <JSON.stringify(from)>) > 0`, then parse, rewrite and write back only lists that really hold the name.
- [ ] **Step 3:** Run the four test files and `pnpm --filter @assetforge/persistence test` — PASS. Run `pnpm typecheck`.
- [ ] **Step 4:** Commit: `Rename and merge tags in the SQLite repository`.

---

### Task 3: Rename dialog and pencil (lane B)

**Files:**
- Create: `apps/desktop/src/renderer/src/tag-rename.ts`, `apps/desktop/src/renderer/src/tags-context.tsx`, `apps/desktop/src/renderer/src/components/RenameTagDialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/TagChip.tsx`, `TagRow.tsx`, `WorkspaceShell.tsx`; `apps/desktop/test/renderer/fake-api.ts` if it lists channels
- Test: `apps/desktop/test/tag-rename.test.ts`, `apps/desktop/test/renderer/rename-tag-dialog.test.tsx`, `apps/desktop/test/renderer/tags.test.tsx`

**Interfaces — Consumes:** channels `tags:usage`, `tags:rename` (Task 1), `Dialog`, `useDebouncedValue` / `SEARCH_DEBOUNCE_MS`, `describeError`.

**Interfaces — Produces:**

```ts
// tag-rename.ts
export interface TagRename { from: string; name: string; displayName: string }
/** `from` becomes the new tag; an entry already named `name` gets the display name; two entries collapse to one at the first position, manual when either was manual. The same array when nothing changes. */
export function renameInTags(tags: readonly TagAssignment[], change: TagRename): readonly TagAssignment[];
/** The same record when its tags are unchanged. */
export function renameInRecord(file: FileRecord, change: TagRename): FileRecord;
/** The same selection when no record changes. */
export function renameInSelection(sel: FileSelection, change: TagRename): FileSelection;
/** Filter names: `from` replaced by `name` in place, no duplicate. The same array when `from` is absent. */
export function renameInNames(names: readonly string[], change: TagRename): readonly string[];

// tags-context.tsx
export interface TagsState {
  /** Raised after every successful rename or merge. */
  renameToken: number;
  /** The last rename of this session; null before the first. */
  lastRename: TagRename | null;
  /** Opens the shared dialog; null outside a provider. */
  openRename: ((tag: { name: string; displayName: string }) => void) | null;
}
export function TagsProvider(props: { children: ReactNode; onRenamed?(change: TagRename): void }): JSX.Element;
export function useTags(): TagsState;

// RenameTagDialog.tsx
export function RenameTagDialog(props: { tag: { name: string; displayName: string } | null; onClose(): void; onRenamed(change: TagRename): void }): JSX.Element;
```

Fixed texts: dialog title `Rename tag`; field label `Name`; buttons `Cancel`, `Rename`, `Merge`; usage line `<displayName> · <n> files · <n> assets` (singular `1 file`, `1 asset`); merge line `Merges with <displayName> · <n> files · <n> assets`; pencil `aria-label` `Rename <displayName>`, `title` `Rename`.

- [ ] **Step 1: Failing tests for `tag-rename.ts`**: rename of an `ai` entry keeps `ai`; `[front view(ai), front(manual)]` → one `front`, manual, at index 0 with the new display name; `[front(ai), front view(manual)]` → one `front`, manual; untouched input returns the identical array / record / selection (`toBe`); `renameInNames(['a','front view','front'], …)` → `['a','front']`. Run `pnpm --filter @assetforge/desktop test tag-rename` — FAIL. Implement. PASS.
- [ ] **Step 2: Failing dialog tests** (`rename-tag-dialog.test.tsx`, fake timers for the debounce):
  - Opens with the display name in the field, selected; the usage line of the tag shows the answer of `tags:usage` for its name.
  - Confirm is disabled for the unchanged text, for `''` and for `!!!`; no `tags:usage` call is made for an invalid text.
  - Typing a free name: after 250 ms one `tags:usage` call; confirm reads `Rename` and is disabled until the answer arrives; no merge line.
  - Typing an existing other tag's name: merge line with its counts, confirm reads `Merge`; confirming sends `{ from, to: <typed, cleaned>, merge: true }`. For a free name `merge: false`.
  - Typing only another spelling of the same tag (`Front` for `front`): no merge line, `Rename`, enabled, sends `merge: false`.
  - A stale lookup answer (first text's answer arriving after the second text's) is dropped.
  - Success calls `onRenamed({ from, name, displayName })` with the response's values, then `onClose`.
  - `invalid_operation` on confirm: the message shows, the usage is looked up again, the merge line appears and the button reads `Merge`.
  - `not_found` on confirm: the message shows, the field and confirm are disabled, `Cancel` still closes.
  - Enter in the field confirms when confirm is enabled; a second activation while the call runs sends nothing.
  Run — FAIL. Implement the dialog. PASS.
- [ ] **Step 3: Failing chip and row tests** (`tags.test.tsx`):
  - `TagChip` with `onRename` renders the pencil before the remove button; without it none.
  - `TagRow` inside a `TagsProvider` shows a pencil per chip (manual and AI); none when `disabled`; none outside a provider.
  - Clicking the pencil opens the dialog for that tag.
  - Delete and Backspace on a focused pencil remove nothing; on the remove button they still remove.
  - Backspace in the empty input still focuses the last chip's remove button, and after a removal focus still lands on a remove button (not a pencil).
  Run — FAIL.
- [ ] **Step 4:** Implement: `TagChip` gets `onRename?(): void` (lucide `Pencil`, same button classes as the remove button, `data-rename`; give the remove button `data-remove`). `TagRow` reads `useTags().openRename` and passes `onRename` unless disabled or null; its remove-button query becomes `[data-chip] button[data-remove]`; the chip `onKeyDown` ignores events whose target is inside `[data-rename]`. `TagsProvider` holds the dialog's tag, renders `RenameTagDialog`, and on success raises `renameToken`, sets `lastRename` and calls `onRenamed`. Mount `TagsProvider` in `WorkspaceShell` inside `AnalysisPromptsProvider` (the `onRenamed` wiring is Task 4). Run the three test files — PASS.
- [ ] **Step 5:** Run `pnpm --filter @assetforge/desktop test` and `pnpm typecheck` — PASS. Commit: `Add the rename tag dialog and the pencil on editable tag chips`.

---

### Task 4: Everything shows the new state (lane B, after Task 3)

**Files:**
- Modify: `WorkspaceShell.tsx`, `screens/AssetsScreen.tsx`, `AssetScreen.tsx`, `InboxScreen.tsx`, `TrashScreen.tsx`, `ProjectsScreen.tsx`, `ProjectScreen.tsx`, `components/AssetFilesTab.tsx`, `ProjectDetails.tsx`, and whatever else holds tagged records (find them: every `usePagedList`, `useLoad` and `useState` whose items are `AssetSummary`, `AssetDetail`, `FileRecord` or `ProjectSummary`)
- Test: `apps/desktop/test/renderer/assets.test.tsx`, `asset-screen.test.tsx`, `inbox.test.tsx`, `projects.test.tsx`, `file-dialog.test.tsx`, `shell.test.tsx`, `trash.test.tsx`

**Interfaces — Consumes:** `useTags()`, `TagRename`, `renameInSelection`, `renameInRecord`, `renameInNames` (Task 3).

Rules:
- **Lists reload** on `renameToken`: add it to the list key or reload token of every list above (the gallery, the projects list and its matching content, the project screen's members, the inbox, the trash, the asset Files tab; the asset screen also re-reads `assets:get`). Stale-while-loading stays as it is.
- **Filters**: `WorkspaceShell` passes `onRenamed` and rewrites `tagNames` of `assetList`, `projectList`, `inboxList` and `trashList` with `renameInNames`; `AssetFilesTab` rewrites its own filter state on `lastRename`.
- **Record copies**: every `FileSelection` state (inbox, trash, asset Files tab) is rewritten with `renameInSelection` when `lastRename` changes; a file held open by `useFileDialog` is rewritten with `renameInRecord` (through its `update`). Apply each `lastRename` once (compare by object identity in an effect).

- [ ] **Step 1: Failing tests** (each renames through the UI: pencil → type → confirm, with the fake API answering `tags:rename`, and list fakes answering the new state on the next request):
  - Asset screen: after renaming an asset tag the header chips show the new name and `assets:get` and the Files tab's `files:list` were requested again.
  - Gallery (`assets.test.tsx`): with a tag filter on `front view`, a rename signalled through the provider switches the filter chip to `front` and requests `assets:list` with `tagNames: ['front']`; a filter holding both ends with one chip.
  - Projects: the same for the projects filter and the matching content.
  - Inbox: two selected files, one `[front view(ai), front(manual)]`, one `[front view(manual)]`; after the merge the shared tags row shows one `front` chip without a reload answer having arrived (hold the `files:list` promise open); a selected file outside the loaded pages is rewritten too.
  - File detail dialog (`file-dialog.test.tsx`): renaming an image tag from the open dialog shows the new chip in the dialog while the list reload is still pending; the dialog stays open on the same file.
  - Asset Files tab: the batch "Add tags" dialog's row has pencils; after a rename the selection's shared tags show the new name; the tab's own tag filter is rewritten.
  - Trash: the list reloads on the signal.
  - Shell: filters of a screen that is not mounted are rewritten (rename on the asset screen, navigate to the gallery, the filter chip shows the new name).
  Run the files — FAIL.
- [ ] **Step 2:** Implement the rules. Run the files — PASS.
- [ ] **Step 3:** Run `pnpm --filter @assetforge/desktop test` and `pnpm typecheck` — PASS. Commit: `Reload lists and rewrite filters and selections after a tag rename`.

---

### Task 5: Acceptance and documentation

**Files:**
- Modify: `apps/desktop/test/acceptance.test.ts`, `ReadMe.md` (§6, the paragraph "Implemented so far (phase 3b): tags …", and §3.3 where the tag rows are described), `docs/backlog.md`

- [ ] **Step 1: Acceptance test** in `acceptance.test.ts` through the real handlers and a real workspace: import two files into an asset; tag the asset `Front` (manual) and one file `front view` (manual); write a proposal holding `front view` for the other file through the repository; `tags:usage` for both names; `tags:rename { from: 'front view', to: 'front', merge: false }` → `invalid_operation`; with `merge: true` → `{ name: 'front', displayName: 'front', merged: true }`; then: `assets:get` shows `front` once, `files:list` shows `front` on the file, `assets:list { query: 'view' }` is empty and `{ tagNames: ['front'] }` finds the asset, `tags:suggest { prefix: 'front' }` returns only `front`, `analysis:getProposal` lists `front`, and a second `tags:rename` from `front view` → `not_found`. Run `pnpm --filter @assetforge/desktop test acceptance` — PASS.
- [ ] **Step 2: ReadMe.** In §6 replace "Tag rows are never deleted and there is no rename or merge" by the rule: a tag is renamed workspace-wide (`tags:rename`); a new name that another tag carries is a merge and needs `merge: true`, otherwise `invalid_operation`; per owner one assignment remains, manual when either was manual, with the earlier creation time; the kept tag takes the typed display name; the source row is deleted (other unused rows still are not); waiting proposals are rewritten and files in the trash are included; `tags:usage` counts assets carrying the tag themselves and files outside the trash; no mapping of later analysis results. Add both channels to the channel list of that paragraph. In §3.3 add the pencil on editable tag chips and the dialog (name, usage line, merge line, `Rename` / `Merge`, no second confirmation).
- [ ] **Step 3: Backlog.** Remove the "Editable tags" request (line 10). Change "Unused tag rows are never deleted and there is no tag rename or merge." to "Unused tag rows are never deleted (a merge deletes only its source row)." Add a section "Tag rename and merge" with: no tags page; no rename from read-only chips or the tag filter; no undo; an open proposal review dialog refuses to accept after a rename and must be reopened; a merge target without any assignment is offered as a merge with zero counts.
- [ ] **Step 4:** Run `pnpm test` and `pnpm typecheck` and `pnpm --filter @assetforge/desktop build` — PASS. Commit: `Document tag rename and merge and add the acceptance test`.
