# Phase 2a – Asset Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assets with type and status, projects, n:m project assignments with project-specific data, file roles with crash-safe moves into per-asset directories, and asset relations — usable end to end in the desktop app.

**Architecture:** One Drizzle migration (`0001`) adds the tables and the storage reference. `core` gets one port per table and plain use-case functions that receive a `WorkspaceSession` from `WorkspaceManager.read` / `.exclusive`; mutating operations and the workspace lifecycle share one queue. File moves follow intent row → move on disk → commit transaction, repaired on open. `apps/desktop` adds IPC channels and list/detail screens.

**Tech Stack:** unchanged from phase 1 (TypeScript, Electron, electron-vite, React, Tailwind CSS v4, Zod 4, better-sqlite3, Drizzle ORM + drizzle-kit, Vitest, pnpm workspaces). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-25-phase-2a-asset-management-design.md` (overall architecture: `ReadMe.md`; carried-over findings: `docs/phase-2-backlog.md`)

**Branch:** `phase-2a-asset-management`, created from `main`.

**Models:** each task names the model for its implementer subagent. Task reviewers run on `sonnet`, except Tasks 3, 4 and 7 (`opus`). The final whole-branch review runs on the most capable model.

## Global Constraints

- Everything in the repository is English (code, identifiers, comments, commit messages, docs). No attribution lines in commit messages.
- Every commit is followed by `git push` of the current branch (`git push -u origin phase-2a-asset-management` the first time).
- `core` and `contracts` must not import Electron, better-sqlite3, Drizzle, `storage` or `persistence`. `apps/desktop/src/main/ipc.ts` and the handler modules stay free of Electron imports.
- No persistence logic in renderer or preload. No new dependencies.
- The database stores only paths relative to the workspace root with `/` separators; no absolute path in any table. IDs are UUID v4 from `WorkspaceHost.newId()`; timestamps are ISO 8601 UTC strings from `WorkspaceHost.now()`.
- Port methods return `Promise`, also where the SQLite adapter is synchronous. Transactions are short; file-system work happens outside them.
- An imported file is never overwritten; `Storage.move` rejects when the target exists. Nothing in this phase deletes an asset, a project or a file.
- `AssetForgeError` messages reach the renderer: never put cause messages, absolute paths or credentials into them. Entity IDs and names are fine.
- Exactly one migration is added in this phase: `0001`. Tasks after Task 3 do not change `schema.ts`.
- UI: every button uses the `BUTTON` class from `apps/desktop/src/renderer/src/ui.ts`; no explanatory sentences in the layout (use `title` tooltips); labels, headings, data and empty-state lines such as "No assets yet." are fine. Interactive elements have an accessible name.
- Tests in `packages/persistence` and `apps/desktop` run under Electron's Node (already configured in their `test` scripts). Single test: `pnpm --filter @assetforge/<package> test <file> -t "<name>"` (no `--` separator).
- Each task ends with `pnpm test` and `pnpm typecheck` green in the whole repository.

## Review Focus

1. A phase 1 database with existing file rows, and one without any rows → both open after migration `0001`; every file row has the primary storage ID; nothing else about the rows changed. (Task 3)
2. Crash between writing the move intent and the move, and between the move and the commit → the next open discards the first and completes the second; row and disk agree afterwards. (Tasks 7, 8)
3. Relocating a file that is `pending` or `failed`, that is missing on disk, or to an unknown asset → fails with `invalid_operation` / a storage error / `not_found`; the row is unchanged and no intent row is left. (Task 7)
4. The same asset assigned twice to one project, the same relation added twice, a relation from an asset to itself, removing an assignment that does not exist → no duplicate row, `invalid_operation` for the self-relation, no error for the repeated or missing ones. (Task 6)
5. Names and filters with `%`, `_`, `\`, quotes or non-ASCII characters, and whitespace-only names → the filter matches literally; a whitespace-only name is rejected as `invalid_request`. (Tasks 5, 8)
6. Closing the workspace while an import or move is running → the close waits; the operation finishes against an open database. (Task 4)

---

### Task 1: Destination errors during streaming

**Model:** sonnet

Required backlog item. A failure of the *destination* while streaming must be translated like every other storage error; only an error that originates from the *source* stream passes through untouched.

**Files:**
- Modify: `packages/storage/src/local-storage.ts` (`writeStream`)
- Test: `packages/storage/test/local-storage.test.ts`

**Interfaces:**
- Produces: unchanged signature `writeStream(relPath, source): Promise<{ sizeBytes: number; sha256: string }>`.

- [ ] **Step 1: Write the failing tests** in the existing `writeStream` describe block. To make the destination fail, obtain the `FileHandle` prototype (`Object.getPrototypeOf(await fs.open(...))`) and spy on `write` and `writev` so they reject with `Object.assign(new Error('x'), { code })`; restore in `afterEach`.
  - `maps ENOSPC raised by the destination mid-stream to StorageFullError`: rejects with an instance of `StorageFullError`; the target path does not exist afterwards.
  - `maps EACCES raised by the destination mid-stream to StorageAccessDeniedError`.
  - `still rejects with the source's own error when the source fails`: a `Readable` destroyed with `new Error('source broke')` → rejects with that very error object.
  - `destroys the source when the target cannot be opened`: target already exists → rejects, and `source.destroyed === true`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/storage test local-storage` — the new tests fail.
- [ ] **Step 3: Implement.** Record the source error as today; record the destination stream's error separately (`out.once('error', …)`) and pass an error through `guarded` untranslated only when it is the recorded source error and not the destination error. Destroy `source` when anything before the pipeline throws.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 5: Commit and push** — `fix(storage): translate destination errors raised mid-stream`.

---

### Task 2: Error-code union and domain vocabulary in contracts

**Model:** sonnet

**Files:**
- Create: `packages/contracts/src/errors.ts`, `packages/contracts/src/library.ts`
- Modify: `packages/contracts/src/ipc.ts`, `packages/contracts/src/files.ts`, `packages/contracts/src/index.ts`, `packages/core/src/errors.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/src/api.ts`
- Test: `packages/contracts/test/schemas.test.ts`

**Interfaces — produces:**

```ts
// errors.ts
export const ErrorCodeSchema = z.enum([
  'workspace_not_found', 'storage_unreachable', 'directory_not_empty', 'unsupported_format_version',
  'workspace_mismatch', 'workspace_duplicate', 'trash_failed', 'invalid_manifest', 'no_workspace_open',
  'path_escape', 'source_not_readable', 'checksum_mismatch', 'storage_access_denied', 'storage_full',
  'not_found', 'invalid_operation',
  'unknown_channel', 'invalid_request', 'internal_error', 'shutting_down', 'forbidden_sender',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// library.ts — vocabularies
export const AssetStatusSchema = z.enum(['draft', 'in_progress', 'in_review', 'completed', 'archived']);
export const ProjectStatusSchema = z.enum(['active', 'on_hold', 'completed', 'archived']);
export const FileRoleSchema = z.enum(['reference', 'concept', 'generated', 'working', 'model', 'texture', 'final', 'other']);
export const RelationKindSchema = z.enum(['uses', 'variant_of', 'part_of', 'derived_from']);
export const AssignmentPrioritySchema = z.enum(['low', 'normal', 'high']);
export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected']);

// library.ts — input building blocks (used by IPC requests in Task 8)
export const NameInputSchema = z.string().trim().min(1).max(200);
export const DescriptionInputSchema = z.string().max(5000);
export const NotesInputSchema = z.string().max(5000);
export const IntendedUseInputSchema = z.string().max(500);
export const PageRequestSchema = z.object({ limit: z.number().int().min(1).max(200), offset: z.number().int().min(0) });
export const pageOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number().int().min(0) });

// library.ts — entities (all ids z.uuid(), all timestamps z.iso.datetime())
export const AssetTypeSchema = z.object({ id, key: z.string(), name: z.string(), sortOrder: z.number().int(), builtIn: z.boolean() });
export const ProjectSchema = z.object({ id, name: z.string(), description: z.string(), status: ProjectStatusSchema, createdAt, updatedAt });
export const ProjectSummarySchema = ProjectSchema.extend({ assetCount: z.number().int().min(0) });
export const AssetSchema = z.object({ id, name: z.string(), typeId, description: z.string(), status: AssetStatusSchema, createdAt, updatedAt });
export const AssetSummarySchema = AssetSchema.extend({ projectCount: z.number().int().min(0), fileCount: z.number().int().min(0) });
export const ProjectAssignmentSchema = z.object({ projectId, assetId, priority: AssignmentPrioritySchema, intendedUse: z.string(), approvalStatus: ApprovalStatusSchema, notes: z.string(), assignedAt, updatedAt });
export const AssetAssignmentSchema = ProjectAssignmentSchema.extend({ project: ProjectSchema });   // seen from the asset
export const ProjectMemberSchema = ProjectAssignmentSchema.extend({ asset: AssetSchema });          // seen from the project
export const AssetRelationSchema = z.object({ fromAssetId, toAssetId, kind: RelationKindSchema, createdAt });
export const AssetRelationViewSchema = AssetRelationSchema.extend({ direction: z.enum(['outgoing', 'incoming']), other: AssetSchema });
export const ProjectListSchema = pageOf(ProjectSummarySchema);
export const AssetListSchema = pageOf(AssetSummarySchema);
export const ProjectMemberListSchema = pageOf(ProjectMemberSchema);
```

Export a `z.infer` type next to every schema, named without the `Schema` suffix (`AssetStatus`, `Project`, `AssetList`, …).

- `IpcErrorSchema.code` becomes `ErrorCodeSchema`. `AssetForgeError.code` is typed `ErrorCode`; `define(code: ErrorCode)`. New in `core/src/errors.ts`: `NotFoundError` (`not_found`), `InvalidOperationError` (`invalid_operation`).
- `files.ts`: `sizeBytes: z.number().int().min(0).nullable()`, `total: z.number().int().min(0)`; `files:list` request uses `PageRequestSchema`.
- Renderer: `ApiError.code: ErrorCode`; `ERROR_MESSAGES: Partial<Record<ErrorCode, string>>`.

- [ ] **Step 1: Write the failing tests** in `schemas.test.ts`:
  - `ErrorCodeSchema covers every code the application produces`: for each class exported from `@assetforge/core` whose prototype chain includes `AssetForgeError`, `ErrorCodeSchema.parse(new Cls('x').code)` succeeds — put this test in `packages/core/test/errors.test.ts` (new file), since `contracts` cannot import `core`.
  - `NameInputSchema trims and rejects whitespace-only names`: `parse('  Gabriella ')` → `'Gabriella'`; `safeParse('   ').success` → `false`; 201 characters → `false`.
  - `PageRequestSchema rejects limit 0, limit 201, a negative offset and fractions`.
  - `IpcErrorSchema rejects an unknown code`.
  - `AssetRelationViewSchema` and `ProjectMemberSchema` accept a well-formed sample and reject one with an unknown `kind` / `priority`.
- [ ] **Step 2: Run** the contracts and core tests — the new tests fail.
- [ ] **Step 3: Implement** the schemas and types above; type the error code in `core`, in `failure()` / the literal results in `apps/desktop/src/main/ipc.ts` and `index.ts`, and in the renderer `api.ts`.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 5: Commit and push** — `feat(contracts): error-code union and asset management vocabulary`.

---

### Task 3: Schema, migration 0001 and the storage reference

**Model:** opus

The only schema change of this phase. It adds every table of the spec's data model and makes the storage reference work end to end, so the repository stays green: contracts → persistence → core import path.

**Files:**
- Modify: `packages/persistence/src/schema.ts`, `packages/persistence/src/file-repository.ts`, `packages/persistence/src/meta-repository.ts`, `packages/persistence/src/open-database.ts`, `packages/persistence/src/index.ts`
- Create: `packages/persistence/src/storage-repository.ts`, `packages/persistence/migrations/0001_*.sql` (+ generated `meta/` files)
- Modify: `packages/contracts/src/files.ts`, `packages/core/src/ports.ts`, `packages/core/src/import-file.ts`, `packages/core/src/workspace-manager.ts`, `packages/core/test/fakes.ts`
- Test: `packages/persistence/test/migration-0001.test.ts` (new), `packages/persistence/test/database.test.ts`, `packages/core/test/import.test.ts`, `packages/core/test/workspace-lifecycle.test.ts`

**Interfaces — produces:**

```ts
// contracts/files.ts — FileRecordSchema gains two fields
storageId: z.uuid(),
role: FileRoleSchema.nullable(),

// core/ports.ts
export interface StorageRef { id: string; kind: 'workspace_root'; createdAt: string }
export interface StorageRepository {
  getPrimary(): Promise<StorageRef | null>;
  /** Returns the existing primary storage, or inserts and returns one built from `r`. */
  ensurePrimary(r: { id: string; createdAt: string }): Promise<StorageRef>;
}
// FileRepository.insertPending now takes { id, storageId, originalName, relativePath, mimeType, importedAt }
// FileRepository.markComplete / markFailed reject with NotFoundError when no row has that id
// WorkspaceMetaRepository.init rejects with InvalidOperationError when a row already exists
export interface WorkspaceDatabase { meta; storages: StorageRepository; files; close(): Promise<void> }

// core/import-file.ts
export interface ImportContext { storage; storageId: string; files; sources; newId(): string; now(): Date }
```

**Schema (table and column names are binding; Drizzle property names are the camelCase forms):**

- `storage`: `id` text PK; `kind` text not null, check in (`'workspace_root'`); `created_at` text not null.
- `asset_type`: `id` text PK; `key` text not null unique; `name` text not null; `sort_order` integer not null; `built_in` integer (boolean mode) not null.
- `asset`: `id` PK; `name` not null; `type_id` not null → `asset_type.id`; `description` not null default `''`; `status` not null with check on the five values; `created_at`, `updated_at` not null. Indexes `asset_type_id_idx`, `asset_status_idx`.
- `project`: `id` PK; `name` not null; `description` not null default `''`; `status` not null with check on the four values; `created_at`, `updated_at` not null.
- `project_asset`: `project_id` → `project.id`, `asset_id` → `asset.id`, primary key (`project_id`, `asset_id`); `priority` not null default `'normal'` with check; `intended_use` not null default `''`; `approval_status` not null default `'pending'` with check; `notes` not null default `''`; `assigned_at`, `updated_at` not null. Index `project_asset_asset_id_idx`.
- `asset_relation`: `from_asset_id`, `to_asset_id` → `asset.id`; `kind` not null with check; primary key (`from_asset_id`, `to_asset_id`, `kind`); `created_at` not null; check `from_asset_id <> to_asset_id`. Index `asset_relation_to_asset_id_idx`.
- `file` (changed): add `storage_id` text not null → `storage.id`; add `role` text nullable with check on the eight values; `asset_id` → `asset.id`; check `(asset_id is null) = (role is null)`; replace the unique index on `relative_path` by a unique index on (`storage_id`, `relative_path`); replace `file_asset_id_idx` by `file_asset_id_role_idx` on (`asset_id`, `role`).
- `file_move`: `file_id` text PK → `file.id`; `target_relative_path` not null; `target_asset_id` nullable → `asset.id`; `target_role` nullable with the role check; `created_at` not null; check `(target_asset_id is null) = (target_role is null)`.

No `ON DELETE` actions anywhere.

- [ ] **Step 1: Write the failing migration test** `migration-0001.test.ts`. Build a phase 1 database by running Drizzle's `migrate` against a temporary migrations folder that contains only `0000_brainy_tag.sql` and a `meta/_journal.json` with only its entry; insert the workspace row and three file rows (one `complete`, one `failed`, one `pending`) with raw better-sqlite3; close. Then `openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER)`:
  - `upgrades a phase 1 database`: `storages.getPrimary()` is non-null, its `id` passes `z.uuid()`, `kind` is `'workspace_root'`, `createdAt` equals the workspace row's `created_at`; `files.list({ limit: 10, offset: 0 })` returns the three rows, each passing `FileRecordSchema`, each with `storageId` = the primary ID and `role` = `null`, and `id`, `originalName`, `relativePath`, `sha256`, `status`, `importedAt` unchanged.
  - `leaves a database without rows without a storage`: migrate an empty phase 1 database → `getPrimary()` is `null`; `ensurePrimary({ id, createdAt })` returns that row; a second `ensurePrimary` with another ID returns the first row.
  - `rejects a file row without a storage` (raw insert with `storage_id` null → throws) and `rejects a role without an asset` (raw insert → throws).
- [ ] **Step 2: Extend `database.test.ts` and the core tests** (failing first):
  - `markComplete and markFailed reject for an unknown id` → `NotFoundError`.
  - `meta.init rejects a second row` → `InvalidOperationError`.
  - `a list page and its total come from one snapshot`: assert the repository calls its query pair inside `db.transaction` (spy) — or, if simpler, that `total` equals the row count for three pages of a 5-row table.
  - `journal_mode is wal and foreign_keys is on` (raw pragma read through a second connection is not possible for `foreign_keys`; expose nothing new — assert through behaviour: inserting an `asset` with an unknown `type_id` via raw SQL on the adapter's connection throws. Use `openWorkspaceDatabase`'s existing test seam if there is one; otherwise skip the `wal` part.)
  - core `import.test.ts`: `stores the storage id on the imported file` — the pending row and the returned record carry `ctx.storageId`, `role` is `null`.
  - core `workspace-lifecycle.test.ts`: `creates the primary storage on first open and reuses it afterwards` — the ID after reopening equals the first one.
- [ ] **Step 3: Run** the tests — they fail.
- [ ] **Step 4: Change `schema.ts`** as listed, then `pnpm --filter @assetforge/persistence db:generate`.
- [ ] **Step 5: Hand-edit the generated `0001` SQL** so it upgrades existing data. Required result, in this order:
  1. Create `storage`.
  2. Insert the primary storage only if `workspace` or `file` has at least one row: `kind` `'workspace_root'`; `created_at` from the workspace row, falling back to the current UTC time in ISO 8601 with milliseconds and `Z`; `id` a valid lowercase UUID v4 built in SQL from `randomblob` (version nibble `4`, variant nibble one of `8`, `9`, `a`, `b`).
  3. Create `asset_type`, `asset`, `project`, `project_asset`, `asset_relation`.
  4. Rebuild `file` (new table, copy, drop, rename, indexes), copying every existing row with `storage_id = (SELECT id FROM storage LIMIT 1)` and `role = NULL`.
  5. Create `file_move`.

  Keep Drizzle's `--> statement-breakpoint` separators. Do not edit the generated snapshot. Add a comment at the top of the file stating that it is hand-edited and why.
- [ ] **Step 6: Implement** `storage-repository.ts`; the file repository changes (explicit column mapping in `insertPending` instead of spreading; `.changes === 0` → `NotFoundError`; `list` reads page and count in one transaction; `toRecord` maps `storageId` and `role`); the `meta.init` guard; wire `storages` into `openWorkspaceDatabase`.
- [ ] **Step 7: Implement the core side.** `WorkspaceManager.open` calls `database.storages.ensurePrimary({ id: host.newId(), createdAt: host.now().toISOString() })` after the metadata check and keeps the ID with the open workspace; `importFiles` passes it as `ImportContext.storageId`; `importFile` writes it to the pending row and into both returned records, with `role: null`. If `database.close()` throws inside the `open` error path, the original error is the one that propagates. Update `fakes.ts` (in-memory `StorageRepository`; file fake stores `storageId`, `role`; the fake `markComplete` / `markFailed` / `init` follow the new contracts).
- [ ] **Step 8: Run** `pnpm test` and `pnpm typecheck` — green. Open the phase 1 acceptance test output and confirm it still passes unchanged.
- [ ] **Step 9: Commit and push** — `feat(persistence): asset management schema and storage reference (migration 0001)`.

---

### Task 4: Workspace session, `read` and `exclusive`

**Model:** opus

**Files:**
- Create: `packages/core/src/serial-queue.ts`, `packages/core/src/session.ts`
- Modify: `packages/core/src/workspace-manager.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/serial-queue.test.ts`, `packages/core/test/workspace-session.test.ts`

**Interfaces — produces:**

```ts
// serial-queue.ts
export class SerialQueue {
  /** Runs `fn` after everything queued before it has settled; a rejection does not stop the queue. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

// session.ts
export interface WorkspaceSession {
  readonly summary: WorkspaceSummary;
  readonly storage: Storage;
  readonly storageId: string;
  readonly database: WorkspaceDatabase;
  newId(): string;
  now(): Date;
}

// WorkspaceManager
read<T>(fn: (session: WorkspaceSession) => Promise<T>): Promise<T>;       // not queued
exclusive<T>(fn: (session: WorkspaceSession) => Promise<T>): Promise<T>;  // queued
```

- `create`, `open`, `close`, `remove`, `importFiles` and `exclusive` run through one `SerialQueue` owned by the manager. `list`, `current`, `listFiles` and `read` do not queue.
- `read` and `exclusive` reject with `NoWorkspaceOpenError` when no workspace is open *at the moment `fn` would start*; they never throw synchronously.
- Public methods enqueue; the work lives in private unqueued methods so `create` → open and `open` → close do not deadlock.

- [ ] **Step 1: Write the failing tests.**
  - `serial-queue.test.ts`: `runs operations one at a time in call order` (three operations with controllable deferreds; record start/end); `a rejected operation does not block the next one`; `returns each operation's own result`.
  - `workspace-session.test.ts` (with the fakes): `read hands out the open workspace's session` (`summary.id`, `storageId` match); `read and exclusive reject with no_workspace_open when nothing is open`; `close waits for a running exclusive operation` (start `exclusive` with a deferred, call `close()`, assert the fake database is not closed until the deferred resolves); `an exclusive operation queued behind close rejects with no_workspace_open`; `create still opens the workspace` (no deadlock: resolves); `importFiles and close do not interleave` (close called during an import → all files `complete`, database closed afterwards).
- [ ] **Step 2: Run** `pnpm --filter @assetforge/core test` — the new tests fail.
- [ ] **Step 3: Implement** `SerialQueue`, `WorkspaceSession`, and the manager changes.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 5: Commit and push** — `feat(core): workspace session with serialized mutations`.

---

### Task 5: Asset types, projects and assets

**Model:** sonnet

**Files:**
- Create: `packages/core/src/asset-types.ts`, `packages/core/src/projects.ts`, `packages/core/src/assets.ts`
- Create: `packages/persistence/src/asset-type-repository.ts`, `project-repository.ts`, `asset-repository.ts`, `packages/persistence/src/like.ts`
- Modify: `packages/core/src/ports.ts`, `packages/core/src/index.ts`, `packages/core/src/workspace-manager.ts`, `packages/core/test/fakes.ts`, `packages/persistence/src/open-database.ts`
- Test: `packages/core/test/projects-assets.test.ts`, `packages/persistence/test/library-repositories.test.ts`

**Interfaces — consumes:** `WorkspaceSession`, `NotFoundError`, the contracts types of Task 2.

**Interfaces — produces:**

```ts
// ports.ts
export interface Page { limit: number; offset: number }
export interface AssetTypeRepository {
  list(): Promise<AssetType[]>;                     // by sortOrder, then name
  get(id: string): Promise<AssetType | null>;
  insertMissing(types: AssetType[]): Promise<void>; // skips rows whose key already exists
}
export interface ProjectRepository {
  insert(project: Project): Promise<void>;
  get(id: string): Promise<Project | null>;
  update(id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'status'>> & { updatedAt: string }): Promise<Project | null>;
  list(q: Page): Promise<ProjectList>;              // by name (case-insensitive), then id
}
export interface AssetQuery extends Page { typeId?: string; status?: AssetStatus; projectId?: string; nameContains?: string }
export interface AssetRepository {
  insert(asset: Asset): Promise<void>;
  get(id: string): Promise<Asset | null>;
  update(id: string, patch: Partial<Pick<Asset, 'name' | 'description' | 'typeId' | 'status'>> & { updatedAt: string }): Promise<Asset | null>;
  list(q: AssetQuery): Promise<AssetList>;          // by name (case-insensitive), then id
}
// WorkspaceDatabase gains: assetTypes, projects, assets

// asset-types.ts
export const BUILT_IN_ASSET_TYPES: readonly { key: string; name: string }[]; // index = sortOrder
export function ensureBuiltInAssetTypes(ctx: { database: WorkspaceDatabase; newId(): string }): Promise<void>;
export function listAssetTypes(s: WorkspaceSession): Promise<AssetType[]>;

// projects.ts
export function createProject(s: WorkspaceSession, input: { name: string; description?: string }): Promise<Project>;
export function updateProject(s: WorkspaceSession, id: string, patch: { name?: string; description?: string; status?: ProjectStatus }): Promise<Project>;
export function getProject(s: WorkspaceSession, id: string): Promise<Project>;
export function listProjects(s: WorkspaceSession, q: Page): Promise<ProjectList>;

// assets.ts
export function createAsset(s: WorkspaceSession, input: { name: string; typeId: string; description?: string }): Promise<Asset>;
export function updateAsset(s: WorkspaceSession, id: string, patch: { name?: string; description?: string; typeId?: string; status?: AssetStatus }): Promise<Asset>;
export function getAsset(s: WorkspaceSession, id: string): Promise<Asset>;
export function listAssets(s: WorkspaceSession, q: AssetQuery): Promise<AssetList>;
```

Built-in types, in this order: `character` Character, `creature` Creature, `landscape` Landscape, `building` Building, `vehicle` Vehicle, `prop` Prop, `material` Material, `other` Other.

Rules: a new project has status `active`, a new asset `draft`; `description` defaults to `''`; `createdAt` = `updatedAt` = now on creation; every update sets `updatedAt`. `get*` / `update*` reject with `NotFoundError` for an unknown ID; `createAsset` / `updateAsset` reject with `NotFoundError` for an unknown `typeId`. `WorkspaceManager.open` calls `ensureBuiltInAssetTypes` after the primary storage is ensured. `nameContains` is a literal, case-insensitive substring match: `like.ts` exports `containsPattern(text: string): string` that escapes `\`, `%` and `_` for `LIKE … ESCAPE '\'`.

- [ ] **Step 1: Write the failing persistence tests** (`library-repositories.test.ts`, real SQLite):
  - `insertMissing adds only missing keys` (call twice with new IDs → still eight rows, IDs from the first call).
  - `lists projects by name with their asset count` (after Task 6 the count is exercised again; here it is `0`) and `pages with a stable total`.
  - `filters assets by type, status and name` — names `Gas station`, `gas_pump`, `100% wool`, `Motel`: `nameContains: 'GAS'` → the first two; `'_'` → only `gas_pump`; `'%'` → only `100% wool`; combined `typeId` + `status` narrows further; `total` reflects the filter.
  - `update returns null for an unknown id and the changed row otherwise`.
  - `rejects an asset with an unknown type` (foreign key).
- [ ] **Step 2: Write the failing core tests** (`projects-assets.test.ts`, fakes; a fixed clock that advances): `opening a workspace seeds the eight built-in asset types once` (reopen → still eight, same IDs); `createProject applies defaults`; `createAsset rejects an unknown type with not_found`; `updateAsset changes only the given fields and bumps updatedAt`; `getAsset rejects an unknown id with not_found`; `updateProject can archive a project`.
- [ ] **Step 3: Run** both test files — they fail.
- [ ] **Step 4: Implement** ports, repositories (page and count in one transaction; counts via correlated subqueries on `project_asset` and `file`), fakes, use cases, and the call in `open`.
- [ ] **Step 5: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 6: Commit and push** — `feat: asset types, projects and assets`.

---

### Task 6: Project assignments and asset relations

**Model:** sonnet

**Files:**
- Create: `packages/core/src/assignments.ts`, `packages/core/src/relations.ts`, `packages/persistence/src/project-asset-repository.ts`, `asset-relation-repository.ts`
- Modify: `packages/core/src/ports.ts`, `packages/core/src/index.ts`, `packages/core/test/fakes.ts`, `packages/persistence/src/open-database.ts`
- Test: `packages/core/test/assignments-relations.test.ts`, `packages/persistence/test/library-repositories.test.ts`

**Interfaces — consumes:** Task 5's repositories and use cases.

**Interfaces — produces:**

```ts
// ports.ts
export interface AssignmentKey { projectId: string; assetId: string }
export interface ProjectAssetRepository {
  insert(a: ProjectAssignment): Promise<void>;
  get(key: AssignmentKey): Promise<ProjectAssignment | null>;
  update(key: AssignmentKey, patch: Partial<Pick<ProjectAssignment, 'priority' | 'intendedUse' | 'approvalStatus' | 'notes'>> & { updatedAt: string }): Promise<ProjectAssignment | null>;
  remove(key: AssignmentKey): Promise<boolean>;                       // false if there was none
  listByAsset(assetId: string): Promise<AssetAssignment[]>;           // by project name, then id
  listByProject(projectId: string, q: Page): Promise<ProjectMemberList>; // by asset name, then id
}
export interface RelationKey { fromAssetId: string; toAssetId: string; kind: RelationKind }
export interface AssetRelationRepository {
  insert(r: AssetRelation): Promise<boolean>;                         // false if it already exists
  remove(key: RelationKey): Promise<boolean>;
  listForAsset(assetId: string): Promise<AssetRelationView[]>;        // outgoing first, then incoming; each by kind, then other.name
}
// WorkspaceDatabase gains: projectAssets, relations

// assignments.ts
export function assignAsset(s: WorkspaceSession, key: AssignmentKey): Promise<ProjectAssignment>;
export function updateAssignment(s: WorkspaceSession, key: AssignmentKey, patch: { priority?: AssignmentPriority; intendedUse?: string; approvalStatus?: ApprovalStatus; notes?: string }): Promise<ProjectAssignment>;
export function removeAssignment(s: WorkspaceSession, key: AssignmentKey): Promise<void>;
export function listAssignmentsOfAsset(s: WorkspaceSession, assetId: string): Promise<AssetAssignment[]>;
export function listMembersOfProject(s: WorkspaceSession, projectId: string, q: Page): Promise<ProjectMemberList>;

// relations.ts
export function addRelation(s: WorkspaceSession, key: RelationKey): Promise<AssetRelation>;
export function removeRelation(s: WorkspaceSession, key: RelationKey): Promise<void>;
export function listRelations(s: WorkspaceSession, assetId: string): Promise<AssetRelationView[]>;
```

Rules: `assignAsset` rejects with `NotFoundError` when the project or the asset does not exist; when the assignment already exists it returns it unchanged; otherwise it inserts with `priority: 'normal'`, `approvalStatus: 'pending'`, empty `intendedUse` and `notes`, `assignedAt` = `updatedAt` = now. `updateAssignment` rejects with `NotFoundError` when there is no such assignment. `removeAssignment` and `removeRelation` resolve also when nothing was there. `addRelation` rejects with `InvalidOperationError` when `fromAssetId === toAssetId`, with `NotFoundError` for an unknown asset; an existing relation is returned unchanged. List functions reject with `NotFoundError` for an unknown asset / project.

- [ ] **Step 1: Write the failing persistence tests:** `an asset can be assigned to several projects` (`listByAsset` returns both, ordered by project name, each with its `project`); `the same assignment cannot be inserted twice` (primary key violation); `removing an assignment leaves the asset, its file rows and its other assignments` (insert a file row for the asset first; after `remove` the asset, the file row and the second assignment are still there); `listByProject pages members with their asset`; `project and asset lists report assignment counts` (`assetCount`, `projectCount`, and the `projectId` filter of `AssetRepository.list`); `insert returns false for an existing relation`; `listForAsset returns outgoing and incoming relations with the other asset`; `rejects a relation of an asset to itself` (check constraint, raw insert).
- [ ] **Step 2: Write the failing core tests:** `assigning twice returns the first assignment unchanged`; `assignAsset rejects an unknown project or asset with not_found`; `updateAssignment changes project-specific data without touching the asset` (asset `updatedAt` unchanged); `removeAssignment is a no-op for a missing assignment`; `addRelation rejects a self-relation with invalid_operation`; `adding a relation twice keeps one`; `listRelations shows the relation from both sides` (`outgoing` on A, `incoming` on B).
- [ ] **Step 3: Run** — the new tests fail.
- [ ] **Step 4: Implement** ports, repositories, fakes and use cases.
- [ ] **Step 5: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 6: Commit and push** — `feat: project assignments and asset relations`.

---

### Task 7: File roles and crash-safe placement

**Model:** opus

**Files:**
- Create: `packages/core/src/asset-files.ts`, `packages/persistence/src/file-move-repository.ts`
- Modify: `packages/contracts/src/files.ts`, `packages/core/src/paths.ts`, `packages/core/src/ports.ts`, `packages/core/src/workspace-manager.ts`, `packages/core/src/index.ts`, `packages/core/test/fakes.ts`, `packages/persistence/src/file-repository.ts`, `packages/persistence/src/open-database.ts`
- Test: `packages/core/test/asset-files.test.ts`, `packages/core/test/paths.test.ts`, `packages/persistence/test/library-repositories.test.ts`

**Interfaces — produces:**

```ts
// contracts/files.ts
export const FileScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('inbox') }),
  z.object({ kind: z.literal('asset'), assetId: z.uuid() }),
]);
export const FileTargetSchema = z.object({ assetId: z.uuid(), role: FileRoleSchema });
export type FileScope / FileTarget

// core/paths.ts
export const ROLE_DIRS: Record<FileRole, string>;
// reference, concept -> 'references'; generated -> 'generations'; model, working -> 'models';
// texture -> 'textures'; final, other -> 'miscellaneous'
export function assetFilePath(assetId: string, role: FileRole, fileId: string, originalName: string): string;
// `assets/${assetId}/${ROLE_DIRS[role]}/${fileId}_${sanitizeFileName(originalName)}`

// core/ports.ts
export interface FilePlacement { relativePath: string; assetId: string | null; role: FileRole | null }
export interface FileMove { fileId: string; targetRelativePath: string; targetAssetId: string | null; targetRole: FileRole | null; createdAt: string }
export interface FileMoveRepository {
  begin(move: FileMove): Promise<void>;        // rejects if the file already has a move row
  /** One transaction: copy the target into the file row, delete the move row. NotFoundError if there is no move row. */
  commit(fileId: string): Promise<FileRecord>;
  abort(fileId: string): Promise<void>;        // no-op if missing
  list(): Promise<FileMove[]>;                 // by createdAt, then fileId
}
// FileRepository gains:
get(id: string): Promise<FileRecord | null>;
setPlacement(id: string, placement: FilePlacement): Promise<FileRecord>;   // NotFoundError for an unknown id
list(q: Page & { scope: FileScope }): Promise<FileList>;                   // replaces list(q: Page); newest importedAt first
// WorkspaceDatabase gains: fileMoves

// core/asset-files.ts
export function relocateFile(s: WorkspaceSession, fileId: string, target: FileTarget | null): Promise<FileRecord>;
export function recoverFileMoves(ctx: { storage: Storage; fileMoves: FileMoveRepository }): Promise<{ completed: string[]; discarded: string[] }>;
export function listFiles(s: WorkspaceSession, q: Page & { scope: FileScope }): Promise<FileList>;

// WorkspaceManager
importFiles(sourcePaths: string[], target?: FileTarget | null): Promise<ImportResult[]>;
listFiles(q: Page & { scope: FileScope }): Promise<FileList>;
```

**`relocateFile`, in this order:**
1. Load the file → `NotFoundError` if missing; `InvalidOperationError` unless `status === 'complete'`.
2. If `target` is set, the asset must exist → `NotFoundError`.
3. New path = `assetFilePath(target.assetId, target.role, file.id, file.originalName)`, or `inboxPath(file.id, file.originalName)` for `null`.
4. Same placement as now (path, asset and role all equal) → return the record unchanged.
5. Same path, different role or asset → `files.setPlacement` only; no move, no intent row.
6. Otherwise `fileMoves.begin` → `storage.move(file.relativePath, newPath)` → `fileMoves.commit(file.id)`. If the move rejects: `fileMoves.abort(file.id)`, then rethrow.

**`recoverFileMoves`:** for every move row: `storage.exists(targetRelativePath)` → `commit`, otherwise `abort`. Best effort like import recovery: a failure on one row is skipped and retried on the next open. `WorkspaceManager.open` runs it after `recoverIncompleteImports`.

**`importFiles` with a target:** verify the asset exists before anything is imported (`NotFoundError`); import each file as before; relocate each `complete` result. If the relocation fails, the result keeps the inbox record and carries the error message in `error`.

- [ ] **Step 1: Write the failing tests.**
  - `paths.test.ts`: `assetFilePath builds assets/<asset>/<role dir>/<file>_<name>` for all eight roles (table test with the mapping above); `sanitizes the original name` (`'a/b:c.png'` cannot introduce a path segment).
  - persistence: `commit applies the target and deletes the move row atomically`; `commit rejects with not_found when there is no move row`; `begin rejects a second move for the same file`; `lists files by scope` (inbox = `asset_id` null, asset = that asset only, all = everything; `total` per scope); `setPlacement rejects for an unknown id`; `a file cannot reference an unknown asset`.
  - core `asset-files.test.ts` (fakes): `assigning an inbox file moves it into the asset's role directory` (old path gone, new path exists, record has `assetId`, `role`, new `relativePath`, no move row left); `changing the role inside one directory only updates the row` (`reference` → `concept`: no `move` call on the storage); `changing the role across directories moves the file`; `detaching moves the file back to its inbox path`; `relocating to the current placement does nothing`; `rejects a pending or failed file with invalid_operation`; `rejects an unknown asset with not_found and leaves the file untouched`; `a failed move leaves row and file unchanged and no move row` (`storage.failNext('move', …)`); `never overwrites an existing target` (pre-create the target path → rejects, source still in place); `recovery completes a move whose target exists`; `recovery discards a move whose target is missing`; `recovery runs when the workspace is opened` (seed a move row + moved file in the fakes, reopen, record updated); `importing into an asset places the files and reports the placed records`; `importing into an unknown asset imports nothing`.
- [ ] **Step 2: Run** — the new tests fail.
- [ ] **Step 3: Implement** contracts, paths, ports, repositories, fakes, use cases and the manager changes. `manager.importFiles` keeps running inside the queue.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green (existing callers of `listFiles` / `files.list` are adapted with scope `all`; the IPC request changes in Task 8).
- [ ] **Step 5: Commit and push** — `feat: file roles and crash-safe placement in asset directories`.

---

### Task 8: IPC channels, handlers and acceptance test

**Model:** sonnet

**Files:**
- Modify: `packages/contracts/src/ipc.ts`, `apps/desktop/src/main/ipc.ts`
- Create: `apps/desktop/src/main/library-handlers.ts`
- Test: `apps/desktop/test/library-ipc.test.ts` (new), `apps/desktop/test/ipc.test.ts`, `apps/desktop/test/acceptance.test.ts`, `packages/contracts/test/schemas.test.ts`

**Interfaces — produces (request → response):**

| Channel | Request | Response |
| --- | --- | --- |
| `assetTypes:list` | `{}` | `AssetType[]` |
| `projects:list` | `PageRequest` | `ProjectList` |
| `projects:get` | `{ id }` | `Project` |
| `projects:create` | `{ name: NameInput, description?: DescriptionInput }` | `Project` |
| `projects:update` | `{ id, patch: { name?: NameInput, description?: DescriptionInput, status?: ProjectStatus } }` | `Project` |
| `assets:list` | `PageRequest & { typeId?, status?, projectId?, nameContains?: string (max 200) }` | `AssetList` |
| `assets:get` | `{ id }` | `Asset` |
| `assets:create` | `{ name: NameInput, typeId, description?: DescriptionInput }` | `Asset` |
| `assets:update` | `{ id, patch: { name?, description?, typeId?, status? } }` | `Asset` |
| `assignments:listByAsset` | `{ assetId }` | `AssetAssignment[]` |
| `assignments:listByProject` | `PageRequest & { projectId }` | `ProjectMemberList` |
| `assignments:assign` | `{ projectId, assetId }` | `ProjectAssignment` |
| `assignments:update` | `{ projectId, assetId, patch: { priority?, intendedUse?: IntendedUseInput, approvalStatus?, notes?: NotesInput } }` | `ProjectAssignment` |
| `assignments:remove` | `{ projectId, assetId }` | `null` |
| `relations:list` | `{ assetId }` | `AssetRelationView[]` |
| `relations:add` | `{ fromAssetId, toAssetId, kind }` | `AssetRelation` |
| `relations:remove` | `{ fromAssetId, toAssetId, kind }` | `null` |
| `files:list` (changed) | `PageRequest & { scope: FileScope }` | `FileList` |
| `files:import` (changed) | `{ sourcePaths, target?: FileTarget }` | `ImportResult[]` |
| `files:assign` | `{ fileId, assetId, role }` | `FileRecord` |
| `files:unassign` | `{ fileId }` | `FileRecord` |

All IDs are `z.uuid()`. Patch objects are `z.object({...}).strict()` with every key optional. Handlers: reads go through `manager.read`, mutations through `manager.exclusive`, each calling the use case of Tasks 5–7. `library-handlers.ts` exports `createLibraryHandlers(manager: WorkspaceManager)` returning the handlers for the non-`workspace:`/`dialog:` channels; `createWorkspaceHandlers` spreads it in. The preload stays a pass-through.

- [ ] **Step 1: Write the failing tests.**
  - `schemas.test.ts`: `assets:create rejects a whitespace-only name`; `assets:update rejects unknown patch keys`; `files:list requires a scope`.
  - `library-ipc.test.ts` (through `dispatch`, real composition in a temp directory): `returns no_workspace_open for every library channel when nothing is open` (loop over the new channels with a valid request each); `creates and lists an asset through IPC` (response passes the contract; `nameContains: '%'` matches nothing for a name without `%`); `maps an unknown asset to not_found`; `maps a self-relation to invalid_operation`; `rejects a whitespace-only project name as invalid_request`.
  - `acceptance.test.ts`, new `describe('phase 2a acceptance')` on the real adapters:
    - `uses one asset in two projects and removes an assignment without losing anything`: create workspace; create asset (type `character`) and two projects; assign to both; import `a.png` into the asset with role `reference`; the file exists on disk at `assets/<asset id>/references/<file id>_a.png` and not in `inbox/`; remove the first assignment; then: asset still returned by `assets:get`, `assignments:listByAsset` has exactly the second project, the file row is unchanged and the file is still on disk with the same SHA-256.
    - `keeps assets, assignments, relations, placement and status across a restart`: set status `in_review`, add a `uses` relation to a second asset, close, build a new manager, reopen → all values identical; `assetTypes:list` still has eight types with the same IDs.
    - `completes an interrupted move on the next open`: import a file into the inbox; inside `manager.exclusive` write a move row with `database.fileMoves.begin` and call `storage.move` by hand (no commit); close; reopen → the record has the asset, the role and the new path, and `fileMoves.list()` is empty.
    - `discards a move that never happened`: only the move row, no move on disk → after reopen the record is unchanged and the row is gone.
    - `no absolute path is stored`: after the first scenario, read every text column of every table with raw better-sqlite3 and assert none contains `workspaceRoot` or `userDataPath`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test` and the contracts tests — the new tests fail.
- [ ] **Step 3: Implement** the contract entries and the handlers. Adapt the renderer's existing `files:list` call to send `scope: { kind: 'inbox' }` so the app keeps building (the screen itself changes in Task 9).
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck` and `pnpm --filter @assetforge/desktop build` — green.
- [ ] **Step 5: Commit and push** — `feat(desktop): IPC for projects, assets, assignments, relations and file placement`.

---

### Task 9: Renderer — shell, lists and inbox

**Model:** sonnet

**Files:**
- Create: `apps/desktop/src/renderer/src/nav.ts`, `labels.ts`, `hooks/useLoad.ts`, `components/Pager.tsx`, `components/AssetPicker.tsx`, `components/WorkspaceShell.tsx`, `screens/AssetsScreen.tsx`, `screens/ProjectsScreen.tsx`
- Modify: `App.tsx`, `screens/FilesScreen.tsx` (becomes the inbox), `api.ts`
- Test: `apps/desktop/test/labels.test.ts`, `apps/desktop/test/use-load.test.ts`

**Interfaces — produces:**

```ts
// nav.ts
export type View =
  | { name: 'assets' } | { name: 'asset'; id: string }
  | { name: 'projects' } | { name: 'project'; id: string }
  | { name: 'inbox' };

// labels.ts
export function label(value: string): string;                 // 'in_progress' -> 'In progress', 'variant_of' -> 'Variant of'
export function relationLabel(kind: RelationKind, direction: 'outgoing' | 'incoming'): string;
// outgoing: 'Uses', 'Variant of', 'Part of', 'Derived from'; incoming: 'Used by', 'Has variant', 'Has part', 'Source of'

// hooks/useLoad.ts
export function latestOnly<T>(): (promise: Promise<T>) => Promise<{ stale: boolean; value?: T; error?: unknown }>; // pure, testable
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): { data: T | null; error: string | null; loading: boolean; reload(): void };

// components
export function Pager(props: { offset: number; limit: number; total: number; onChange(offset: number): void }): JSX.Element;
export function AssetPicker(props: { excludeIds?: readonly string[]; onPick(asset: Asset): void }): JSX.Element;
export function WorkspaceShell(props: { workspace: WorkspaceSummary; onClosed(): void }): JSX.Element;
```

Behaviour:
- `WorkspaceShell` owns the `View` state (initial `{ name: 'assets' }`) and renders a header with the workspace name, a `nav` with the buttons "Assets", "Projects", "Inbox" (`aria-current="page"` on the active one) and "Close workspace", then the active screen. `App` renders it instead of `FilesScreen`. Until Task 10, the views `asset` and `project` render the list screens.
- `useLoad` shows the error of a failed load (`role="alert"`, via `describeError`) instead of staying on "Loading…", clears the error on the next successful load, and ignores responses of superseded calls. Every list in Tasks 9 and 10 uses it.
- Page size is 50 everywhere.
- *Assets*: filters (type select, status select, project select, name input with `aria-label="Filter by name"`); table with name (button opening the asset), type, status, projects, files; `Pager`; create form (name input, type select, "Create"). After creating, open the new asset.
- *Projects*: table with name (button opening the project), status, assets; `Pager`; create form (name, "Create").
- *Inbox*: the existing import and list, scoped to `{ kind: 'inbox' }`; each `complete` row gets "Assign", which reveals an `AssetPicker` and a role select in that row and calls `files:assign`; the row disappears after a successful assignment. Also fix: React keys by file ID (not source path) for import results.
- `AssetPicker`: a text input (`aria-label="Search assets"`) and up to 10 results from `assets:list` with `nameContains`, each a button with the asset name; `excludeIds` are not shown.
- Add copy for the new codes in `api.ts`: `not_found` → "This item no longer exists.", `invalid_operation` falls back to the message from the main process.

- [ ] **Step 1: Write the failing tests.** `labels.test.ts`: the examples above plus `label('draft') === 'Draft'`, `label('on_hold') === 'On hold'`, and all eight `relationLabel` combinations. `use-load.test.ts`: `latestOnly marks an earlier promise stale when a later one was registered`, `passes value and error through for the latest promise`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test labels use-load` — fail.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build` — green. Grep the renderer for `<button` and confirm every one uses `BUTTON`.
- [ ] **Step 5: Commit and push** — `feat(desktop): workspace shell with assets, projects and inbox screens`.

---

### Task 10: Renderer — asset and project detail

**Model:** sonnet

**Files:**
- Create: `screens/AssetScreen.tsx`, `screens/ProjectScreen.tsx`, `components/AssignmentFields.tsx`, `components/CommitInput.tsx`
- Modify: `components/WorkspaceShell.tsx`

**Interfaces — consumes:** `View`, `useLoad`, `label`, `relationLabel`, `Pager`, `AssetPicker`, the IPC channels of Task 8.

**Interfaces — produces:**

```ts
/** Text input or textarea that commits on blur and on Enter (Ctrl+Enter in a textarea), only when the value changed. */
export function CommitInput(props: { value: string; onCommit(value: string): void; label: string; multiline?: boolean; maxLength: number }): JSX.Element;
/** Priority, approval status, intended use and notes of one assignment; saves each change through assignments:update. */
export function AssignmentFields(props: { assignment: ProjectAssignment; onChanged(next: ProjectAssignment): void }): JSX.Element;
```

Behaviour:
- Saving: selects save on change, text fields through `CommitInput`. There is no "Save" button. A failed save shows the error (`role="alert"`) and restores the last saved value.
- *Asset detail* (`AssetScreen`, props `{ id, onNavigate(view: View) }`): "Back" to the list; name, description, type select, status select; sections:
  - **Projects** — one row per assignment: project name (button opening the project), `AssignmentFields`, "Remove". Below: a project select with the projects not yet assigned and "Add to project".
  - **Files** — grouped by role with the role label as subheading; per file: original name, size, a role select (change → `files:assign` with the new role) and "Detach" (`files:unassign`). Below: a role select and "Import files" (`dialog:pickFiles` → `files:import` with the target). Paged with `Pager` when there are more than 50.
  - **Relations** — one row per relation: `relationLabel`, the other asset's name (button opening it), "Remove". Below: a relation kind select, an `AssetPicker` excluding this asset, which adds an outgoing relation on pick.
- *Project detail* (`ProjectScreen`, props `{ id, onNavigate }`): "Back"; name, description, status select; **Assets** — paged members: asset name (button opening the asset), type, status, `AssignmentFields`, "Remove"; below an `AssetPicker` excluding current members that assigns on pick.
- Every "Remove" and "Detach" button has an `aria-label` naming its target (for example `Remove Gas station from Gilded Hour`) and a `title` tooltip saying that the asset and its files are kept.
- `WorkspaceShell` renders these screens for the `asset` and `project` views.

- [ ] **Step 1: Implement** the components and screens.
- [ ] **Step 2: Run** `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build` — green. Grep the renderer: every `<button` uses `BUTTON`; no paragraph of instructional text was added.
- [ ] **Step 3: Commit and push** — `feat(desktop): asset and project detail screens`.

---

### Task 11: End-to-end check and documentation

**Model:** controller (the session running the plan), not a subagent.

- [ ] **Step 1: Build and drive the real application** (`pnpm --filter @assetforge/desktop build`, launch with `ELECTRON_RUN_AS_NODE` removed from the environment, a temporary `userData` directory and remote debugging) through this scenario, checking the UI and the disk after each step: create a workspace → create asset "Gas station" (Building) → create projects "Gilded Hour" and "Route 66" → assign the asset to both → set priority `high` and approval `approved` in one of them and confirm the other still shows the defaults → import two files into the inbox, assign one to the asset as `reference`, import one directly into the asset as `model` → both lie under `assets/<asset id>/…` → change the reference file's role to `texture` and see it move → add a `uses` relation to a second asset and see it from both sides → remove the "Route 66" assignment: asset, files and the other assignment remain → set status `in_review` → close and reopen the workspace: everything is as left. No errors in the console; keyboard-only operation works for the create forms.
- [ ] **Step 2: Open a workspace that was created with the phase 1 build** (a copy of a phase 1 `userData` + workspace folder, or one created from `main` before this branch) and confirm its files are listed in the inbox.
- [ ] **Step 3: Update the documentation.** `ReadMe.md`: §9.2 the role → directory mapping and that all managed files carry the file UUID prefix; §9.4 the move protocol (`file_move` intent, repair on open); §10 mark what exists. `CLAUDE.md`: "Project state" (phase 2a implemented; what does not exist yet). Rename `docs/phase-2-backlog.md` to `docs/backlog.md`, remove everything this phase fixed, and add what the task reviews parked.
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck` — green. **Commit and push** — `docs: phase 2a state, storage layout and remaining backlog`.
- [ ] **Step 5: Final whole-branch review** (most capable model), one fix wave, then finish the branch. Phase 2b starts from the result.
