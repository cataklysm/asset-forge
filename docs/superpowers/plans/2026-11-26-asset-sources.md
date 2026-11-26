# Asset Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An asset carries a list of source URLs, shown in the asset header, added and removed there, and opened in the system browser with one click.

**Architecture:** A new table `asset_source` behind a new repository port; use cases in `packages/core/src/asset-sources.ts` own the URL rule; the asset detail record carries `sources`. Three IPC channels; opening resolves the stored URL in main and hands it to a new host action, so the renderer never passes a URL to be opened. The renderer gets one `SourceList` component in the asset header.

**Tech Stack:** TypeScript, Zod, Drizzle + better-sqlite3, Electron (`shell.openExternal`), React, Vitest (+ jsdom).

**Spec:** `docs/superpowers/specs/2026-11-26-asset-sources-design.md`

## Global Constraints

- Everything in the repository is English. No attribution lines in commits. Implementers commit, they do not push.
- Never launch the app, never trigger "Open externally" or a real browser, never touch Docker, never call anything on port 11434.
- `core` and `contracts` do not depend on Electron or a concrete database. The renderer holds no persistence logic.
- Fixed error messages only; never interpolate a URL, a path or a cause text into a message. Exact messages:
  - `This is not a web address` (`validation_failed`)
  - `This source already exists` (`invalid_operation`)
  - `This asset cannot take more sources` (`invalid_operation`)
  - `This source could not be opened` (`invalid_operation`)
- URL rule (one function in core): trimmed input; at most 2000 characters before and after normalisation; parseable by `new URL`; protocol `http:` or `https:`; non-empty host; empty `username` and `password`; stored and compared as `URL.href`.
- At most `MAX_ASSET_SOURCES = 50` sources per asset.
- UI: no explanatory text in the layout (tooltips through `title`); buttons only from `ui.ts` (`BUTTON`, `ICON_BUTTON`, `BUTTON_INLINE`, `ICON_BUTTON_INLINE`); tokens only, no colour literals; labels in `apps/desktop/src/renderer/src/labels.ts`.
- Commands: `pnpm --filter @assetforge/<package> test <file>` (no `--`), `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build`, `pnpm --filter @assetforge/persistence db:generate`. Known flaky test (re-run once): `inbox.test.tsx > filters and scroll offset survive navigation`.

## Review Focus

- A pasted URL with surrounding whitespace, or an upper-case host, or a bare host without a trailing slash: accepted, stored as `href`, and a second spelling of the same address is the duplicate (`HTTP://Example.org` after `http://example.org/`). Test in Task 1.
- A source ID that belongs to another asset in `assets:removeSource` and `assets:openSource`: `not_found`, nothing removed, nothing opened. Test in Task 1.
- `shell.openExternal` rejecting (no browser, blocked by the OS): the channel answers the fixed message, the cause text is not forwarded. Test in Task 1.
- Enter pressed twice quickly in `Add URL`: one request, the input is disabled while it runs. Test in Task 2.
- A very long URL without a break opportunity in the header: the link is cut with an ellipsis and the header does not scroll sideways (`min-w-0` and `truncate` on the link's container). jsdom cannot measure it; Task 2 asserts the full URL in `title` and the reviewer checks the classes.

---

### Task 1: Sources in contracts, core, persistence and main

**Files:**
- Create: `packages/core/src/asset-sources.ts`, `packages/core/test/asset-sources.test.ts`, `packages/persistence/src/asset-source-repository.ts`, `packages/persistence/test/asset-source-repository.test.ts`, migration `packages/persistence/migrations/0011_*.sql` (generated)
- Modify: `packages/contracts/src/library.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/test/schemas.test.ts`, `packages/core/src/ports.ts`, `packages/core/src/asset-cover.ts` (`getAssetDetail`), `packages/core/src/index.ts`, `packages/core/test/fakes.ts`, `packages/persistence/src/schema.ts`, `packages/persistence/src/open-database.ts` (or wherever the repositories are assembled), `packages/persistence/src/index.ts`, `apps/desktop/src/main/ipc.ts` (`HostActions`), `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/library-handlers.ts`, preload channel list if channels are enumerated there, `apps/desktop/test/library-ipc.test.ts`, every test fixture or fake that builds an `AssetDetail` (add `sources: []`; grep for `coverIsChosen`)

**Interfaces:**
- Produces (contracts):
  - `AssetSourceSchema = z.object({ id, url: z.string(), createdAt })`, type `AssetSource`
  - `AssetDetailSchema` gains `sources: z.array(AssetSourceSchema)` (by `createdAt`, then `id`)
  - `'assets:addSource'`: request `{ assetId: IdSchema, url: z.string().max(2000) }`, response `AssetDetailSchema`
  - `'assets:removeSource'`: request `{ assetId: IdSchema, sourceId: IdSchema }`, response `AssetDetailSchema`
  - `'assets:openSource'`: request `{ assetId: IdSchema, sourceId: IdSchema }`, response `z.null()`
- Produces (core):
  - `MAX_ASSET_SOURCES = 50`, `MAX_SOURCE_URL_LENGTH = 2000`
  - `normalizeSourceUrl(input: string): string` — returns `href`, throws `ValidationFailedError('This is not a web address')`
  - `addAssetSource(s: WorkspaceSession, r: { assetId: string; url: string }): Promise<AssetDetail>`
  - `removeAssetSource(s: WorkspaceSession, r: { assetId: string; sourceId: string }): Promise<AssetDetail>`
  - `resolveAssetSourceUrl(s: WorkspaceSession, r: { assetId: string; sourceId: string }): Promise<string>` — the stored URL, passed through `normalizeSourceUrl` again; unknown source or a source of another asset → `not_found`
  - port `AssetSourceRepository` on the database as `database.assetSources`:
    `listByAsset(assetId): Promise<AssetSource[]>`; `get(id): Promise<(AssetSource & { assetId: string }) | null>`; `countByAsset(assetId): Promise<number>`; `insert(row: { id; assetId; url; createdAt }): Promise<boolean>` (false when the asset already has the URL); `remove(id): Promise<boolean>`
- Produces (main): `HostActions.openExternal(url: string): Promise<void>` (wired to `shell.openExternal` in `index.ts`)

- [ ] **Step 1: Contracts.** Add the schema, the `sources` field and the three channels. In `schemas.test.ts` add: `assets:addSource` accepts `{ assetId, url: 'https://example.org' }`, rejects a 2001-character `url` and a missing `assetId`; `AssetDetailSchema` rejects a record without `sources`. Run `pnpm --filter @assetforge/contracts test` → PASS.

- [ ] **Step 2: Failing core tests** in `packages/core/test/asset-sources.test.ts` (fake database; extend `fakes.ts` with an in-memory `assetSources` that enforces uniqueness per asset):
  - `normalizeSourceUrl`: `'  https://Example.org/a?b=1#c  '` → `'https://example.org/a?b=1#c'`; `'http://example.org'` → `'http://example.org/'`; each of `''`, `'   '`, `'example.org'`, `'ftp://example.org/x'`, `'file:///C:/x'`, `'javascript:alert(1)'`, `'mailto:a@example.org'`, `'https://user:pw@example.org/'`, `'https://user@example.org/'`, `'https://'`, and `'https://example.org/' + 'a'.repeat(2000)` throws `ValidationFailedError` with message `This is not a web address`.
  - add: returns the detail with one source `{ id, url: href, createdAt }`; the asset's `updatedAt` is the session's `now`; unknown asset → `not_found`.
  - duplicate: after `http://example.org/`, adding `HTTP://Example.org` throws `InvalidOperationError` `This source already exists`; the same URL on another asset is accepted.
  - limit: with 50 sources the 51st throws `InvalidOperationError` `This asset cannot take more sources`; nothing is inserted.
  - order: sources added at increasing times list in that order.
  - remove: the source is gone, `updatedAt` set; unknown ID → `not_found`; an ID of another asset's source → `not_found` and that source stays.
  - `resolveAssetSourceUrl`: returns the stored URL; a source of another asset → `not_found`; a stored row with `file:///x` (written straight into the fake) → `ValidationFailedError`.
  - `getAssetDetail` of an asset without sources has `sources: []`.

  Run `pnpm --filter @assetforge/core test asset-sources` → FAIL (module missing).

- [ ] **Step 3: Implement core.** Port in `ports.ts`, `asset-sources.ts`, `sources` in `getAssetDetail`, exports in `index.ts`. `addAssetSource`: normalise → `requireAsset` → count against the limit → `insert` (false → duplicate error) → set `updatedAt` through `assets.update` → detail. Use the same error classes and `requireAsset` helper as `tags.ts`. Run the test → PASS.

- [ ] **Step 4: Persistence.** In `schema.ts` add `assetSource` (`asset_source`): `id` text primary key, `asset_id` text not null references `asset.id`, `url` text not null, `created_at` text not null; unique index on (`asset_id`, `url`); the unique index also serves lookups by asset. Run `pnpm --filter @assetforge/persistence db:generate` and commit the generated `0011_*.sql` and meta files unchanged. Write `asset-source-repository.test.ts` first (real database): insert and list in `created_at`, then `id` order; a second insert of the same URL on the same asset returns `false` and leaves one row; the same URL on another asset returns `true`; `get` returns the row with `assetId`; `countByAsset`; `remove` returns `true` then `false`; a database created at migration `0010` and then migrated has an empty `asset_source` table and keeps its assets (follow the existing migration tests). Implement the repository and add it to the database object. Run `pnpm --filter @assetforge/persistence test` → PASS.

- [ ] **Step 5: Main.** Add `openExternal` to `HostActions` and wire it in `index.ts`. Handlers: `assets:addSource` and `assets:removeSource` through `manager.exclusive`; `assets:openSource` reads the URL through `manager.read((s) => resolveAssetSourceUrl(s, r))`, then `await host.openExternal(url)`; a rejection becomes `InvalidOperationError('This source could not be opened')`. Tests in `library-ipc.test.ts` (host fake recording calls): add then get shows the source; `assets:openSource` calls `openExternal` exactly once with the stored `href`; a source ID of another asset → `not_found` and no call; a rejecting `openExternal` (`new Error('C:\\secret')`) answers `invalid_operation` with exactly `This source could not be opened`; `assets:addSource` with `url: 'file:///x'` → `validation_failed`; each of the three channels without an open workspace → `no_workspace_open`; a request with a non-string `url` → `invalid_request`.

- [ ] **Step 6: Fixtures.** Add `sources: []` wherever an `AssetDetail` is built in tests and fakes (renderer `fake-api.ts` and `fixtures.ts` included) so that the whole repository typechecks. Run `pnpm test` and `pnpm typecheck` → PASS.

- [ ] **Step 7: Commit** — `feat: store source URLs on an asset`

---

### Task 2: Sources block in the asset header

**Files:**
- Create: `apps/desktop/src/renderer/src/components/SourceList.tsx`, `apps/desktop/test/renderer/source-list.test.tsx`
- Modify: `apps/desktop/src/renderer/src/screens/AssetScreen.tsx`, `apps/desktop/src/renderer/src/labels.ts`, `apps/desktop/test/renderer/fake-api.ts`, `apps/desktop/test/renderer/asset-screen.test.tsx`

**Interfaces:**
- Consumes: `AssetDetail.sources`, channels `assets:addSource`, `assets:removeSource`, `assets:openSource` (Task 1).
- Produces: `SourceList` with props `{ sources: AssetSource[]; disabled: boolean; onAdd(url: string): Promise<void>; onRemove(sourceId: string): Promise<void>; onOpen(sourceId: string): Promise<void> }`. Labels in `labels.ts`: `SOURCES_LABEL = 'Sources'`, `ADD_SOURCE_PLACEHOLDER = 'Add URL'`, `COPY_SOURCE_TITLE = 'Copy URL'`, `REMOVE_SOURCE_TITLE = 'Remove source'`.

Behaviour:
- A labelled group `Sources` in the header row that holds the description and the asset tags (third block, `min-w-64 flex-1`, as its neighbours).
- Each source is the existing `Link` component (`components/Link.tsx`, `href="#"` with the click prevented), never an anchor whose `href` is the source URL (the window must not navigate). Its text is the URL, cut with an ellipsis; `title` is the full URL. A click calls `onOpen(id)`.
- Per source two `ICON_BUTTON_INLINE`s with `title` and `aria-label`: copy (writes the URL to the clipboard the way `PromptDialog.tsx` copies text) and remove (no confirmation).
- The list scrolls inside the block beyond five rows (a max height on the list).
- An input with placeholder and `aria-label` `Add URL`, `maxLength` 2000. Enter with a non-blank value calls `onAdd(value)`; while it runs the input is disabled; on success it is cleared, on failure the text stays.
- `disabled` disables the input and the remove buttons; open and copy stay usable.
- `AssetScreen` passes `disabled={importing}` and handlers that call the channel, `setAsset` with the answer, and report a failure the same way the other header fields do (the header's alert line).

- [ ] **Step 1: Extend the fake API** with the three channels (in-memory sources on the fake asset, the same error codes for duplicate and invalid URL, a recorded list of opened source IDs).

- [ ] **Step 2: Failing component tests** in `source-list.test.tsx`:
  - renders one link per source with the URL as text and the full URL as `title`; no element's `href` attribute is a source URL;
  - click on a source calls `onOpen` with its ID;
  - the remove button calls `onRemove` with the ID; the copy button calls `navigator.clipboard.writeText` with the URL (mocked);
  - typing `https://example.org` and Enter calls `onAdd('https://example.org')` once and clears the input after it resolves;
  - Enter twice while `onAdd` is pending calls it once; the input is disabled meanwhile;
  - a rejected `onAdd` keeps the typed text; Enter on a blank input calls nothing;
  - `disabled` disables input and remove buttons, not open and copy.

  Run `pnpm --filter @assetforge/desktop test source-list` → FAIL.

- [ ] **Step 3: Implement `SourceList` and the labels.** Run the test → PASS.

- [ ] **Step 4: Failing screen tests** in `asset-screen.test.tsx`: the header shows the asset's sources; adding sends `assets:addSource` and the new source appears; removing sends `assets:removeSource` and it disappears; a click sends `assets:openSource` with asset and source ID; adding a duplicate shows `This source already exists` in an alert; during an import the `Add URL` input is disabled.

- [ ] **Step 5: Wire `SourceList` into `AssetScreen`.** Run `pnpm --filter @assetforge/desktop test asset-screen source-list theme` → PASS (the theme test guards colour literals and button classes).

- [ ] **Step 6:** `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build` → PASS. **Commit** — `feat: show and edit sources in the asset header`

---

### Task 3: Acceptance and documentation

**Files:**
- Modify: `apps/desktop/test/acceptance.test.ts`, `ReadMe.md`, `docs/backlog.md`

- [ ] **Step 1: Acceptance test** (real handlers, real workspace, host fake): create an asset; add `https://example.org/a` and `https://example.org/b`; `assets:get` lists both in that order; adding `HTTPS://EXAMPLE.ORG/a` answers `invalid_operation`; `assets:openSource` for the second hands exactly `https://example.org/b` to the host; remove the first; close and reopen the workspace; `assets:get` shows only the second. Run `pnpm --filter @assetforge/desktop test acceptance` → PASS.

- [ ] **Step 2: ReadMe.** In the asset section describe sources (a URL only; `http`/`https`, no credentials, at most 2000 characters and 50 per asset; unique per asset in normalised form; never fetched; opened through the stored ID). Add the three channels to the IPC list. If section 18 lists sources as open, mark the decision.

- [ ] **Step 3: Backlog.** Remove "Sources on an asset" from "Requested features". Add a section "Asset sources" with what is deferred: further fields (title, author, licence, note, date), sources on files or projects, search and filter by source, in-place editing and reordering, adding several URLs at once, any fetch (page title, reachability). Do not edit `CLAUDE.md`.

- [ ] **Step 4:** `pnpm test`, `pnpm typecheck` → PASS. **Commit** — `test: accept asset sources end to end; docs`
