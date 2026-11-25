# Phase 1 – Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable Electron app in which a workspace can be created, closed and reopened, with files imported into its inbox and their metadata preserved.

**Architecture:** pnpm monorepo. `contracts` (Zod schemas, IPC contract) and `core` (ports, use cases) are platform-neutral; `storage` (local file system) and `persistence` (better-sqlite3 + Drizzle) implement the core ports; `apps/desktop` composes them and exposes them to a sandboxed React renderer through typed IPC. Imports follow pending row → staging → checksum verification → move → commit, with cleanup on the next open.

**Tech Stack:** TypeScript, Electron, electron-vite, React, Tailwind CSS v4, Zod, better-sqlite3, Drizzle ORM + drizzle-kit, Vitest, pnpm workspaces. Current stable versions, pinned by the lockfile.

**Spec:** `docs/superpowers/specs/2026-11-25-phase-1-foundation-design.md` (overall architecture: `ReadMe.md`)

## Global Constraints

- Everything in the repository is English (code, identifiers, comments, commit messages, docs).
- Package scope `@assetforge/*`; packages are ESM, `"type": "module"`, and export TypeScript source directly (`"exports": "./src/index.ts"`); no per-package build step.
- `core` and `contracts` must not import Electron, better-sqlite3, Drizzle or `storage`/`persistence`. `core` may import `contracts` and Node built-ins (`node:stream`, `node:crypto` types only where a port needs them).
- No persistence logic in renderer or preload.
- The database stores only paths relative to the workspace root, always with `/` separators. No absolute paths in any table.
- SQLite lives under Electron `userData` (`workspaces/<workspace-uuid>/assetforge.sqlite`), never in the workspace folder.
- IDs are UUID v4 (`crypto.randomUUID()`), timestamps are ISO 8601 UTC strings.
- An imported file is never overwritten; the source file is never modified.
- Workspace manifest `formatVersion` is `1`.
- Port methods are async (return `Promise`) even where the SQLite adapter is synchronous, so a server adapter can replace it later.
- Tests that load better-sqlite3 run under Electron's Node (`ELECTRON_RUN_AS_NODE=1`), because the native binary is built for the Electron ABI only.
- Commits are local only; nothing in this plan pushes.

## Review Focus

1. A source path that is a directory, missing, or unreadable → that file's result is `failed` with a clear error, no staging leftover, and the remaining files of the batch are still imported. (Task 7)
2. Two different files with the same name, or the same file imported twice → both are kept as separate entries; the second import reports `duplicateOf`. (Task 7)
3. File names with Unicode, path separators, reserved characters or extreme length → stored under a sanitized name, original name preserved in the database, nothing written outside `inbox/`. (Tasks 3, 4)
4. Workspace root unreachable when opening (NAS offline, drive unplugged) → `StorageUnreachableError`, distinct from `WorkspaceNotFoundError`; the registry entry is kept. (Task 6)
5. Workspace folder moved or copied to a new path, or a local database that belongs to a different workspace → moving updates the registered root and keeps the ID and all file records; a mismatching database is rejected with `WorkspaceMismatchError` instead of being silently reused. (Tasks 6, 8)

---

### Task 1: Monorepo scaffold and native-module gate

Everything else depends on better-sqlite3 loading under the Electron ABI on this machine. This task proves it before any other code is written. **If Step 4 cannot be made to pass, stop and report instead of continuing.**

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc` (only if needed)
- Create: `packages/persistence/package.json`, `packages/persistence/tsconfig.json`, `packages/persistence/vitest.config.ts`
- Test: `packages/persistence/test/native-module.test.ts`

**Interfaces:**
- Produces: root scripts `pnpm test` (runs `test` in every workspace package), `pnpm typecheck` (runs `tsc --noEmit` in every package), `pnpm dev` (added in Task 9). Workspace globs `apps/*` and `packages/*`. `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `module`/`moduleResolution` `Bundler`, `target` `ES2023`, `verbatimModuleSyntax`.
- Produces: the persistence test script `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`. Packages without native modules use plain `vitest run`.

- [ ] **Step 1: Create the root files and the `@assetforge/persistence` package skeleton** with devDependencies `electron`, `vitest`, `cross-env`, `typescript`, `@electron/rebuild` and dependency `better-sqlite3`. Allow the install/build scripts of `electron`, `better-sqlite3` and `esbuild` via the pnpm build-script allowlist in `pnpm-workspace.yaml` (`pnpm approve-builds` writes the correct key for the installed pnpm version). Add a root `postinstall` that rebuilds better-sqlite3 for the installed Electron version with `@electron/rebuild`.

- [ ] **Step 2: Write the failing test**

```ts
// packages/persistence/test/native-module.test.ts
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

test('better-sqlite3 loads under the Electron ABI and supports FTS5', () => {
  expect(process.versions.electron).toBeDefined();
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body); INSERT INTO t VALUES ('hello world');");
  expect(db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH 'hello'").get()).toEqual({ n: 1 });
  db.close();
});
```

- [ ] **Step 3: Run `pnpm install`**, then `pnpm --filter @assetforge/persistence test`. Expected before the rebuild is wired correctly: FAIL with a `NODE_MODULE_VERSION` mismatch or a missing binary.

- [ ] **Step 4: Fix the rebuild until the test passes.** Run: `pnpm --filter @assetforge/persistence test`. Expected: 1 passed.

- [ ] **Step 5: Commit** — `chore: scaffold monorepo and verify better-sqlite3 under Electron`

---

### Task 2: Contracts

**Files:**
- Create: `packages/contracts/package.json`, `tsconfig.json`, `src/index.ts`, `src/workspace.ts`, `src/files.ts`, `src/ipc.ts`
- Test: `packages/contracts/test/schemas.test.ts`

**Interfaces:**
- Produces (all exported from `@assetforge/contracts`, each schema with its inferred type of the same name minus `Schema`):

```ts
WorkspaceManifestSchema  // { id: uuid, formatVersion: number (int ≥ 1), name: string (1..200), createdAt: ISO datetime }
WorkspaceSummarySchema   // { id: uuid, name: string, rootPath: string, lastOpenedAt: ISO datetime }
ImportStatusSchema       // 'pending' | 'complete' | 'failed'
FileRecordSchema         // { id: uuid, assetId: uuid | null, originalName: string, relativePath: string,
                         //   mimeType: string, sizeBytes: number | null, sha256: string (64 hex) | null,
                         //   status: ImportStatus, error: string | null, importedAt: ISO datetime }
ImportResultSchema       // { sourcePath: string, file: FileRecord | null, error: string | null, duplicateOf: uuid[] }
FileListSchema           // { items: FileRecord[], total: number }
IpcErrorSchema           // { code: string, message: string }
WORKSPACE_FORMAT_VERSION = 1
```

- Produces the IPC contract as one object, `ipcContract`, mapping channel name → `{ request: ZodSchema, response: ZodSchema }`, and `type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError }`:

| Channel | Request | Response |
| --- | --- | --- |
| `workspace:list` | `{}` | `WorkspaceSummary[]` |
| `workspace:current` | `{}` | `WorkspaceSummary \| null` |
| `workspace:create` | `{ name: string (1..200), rootPath: string }` | `WorkspaceSummary` |
| `workspace:open` | `{ rootPath: string }` | `WorkspaceSummary` |
| `workspace:close` | `{}` | `null` |
| `files:import` | `{ sourcePaths: string[] (1..1000) }` | `ImportResult[]` |
| `files:list` | `{ limit: int 1..200, offset: int ≥ 0 }` | `FileList` |
| `dialog:pickDirectory` | `{}` | `string \| null` |
| `dialog:pickFiles` | `{}` | `string[]` |

- [ ] **Step 1: Write failing tests**: a valid manifest parses; a manifest with `formatVersion: 0` or a non-UUID `id` is rejected; `files:list` rejects `limit: 0` and `limit: 201`; `files:import` rejects an empty `sourcePaths`; a `FileRecord` with `status: 'pending'`, `sizeBytes: null`, `sha256: null` parses.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/contracts test` — expected FAIL (module not found).
- [ ] **Step 3: Implement the schemas and `ipcContract`** as listed above.
- [ ] **Step 4: Run the tests** — expected PASS. Run `pnpm typecheck` — expected no errors.
- [ ] **Step 5: Commit** — `feat(contracts): add workspace, file and IPC schemas`

---

### Task 3: Core ports, errors and pure helpers

**Files:**
- Create: `packages/core/package.json`, `tsconfig.json`, `src/index.ts`, `src/ports.ts`, `src/errors.ts`, `src/file-names.ts`, `src/paths.ts`
- Test: `packages/core/test/file-names.test.ts`

**Interfaces:**
- Produces in `src/errors.ts`: `class AssetForgeError extends Error { readonly code: string }` and subclasses with these codes: `WorkspaceNotFoundError` (`workspace_not_found`), `StorageUnreachableError` (`storage_unreachable`), `DirectoryNotEmptyError` (`directory_not_empty`), `UnsupportedFormatVersionError` (`unsupported_format_version`), `WorkspaceMismatchError` (`workspace_mismatch`), `InvalidManifestError` (`invalid_manifest`), `NoWorkspaceOpenError` (`no_workspace_open`), `PathEscapeError` (`path_escape`), `SourceNotReadableError` (`source_not_readable`), `ChecksumMismatchError` (`checksum_mismatch`).
- Produces in `src/paths.ts`: `MANIFEST_PATH = 'workspace.json'`, `INBOX_DIR = 'inbox'`, `STAGING_DIR = '.assetforge/staging'`, `LAYOUT_DIRS = ['assets', 'inbox', 'exports', '.assetforge/staging']`, `stagingPath(fileId: string): string` → `.assetforge/staging/<id>.part`, `inboxPath(fileId: string, originalName: string): string` → `inbox/<id>_<sanitized name>`.
- Produces in `src/file-names.ts`: `sanitizeFileName(name: string): string`, `mimeFromFileName(name: string): string`.
- Produces in `src/ports.ts`:

```ts
import type { Readable } from 'node:stream';
import type { FileRecord, ImportStatus, FileList, WorkspaceSummary } from '@assetforge/contracts';

export interface Storage {
  isReachable(): Promise<boolean>;            // root's parent volume/dir is accessible
  isEmptyOrMissing(): Promise<boolean>;       // root does not exist or has no entries
  ensureLayout(): Promise<void>;              // creates root and LAYOUT_DIRS
  readText(relPath: string): Promise<string | null>;        // null if missing
  writeText(relPath: string, text: string): Promise<void>;  // atomic: temp file + rename
  writeStream(relPath: string, source: Readable): Promise<{ sizeBytes: number; sha256: string }>;
  hashFile(relPath: string): Promise<string>;               // lowercase hex SHA-256
  move(from: string, to: string): Promise<void>;            // rejects if `to` exists
  exists(relPath: string): Promise<boolean>;
  remove(relPath: string): Promise<void>;                   // no-op if missing
  list(relDir: string): Promise<string[]>;                  // entry names; [] if dir missing
}

export interface SourceFiles {
  open(absolutePath: string): Promise<{ name: string; stream: Readable }>; // rejects with SourceNotReadableError
}

export interface FileRepository {
  insertPending(r: { id: string; originalName: string; relativePath: string; mimeType: string; importedAt: string }): Promise<void>;
  markComplete(id: string, r: { sizeBytes: number; sha256: string }): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  findCompleteBySha256(sha256: string): Promise<FileRecord[]>;
  listByStatus(status: ImportStatus): Promise<FileRecord[]>;
  list(q: { limit: number; offset: number }): Promise<FileList>;   // newest importedAt first
}

export interface WorkspaceMeta { id: string; formatVersion: number; name: string; createdAt: string }
export interface WorkspaceMetaRepository {
  get(): Promise<WorkspaceMeta | null>;
  init(meta: WorkspaceMeta): Promise<void>;
}

export interface WorkspaceDatabase {
  meta: WorkspaceMetaRepository;
  files: FileRepository;
  close(): Promise<void>;
}

export interface WorkspaceRegistry {
  list(): Promise<WorkspaceSummary[]>;
  get(id: string): Promise<WorkspaceSummary | null>;
  upsert(entry: WorkspaceSummary): Promise<void>;   // keyed by id
}

export interface WorkspaceHost {
  registry: WorkspaceRegistry;
  sources: SourceFiles;
  createStorage(rootPath: string): Storage;
  openDatabase(workspaceId: string): Promise<WorkspaceDatabase>;  // creates the file and applies migrations
  newId(): string;
  now(): Date;
}
```

- [ ] **Step 1: Write failing tests** for the helpers:

```ts
expect(sanitizeFileName('Gabriella front.png')).toBe('Gabriella_front.png');
expect(sanitizeFileName('..\\..\\evil/../x.png')).toBe('x.png');   // base name only
expect(sanitizeFileName('..hidden')).toBe('hidden');               // no leading dots
expect(sanitizeFileName('Größe über alles.JPG')).toBe('Gr_e_ber_alles.JPG');
expect(sanitizeFileName('')).toBe('file');
expect(sanitizeFileName('a'.repeat(300) + '.png')).toHaveLength(100);
expect(sanitizeFileName('a'.repeat(300) + '.png').endsWith('.png')).toBe(true);
expect(sanitizeFileName('CON')).toBe('CON');                 // safe: always prefixed with a UUID
expect(mimeFromFileName('a.PNG')).toBe('image/png');
expect(mimeFromFileName('scene.blend')).toBe('application/x-blender');
expect(mimeFromFileName('model.glb')).toBe('model/gltf-binary');
expect(mimeFromFileName('noext')).toBe('application/octet-stream');
expect(inboxPath('1b4e28ba-2fa1-41d2-883f-0016d3cca427', 'a b.png'))
  .toBe('inbox/1b4e28ba-2fa1-41d2-883f-0016d3cca427_a_b.png');
```

Sanitizing rule: take the base name after the last `/` or `\`; replace every run of characters outside `[A-Za-z0-9._-]` with one `_`; strip leading `.` and `_`; truncate to 100 characters keeping the extension (extension = last `.` segment, at most 10 characters); empty result → `file`.

MIME table: png, jpg/jpeg, webp, tif/tiff, exr (`image/x-exr`), gif, blend, glb, gltf (`model/gltf+json`), fbx (`application/octet-stream`), obj (`model/obj`), pdf, txt, md (`text/markdown`), json.

- [ ] **Step 2: Run** `pnpm --filter @assetforge/core test` — expected FAIL.
- [ ] **Step 3: Implement** `errors.ts`, `paths.ts`, `file-names.ts`, `ports.ts` and export everything from `index.ts`.
- [ ] **Step 4: Run tests and `pnpm typecheck`** — expected PASS.
- [ ] **Step 5: Commit** — `feat(core): add ports, errors and file name helpers`

---

### Task 4: Local file system storage

**Files:**
- Create: `packages/storage/package.json`, `tsconfig.json`, `src/index.ts`, `src/local-storage.ts`, `src/node-source-files.ts`
- Test: `packages/storage/test/local-storage.test.ts`, `packages/storage/test/node-source-files.test.ts`

**Interfaces:**
- Consumes: `Storage`, `SourceFiles`, `PathEscapeError`, `SourceNotReadableError`, `LAYOUT_DIRS` from `@assetforge/core`.
- Produces: `class LocalFileSystemStorage implements Storage { constructor(rootPath: string) }` and `class NodeSourceFiles implements SourceFiles`.

Every method resolves its relative path through one private `resolve(relPath)` that rejects with `PathEscapeError` when the path is absolute, contains a `..` segment, or — after `fs.realpath` of the deepest existing ancestor — lies outside the real root (this covers symlinks and Windows junctions). `writeStream` uses `stream.pipeline` with a hashing pass-through, opens the target with flag `wx`, and removes the partial file on failure. `move` uses `fs.rename` after checking that the target does not exist.

- [ ] **Step 1: Write failing tests** against a fresh `fs.mkdtemp` directory per test:
  - `ensureLayout` creates `assets`, `inbox`, `exports`, `.assetforge/staging`; `isEmptyOrMissing` is `true` before and `false` after.
  - `writeStream` of `Readable.from(Buffer.from('hello'))` returns `{ sizeBytes: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }`, and `hashFile` of the same path returns the same hash.
  - `writeStream` to an existing path rejects and leaves the existing content unchanged.
  - A source stream that errors midway rejects and leaves no file behind (`exists` is `false`).
  - `move` to an existing target rejects; both files keep their content.
  - `readText` of a missing file is `null`; `writeText` then `readText` round-trips; no `*.tmp` file remains in the directory.
  - `remove` of a missing file resolves; `list` of a missing directory is `[]`.
  - `PathEscapeError` for `'../x'`, `'inbox/../../x'`, an absolute path, and a path through a directory junction/symlink inside the root that points outside it (create with `fs.symlink(outside, link, 'junction')`).
  - `isReachable` is `false` for a root on a non-existent drive/parent (`path.join(tmp, 'missing-parent', 'ws')` with the parent absent).
  - `NodeSourceFiles.open` returns the base name and a readable stream for a file; rejects with `SourceNotReadableError` for a directory and for a missing path.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/storage test` — expected FAIL.
- [ ] **Step 3: Implement** both classes.
- [ ] **Step 4: Run tests and `pnpm typecheck`** — expected PASS.
- [ ] **Step 5: Commit** — `feat(storage): add local file system storage with path-escape checks`

---

### Task 5: SQLite persistence and migrations

**Files:**
- Create: `packages/persistence/src/index.ts`, `src/schema.ts`, `src/open-database.ts`, `src/file-repository.ts`, `src/meta-repository.ts`, `drizzle.config.ts`, `migrations/` (generated)
- Test: `packages/persistence/test/database.test.ts`

**Interfaces:**
- Consumes: `WorkspaceDatabase`, `FileRepository`, `WorkspaceMetaRepository` from `@assetforge/core`.
- Produces: `openWorkspaceDatabase(dbFilePath: string, migrationsFolder: string): Promise<WorkspaceDatabase>` and `MIGRATIONS_FOLDER: string` (absolute path of the package's `migrations/` directory, derived from `import.meta.url`).

Schema (snake_case columns, Drizzle camelCase fields):

| Table | Columns |
| --- | --- |
| `workspace` | `id` text PK, `format_version` integer not null, `name` text not null, `created_at` text not null |
| `file` | `id` text PK, `asset_id` text null, `original_name` text not null, `relative_path` text not null unique, `mime_type` text not null, `size_bytes` integer null, `sha256` text null, `status` text not null check in (`pending`,`complete`,`failed`), `error` text null, `imported_at` text not null |

Indexes: `file(sha256)`, `file(status)`, `file(imported_at)`, `file(asset_id)`. `openWorkspaceDatabase` creates the parent directory, sets `journal_mode = WAL` and `foreign_keys = ON`, then runs Drizzle's `migrate`. The migration is generated with `drizzle-kit generate` (script `db:generate`) and committed.

- [ ] **Step 1: Write failing tests** (each on a temp-dir database file):
  - Opening a new path creates the file, and `meta.get()` is `null`; after `meta.init(m)`, `meta.get()` equals `m`.
  - Opening the same file twice in sequence (open, close, open) applies migrations idempotently and keeps the data.
  - `insertPending` then `list({limit: 10, offset: 0})` returns one item with `status: 'pending'`, `sizeBytes: null`, `sha256: null`, `assetId: null`, `error: null` and `total: 1`.
  - `markComplete` sets size, hash and `status: 'complete'`; `markFailed` sets `status: 'failed'` and the error text.
  - `findCompleteBySha256` returns only `complete` rows with that hash.
  - `listByStatus('pending')` returns only pending rows.
  - `list` orders by `importedAt` descending and honours `limit`/`offset` while `total` stays the full count (insert 3, request `limit: 2, offset: 1` → 2 items, `total: 3`).
  - Inserting two rows with the same `relativePath` rejects.
  - Returned records satisfy `FileRecordSchema.parse`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/persistence test` — expected FAIL.
- [ ] **Step 3: Implement** schema, generate the migration, implement the repositories and `openWorkspaceDatabase`.
- [ ] **Step 4: Run tests and `pnpm typecheck`** — expected PASS (including the Task 1 test).
- [ ] **Step 5: Commit** — `feat(persistence): add SQLite schema, migrations and repositories`

---

### Task 6: Workspace lifecycle use cases

**Files:**
- Create: `packages/core/src/workspace-manager.ts`
- Create: `packages/core/test/fakes.ts`
- Test: `packages/core/test/workspace-lifecycle.test.ts`

**Interfaces:**
- Consumes: everything from Task 3; `WorkspaceManifestSchema`, `WORKSPACE_FORMAT_VERSION` from contracts.
- Produces:

```ts
export class WorkspaceManager {
  constructor(host: WorkspaceHost);
  list(): Promise<WorkspaceSummary[]>;
  current(): WorkspaceSummary | null;
  create(input: { name: string; rootPath: string }): Promise<WorkspaceSummary>;  // creates, then opens
  open(input: { rootPath: string }): Promise<WorkspaceSummary>;
  close(): Promise<void>;                                   // no-op if nothing is open
  importFiles(sourcePaths: string[]): Promise<ImportResult[]>;   // Task 7
  listFiles(q: { limit: number; offset: number }): Promise<FileList>;  // Task 7
}
```

- Produces in `test/fakes.ts` (reused by Task 7): `InMemoryStorage implements Storage` (a `Map<string, Buffer>`, with `reachable: boolean` and `failNext(method: keyof Storage, error: Error): void` for fault injection), `InMemoryDatabase implements WorkspaceDatabase`, `InMemoryRegistry`, `FakeSourceFiles` (a `Map<absolutePath, Buffer>`), and `createFakeHost(): { host: WorkspaceHost; storages: Map<string, InMemoryStorage>; databases: Map<string, InMemoryDatabase>; sources: FakeSourceFiles }`. `createStorage(rootPath)` returns the same `InMemoryStorage` for the same root; `openDatabase(id)` returns the same database for the same ID (so close/reopen keeps data).

Behaviour:
- `create`: `StorageUnreachableError` if not reachable; `DirectoryNotEmptyError` unless `isEmptyOrMissing()`; `ensureLayout()`; write the manifest (`newId()`, `WORKSPACE_FORMAT_VERSION`, name, `now()`) as pretty-printed JSON to `workspace.json`; then run `open`.
- `open`: closes the current workspace first. `StorageUnreachableError` if not reachable; `WorkspaceNotFoundError` if `workspace.json` is missing; `InvalidManifestError` if it does not parse; `UnsupportedFormatVersionError` if `formatVersion > WORKSPACE_FORMAT_VERSION`. Opens the database for the manifest ID; if `meta.get()` is `null` → `meta.init(manifest)`; if its `id` differs → close the database and throw `WorkspaceMismatchError`. Calls `ensureLayout()`, runs import recovery (Task 7; a no-op hook in this task), upserts the registry entry with the given `rootPath` and `lastOpenedAt = now()`.
- `close`: closes the database and clears the current workspace.
- `importFiles` / `listFiles` throw `NoWorkspaceOpenError` when nothing is open.

- [ ] **Step 1: Write failing tests**:
  - `create` writes a manifest that passes `WorkspaceManifestSchema`, creates the layout dirs, sets `current()`, and adds one registry entry.
  - `create` on a root that already contains an entry → `DirectoryNotEmptyError`, nothing written.
  - `create` → `close` → `open` with the same root returns the same `id` and `name`; `current()` is `null` between close and open.
  - `open` on a root without manifest → `WorkspaceNotFoundError`.
  - `open` with `storage.reachable = false` → `StorageUnreachableError`, and the registry entry from the earlier `create` is still listed. *(Review Focus 4)*
  - `open` with manifest `formatVersion: 2` → `UnsupportedFormatVersionError`; with invalid JSON → `InvalidManifestError`.
  - Moved workspace: copy the storage contents of root A to root B in the fake, `open({rootPath: B})` → same `id`, registry has exactly one entry for that id with `rootPath` B. *(Review Focus 5)*
  - Mismatch: pre-initialise the database returned for the manifest's ID with a different `meta.id` → `WorkspaceMismatchError`, `current()` stays `null`. *(Review Focus 5)*
  - `open` while another workspace is open closes the first database (fake records `closed === true`).
  - `listFiles` without an open workspace → `NoWorkspaceOpenError`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/core test` — expected FAIL.
- [ ] **Step 3: Implement** `fakes.ts` and `WorkspaceManager` (lifecycle part).
- [ ] **Step 4: Run tests and `pnpm typecheck`** — expected PASS.
- [ ] **Step 5: Commit** — `feat(core): add workspace create/open/close`

---

### Task 7: File import and recovery

**Files:**
- Create: `packages/core/src/import-file.ts`, `packages/core/src/recover-imports.ts`
- Modify: `packages/core/src/workspace-manager.ts` (wire `importFiles`, `listFiles`, recovery in `open`)
- Test: `packages/core/test/import.test.ts`, `packages/core/test/recovery.test.ts`

**Interfaces:**
- Consumes: Task 3 ports and helpers, Task 6 fakes and `WorkspaceManager`.
- Produces:

```ts
export interface ImportContext { storage: Storage; files: FileRepository; sources: SourceFiles; newId(): string; now(): Date }
export function importFile(ctx: ImportContext, sourcePath: string): Promise<ImportResult>;   // never rejects for per-file failures
export function recoverIncompleteImports(ctx: Pick<ImportContext, 'storage' | 'files'>): Promise<{ failedIds: string[]; removedStagingFiles: string[] }>;
```

`importFile` sequence — the order is the crash-safety contract:
1. `sources.open(sourcePath)`. On failure return `{ sourcePath, file: null, error, duplicateOf: [] }` without creating a row.
2. `id = newId()`; `files.insertPending({ id, originalName: name, relativePath: inboxPath(id, name), mimeType: mimeFromFileName(name), importedAt })`.
3. `storage.writeStream(stagingPath(id), stream)` → `{ sizeBytes, sha256 }`.
4. `storage.hashFile(stagingPath(id))`; if it differs from step 3 → `ChecksumMismatchError`.
5. `duplicateOf` = ids from `files.findCompleteBySha256(sha256)`.
6. `storage.move(stagingPath(id), inboxPath(id, name))`.
7. `files.markComplete(id, { sizeBytes, sha256 })`.

Any failure in steps 3–7: `storage.remove` the staging path and the final path (ignore removal errors), `files.markFailed(id, message)`, and return the result with the failed record and `error` set. `WorkspaceManager.importFiles` processes paths sequentially and returns one result per input path in input order.

`recoverIncompleteImports`: for every `pending` row remove its staging file and its `relativePath` file, then `markFailed(id, 'Import was interrupted')`; afterwards remove every remaining entry in `STAGING_DIR`. Complete rows and their files are never touched.

- [ ] **Step 1: Write failing tests** (`import.test.ts`):
  - Happy path: one source `ref.png` with bytes `hello` → result `file.status === 'complete'`, `sizeBytes: 5`, the SHA-256 from Task 4, `relativePath` `inbox/<id>_ref.png`, `mimeType: 'image/png'`, `originalName: 'ref.png'`, `duplicateOf: []`; storage holds the bytes at that path; staging dir is empty; the source map entry is unchanged.
  - Same source imported twice → two complete records with different ids and paths; the second result's `duplicateOf` is `[firstId]`. *(Review Focus 2)*
  - Two different sources both named `a.png` in different folders → two complete records, both files present. *(Review Focus 2)*
  - Batch `[missing, directory-like unreadable, valid]` → results in input order; first two have `file: null` and a non-empty `error`; third is complete; `listFiles` total is `1`. *(Review Focus 1)*
  - Source named `..\\..\\Größe über alles.JPG` → `relativePath` starts with `inbox/` and contains no `..`; `originalName` is the base name as returned by the source. *(Review Focus 3)*
  - `storage.failNext('writeStream', …)` → record `failed` with the error text, staging empty, no inbox file. *(Review Focus 1)*
  - `storage.hashOverride = '0'.repeat(64)` (a public field on `InMemoryStorage` that `hashFile` returns when set) → record `failed` with the `ChecksumMismatchError` message, no inbox file.
  - `storage.failNext('move', …)` → record `failed`, staging empty, no inbox file.
  - Zero-byte source → complete with `sizeBytes: 0` and SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- [ ] **Step 2: Write failing tests** (`recovery.test.ts`):
  - A pending row with a staging file and no inbox file → row `failed` with `'Import was interrupted'`, staging file removed.
  - A pending row whose file was already moved to `inbox/` (crash between steps 6 and 7) → row `failed`, inbox file removed.
  - An orphan staging file without a row → removed.
  - A complete row and its inbox file → untouched.
  - Via `WorkspaceManager`: simulate a crash by inserting a pending row and a staging file directly into the fakes, `close`, `open` → `listFiles` shows that record as `failed` and staging is empty.
- [ ] **Step 3: Run** `pnpm --filter @assetforge/core test` — expected FAIL.
- [ ] **Step 4: Implement** `importFile`, `recoverIncompleteImports` and the wiring in `WorkspaceManager`.
- [ ] **Step 5: Run tests and `pnpm typecheck`** — expected PASS.
- [ ] **Step 6: Commit** — `feat(core): add staged file import and startup recovery`

---

### Task 8: Desktop composition and acceptance test

Wires the real adapters together without any Electron import, so the phase's acceptance criterion is tested end to end on the real file system and a real SQLite file.

**Files:**
- Create: `apps/desktop/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `apps/desktop/src/main/composition.ts`, `apps/desktop/src/main/json-registry.ts`
- Test: `apps/desktop/test/json-registry.test.ts`, `apps/desktop/test/acceptance.test.ts`

**Interfaces:**
- Consumes: `WorkspaceManager`, `WorkspaceHost`, `WorkspaceRegistry` (core); `LocalFileSystemStorage`, `NodeSourceFiles` (storage); `openWorkspaceDatabase`, `MIGRATIONS_FOLDER` (persistence).
- Produces: `class JsonWorkspaceRegistry implements WorkspaceRegistry { constructor(settingsFilePath: string) }` storing `{ "workspaces": WorkspaceSummary[] }`, written atomically (temp file + rename); a missing or unparsable file reads as an empty list (an unparsable file is first renamed to `settings.json.corrupt-<timestamp>`).
- Produces: `createWorkspaceManager(opts: { userDataPath: string; migrationsFolder?: string }): WorkspaceManager`. Layout under `userDataPath`: `settings.json`, `workspaces/<workspace-uuid>/assetforge.sqlite`.
- The desktop test script runs under Electron's Node, like persistence (Task 1).

- [ ] **Step 1: Write failing tests** (`json-registry.test.ts`): `list()` on a missing file is `[]`; `upsert` twice with the same id keeps one entry with the later values; data survives a new instance on the same file; a file containing `not json` yields `[]` and leaves a `settings.json.corrupt-*` file next to it.
- [ ] **Step 2: Write the failing acceptance test** (`acceptance.test.ts`), using two temp dirs (`userData`, `workspaceRoot`) and two source files written to a third temp dir (`a.png` = bytes `hello`, `scene.blend` = 1 MiB of random bytes):

```ts
const first = createWorkspaceManager({ userDataPath });
const ws = await first.create({ name: 'Gilded Hour', rootPath: workspaceRoot });
const results = await first.importFiles([pngPath, blendPath]);
expect(results.map((r) => r.file?.status)).toEqual(['complete', 'complete']);
await first.close();

const second = createWorkspaceManager({ userDataPath });        // simulates an app restart
expect(await second.list()).toMatchObject([{ id: ws.id, name: 'Gilded Hour', rootPath: workspaceRoot }]);
const reopened = await second.open({ rootPath: workspaceRoot });
expect(reopened.id).toBe(ws.id);
const { items, total } = await second.listFiles({ limit: 50, offset: 0 });
expect(total).toBe(2);
for (const item of items) {
  const onDisk = await readFile(join(workspaceRoot, item.relativePath));
  expect(createHash('sha256').update(onDisk).digest('hex')).toBe(item.sha256);
  expect(isAbsolute(item.relativePath)).toBe(false);
}
expect(await readFile(pngPath, 'utf8')).toBe('hello');           // source untouched
expect(existsSync(join(workspaceRoot, 'assetforge.sqlite'))).toBe(false);
expect(existsSync(join(userDataPath, 'workspaces', ws.id, 'assetforge.sqlite'))).toBe(true);
expect(await readdir(join(workspaceRoot, '.assetforge', 'staging'))).toEqual([]);
await second.close();
```

  Plus: moving the workspace directory with `fs.rename` to a new path and opening it there returns the same id and both file records, and `list()` shows one entry with the new root. *(Review Focus 5)*
  Plus: deleting `userData/workspaces/<id>` and opening again succeeds with `total: 0` (a fresh database is initialised from the manifest; re-indexing existing files is not part of phase 1).
- [ ] **Step 3: Run** `pnpm --filter @assetforge/desktop test` — expected FAIL.
- [ ] **Step 4: Implement** `JsonWorkspaceRegistry` and `createWorkspaceManager`.
- [ ] **Step 5: Run** `pnpm test` (all packages) and `pnpm typecheck` — expected PASS.
- [ ] **Step 6: Commit** — `feat(desktop): compose workspace manager and add acceptance test`

---

### Task 9: Electron shell with typed IPC

**Files:**
- Create: `apps/desktop/electron.vite.config.ts`, `apps/desktop/src/main/index.ts`, `src/main/ipc.ts`, `src/main/window.ts`
- Create: `apps/desktop/src/preload/index.ts`, `apps/desktop/src/preload/api.d.ts`
- Create: `apps/desktop/src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx` (placeholder showing the result of `workspace:list`)
- Modify: `apps/desktop/package.json` (scripts `dev`, `build`), root `package.json` (`dev` → `pnpm --filter @assetforge/desktop dev`)
- Test: `apps/desktop/test/ipc.test.ts`

**Interfaces:**
- Consumes: `ipcContract`, `IpcResult` (contracts); `createWorkspaceManager` (Task 8); `AssetForgeError` (core).
- Produces in `src/main/ipc.ts` (no Electron import, so it is unit-testable):

```ts
export type IpcHandlers = { [C in keyof typeof ipcContract]: (request: z.infer<(typeof ipcContract)[C]['request']>) => Promise<z.infer<(typeof ipcContract)[C]['response']>> };
export function createWorkspaceHandlers(manager: WorkspaceManager, dialogs: { pickDirectory(): Promise<string | null>; pickFiles(): Promise<string[]> }): IpcHandlers;
export function dispatch(handlers: IpcHandlers, channel: string, rawRequest: unknown): Promise<IpcResult<unknown>>;
```

  `dispatch` returns `{ ok: false, error: { code: 'unknown_channel' } }` for an unknown channel, `{ code: 'invalid_request' }` when the request fails its Zod schema, `{ code: err.code }` for an `AssetForgeError`, and `{ code: 'internal_error', message: 'Unexpected error' }` for anything else (the original error is logged in main, not sent to the renderer).
- Produces in preload: `window.assetForge.invoke<C extends keyof typeof ipcContract>(channel: C, request): Promise<IpcResult<Response<C>>>`, exposed with `contextBridge`, typed through `api.d.ts`.

Electron main requirements:
- `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`; deny `setWindowOpenHandler`; block navigation away from the app origin (`will-navigate`).
- One `ipcMain.handle` per contract channel; reject calls whose `event.senderFrame` is not the main window's top frame.
- `app.requestSingleInstanceLock()`; a second instance focuses the existing window and quits (enforces one writing client per machine).
- `userDataPath` from `app.getPath('userData')`; never hard-coded.
- On `before-quit`: `manager.close()` before exit.
- In `electron.vite.config.ts`: `better-sqlite3` stays external; the `@assetforge/*` workspace packages are bundled (excluded from dependency externalization). The migrations folder is passed explicitly: in dev, resolved from the persistence package directory.
- Renderer CSP meta tag: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`.

- [ ] **Step 1: Write failing tests** (`ipc.test.ts`, using a `WorkspaceManager` built on the Task 6 fakes or on temp dirs via `createWorkspaceManager`): unknown channel → `unknown_channel`; `files:list` with `{ limit: 0, offset: 0 }` → `invalid_request`; `files:list` with no open workspace → `no_workspace_open`; `workspace:create` then `files:list` → `{ ok: true, value: { items: [], total: 0 } }`; a handler that throws a plain `Error('secret path C:\\x')` → `internal_error` whose message does not contain `secret`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test` — expected FAIL.
- [ ] **Step 3: Implement** `ipc.ts`, then the Electron main, preload and placeholder renderer.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — expected PASS.
- [ ] **Step 5: Verify the shell manually**: run `pnpm dev`. Expected: one window opens, the placeholder shows an empty workspace list, the DevTools console shows no CSP or preload errors, and `typeof window.require` evaluated in the console is `'undefined'`.
- [ ] **Step 6: Commit** — `feat(desktop): add Electron shell with validated IPC`

---

### Task 10: Minimal UI and end-to-end check

**Files:**
- Create: `apps/desktop/src/renderer/src/api.ts`, `src/renderer/src/screens/WorkspaceScreen.tsx`, `src/renderer/src/screens/FilesScreen.tsx`, `src/renderer/src/format.ts`, `src/renderer/src/index.css`
- Modify: `apps/desktop/src/renderer/src/App.tsx`, `apps/desktop/electron.vite.config.ts` (Tailwind v4 Vite plugin for the renderer)
- Modify: `CLAUDE.md` (replace "planned" commands with the real ones), `ReadMe.md` §14.2 note (commands that now work)
- Test: `apps/desktop/test/format.test.ts`

**Interfaces:**
- Consumes: `window.assetForge.invoke` (Task 9), DTO types from contracts.
- Produces: `api.ts` with `call<C>(channel: C, request): Promise<Response<C>>` that unwraps `IpcResult` and throws `ApiError { code, message }`; `format.ts` with `formatBytes(n: number | null): string` and `formatDateTime(iso: string): string`.

Screens (plain Tailwind, no component library yet):
- **WorkspaceScreen** (shown when `workspace:current` is `null`): list of known workspaces from `workspace:list` (name, root path, last opened), each with an "Open" button; "Create workspace" (name field + "Choose folder" via `dialog:pickDirectory`); "Open existing folder". Errors are shown inline with a message per code: `directory_not_empty` → "The folder is not empty. Choose an empty folder for a new workspace."; `workspace_not_found` → "No workspace was found in this folder."; `storage_unreachable` → "The folder cannot be reached. Check that the drive or network share is available."; `unsupported_format_version` → "This workspace was created by a newer version of AssetForge."; `workspace_mismatch` → "The local database does not belong to this workspace."; anything else → the error message.
- **FilesScreen** (shown when a workspace is open): header with workspace name, root path and "Close workspace"; "Import files" (`dialog:pickFiles` → `files:import`), disabled with a progress label while an import runs; after an import a summary line "N imported, M failed, K duplicates" plus the per-file errors; a table of `files:list` (original name, MIME type, size, status, imported at), 50 per page with previous/next.

- [ ] **Step 1: Write failing tests** for `format.ts`: `formatBytes(null)` → `'–'`, `0` → `'0 B'`, `1023` → `'1023 B'`, `1024` → `'1.0 KiB'`, `1572864` → `'1.5 MiB'`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test` — expected FAIL.
- [ ] **Step 3: Implement** `format.ts`, `api.ts`, both screens and the `App.tsx` switch between them.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — expected PASS.
- [ ] **Step 5: End-to-end check in the running app** (`pnpm dev`), with a new empty folder:
  1. Create a workspace → the files screen appears with an empty table; the folder contains `workspace.json`, `assets/`, `inbox/`, `exports/`, `.assetforge/staging/`.
  2. Import three files including one `.blend` and one image → three rows with status `complete`; the files exist under `inbox/` and the originals are unchanged.
  3. Import one of them again → summary reports 1 duplicate; four rows.
  4. Close the workspace, quit the app, start it again → the workspace is listed; opening it shows the same four rows.
  5. Try to create a workspace in the now non-empty folder → the `directory_not_empty` message.
  6. Start a second instance → the first window is focused, no second window.
- [ ] **Step 6: Update `CLAUDE.md` and the ReadMe note** with the working commands: `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm typecheck`, single test `pnpm --filter @assetforge/<package> test -- <file> -t "<name>"`, and `pnpm --filter @assetforge/persistence db:generate`. Note that persistence and desktop tests run under Electron's Node.
- [ ] **Step 7: Commit** — `feat(desktop): add workspace and file import UI`
