# Phase 2a – Asset Management: Design

Phase 2 of `ReadMe.md` §17 ("Projects, types, roles, asset relations, workflows") is built as two consecutive projects. **2a** (this document) delivers projects, assets, asset types, project assignments, file roles with managed asset directories, and asset relations. **2b** (`2026-11-25-phase-2b-workflows-design.md`) adds workflows on top and is built directly afterwards.

## Intent

After phase 1 the application can only import files into an inbox. Phase 2a makes the **asset** the central object: a domain object with a stable ID that owns files, can be used in any number of projects, and relates to other assets. It also closes the two items that the phase 1 review marked as required for phase 2: the storage reference in the schema and the mapping of destination errors during streaming.

## Acceptance criterion (ReadMe §17, part covered by 2a)

Use one asset in several projects; remove assignments without losing files; see and change the asset status. (Tracing production progress through workflow steps is 2b.)

## Goals

- **Storage reference.** A `storage` table; every file row holds a `storage_id` next to its relative path. Existing phase 1 databases are migrated with a backfill; no absolute path enters the database.
- **Asset types.** The eight types from ReadMe §3.2 (Character, Creature, Landscape, Building, Vehicle, Prop, Material, Other) stored as rows, seeded by the application when a workspace is opened.
- **Assets.** Create, edit (name, description, type, status), list with paging and filters (type, status, project, name contains). Status is one of `draft`, `in_progress`, `in_review`, `completed`, `archived`.
- **Projects.** Create, edit (name, description, status), list with paging.
- **Project assignments (n:m).** Assign an asset to a project, edit the project-specific data on the assignment (priority, intended use, approval status, notes), remove the assignment. Removing never touches the asset or its files.
- **Files and roles.** A complete inbox file can be assigned to an asset with a role (`reference`, `concept`, `generated`, `working`, `model`, `texture`, `final`, `other`). The file is then moved, as a controlled and crash-safe operation, to `assets/<asset-uuid>/<role directory>/<file-uuid>_<name>`. A role change or a detach (back to the inbox) uses the same operation. Files can also be imported directly into an asset.
- **Asset relations.** Typed, directed relations between two assets: `uses`, `variant_of`, `part_of`, `derived_from`; add, remove, list in both directions.
- **UI.** Navigation between Assets, Projects and Inbox inside an open workspace; list and detail screens for assets and projects.
- **Carried-over backlog** (items that touch the code this phase changes anyway): destination errors mid-stream are reported as `storage_full` / `storage_access_denied`; lifecycle operations and mutating use cases run one at a time; repository hardening (`markComplete`/`markFailed` detect unknown ids, explicit column mapping, page and count read in one transaction, single-row guard for the workspace row); a typed error-code union in `contracts` with integer constraints on counts and sizes; lists in the renderer show a failed load instead of "Loading…" forever and ignore stale responses.

## Non-goals

- Workflows, workflow templates, step states, progress (phase 2b).
- An editor for asset types, type-specific metadata fields, custom metadata (ReadMe §18, still open).
- Cover or preview images for assets and projects, thumbnails, gallery, tags, full-text search (phase 3). Filtering by name is a plain substring match.
- Deleting assets, projects or files, and a trash (phase 6). An asset or project is retired by setting its status to `archived`.
- File versions, lineage, external-change detection for working files, "open in external application" (phases 3 and 6).
- Activity history (`ActivityEvent`). Status changes are visible through the current value and `updated_at` only.
- Additional storages (NAS as a second storage, object storage). The schema is ready for them; only the workspace root exists.
- The remaining backlog items (`docs/phase-2-backlog.md` is rewritten at the end of 2a to list what is left).

## Anti-goals

- Removing a project assignment, a relation or a role deleting or moving an asset's files, or deleting the asset.
- A file whose database row and location on disk disagree after a crash without the next open repairing it.
- An imported file being overwritten by a move; a move leaving the workspace.
- Project-specific data (priority, approval, notes) written to the asset.
- Asset type, file type and file role being coupled (for example a role being allowed only for some MIME types).
- Explanatory sentences in the layout, or buttons that look different from each other.

## Constraints

- All constraints of phase 1 still hold: layering, no absolute paths in the database, UUID v4 identifiers, ISO 8601 UTC timestamps, async ports, short transactions with file operations outside them.
- Schema changes are one Drizzle migration (`0001`) that must upgrade a phase 1 database with existing file rows.
- UI rules from the product owner: no explanatory text in the layout (tooltips where needed), one button style (`BUTTON` in `ui.ts`).
- Everything in the repository is English.

## Approaches

**Splitting phase 2**

1. **2a (assets, projects, files) then 2b (workflows) — chosen.** Each half ends with a working, checkable application; workflows depend on assets and types but not the other way round.
2. One plan for all of phase 2. Rejected: around twenty tasks in one run, with the first end-to-end check only at the very end.

**Keeping file moves consistent**

1. **Journal table `file_move` — chosen.** Intent row → move on disk → one transaction that applies the new placement and deletes the intent. On open, an intent whose target exists is completed, any other is discarded. Mirrors the import protocol and keeps `file` free of half-states.
2. Extra "pending placement" columns on `file`. Rejected: three nullable columns on every row for a rare state, and every reader has to know about them.
3. Keep files where they are and treat directories as cosmetic. Rejected: ReadMe §9.2 defines the per-asset layout, and backups and external tools (Blender) rely on it.

**Asset types and other fixed vocabularies**

1. **Types as rows, seeded by the application — chosen.** The built-in list lives in `core`; opening a workspace inserts missing built-in types. Rows have UUIDs like every other entity, so a later editor only adds rows.
2. A TypeScript enum without a table. Rejected: makes "configurable" a schema change later.
3. An editor now. Rejected: the UI for it is an open decision (§18).

File roles, statuses, relation kinds, priorities and approval states are closed sets validated in `contracts` and by `CHECK` constraints; extending one is a small migration.

## Design

**Data model (migration `0001`).**

| Table | Columns |
| --- | --- |
| `storage` | `id`, `kind` (`workspace_root`), `created_at` |
| `asset_type` | `id`, `key` (unique), `name`, `sort_order`, `built_in` |
| `asset` | `id`, `name`, `type_id` → `asset_type`, `description`, `status`, `created_at`, `updated_at` |
| `project` | `id`, `name`, `description`, `status`, `created_at`, `updated_at` |
| `project_asset` | `project_id` → `project`, `asset_id` → `asset` (composite primary key), `priority`, `intended_use`, `approval_status`, `notes`, `assigned_at`, `updated_at` |
| `asset_relation` | `from_asset_id`, `to_asset_id` → `asset`, `kind` (composite primary key of all three), `created_at`; `from_asset_id <> to_asset_id` |
| `file` (changed) | adds `storage_id` → `storage` (not null) and `role` (nullable); `asset_id` becomes a foreign key → `asset`; `role` is set exactly when `asset_id` is set; uniqueness is on (`storage_id`, `relative_path`) |
| `file_move` | `file_id` → `file` (primary key), `target_relative_path`, `target_asset_id`, `target_role`, `created_at` |

Indexes: `asset(type_id)`, `asset(status)`, `project_asset(asset_id)`, `asset_relation(to_asset_id)`, `file(asset_id, role)`. Foreign keys do not cascade; nothing is deleted in this phase.

**Storage reference.** A workspace has one primary storage, the workspace root. Its row carries no path: the root path stays in the host-local registry, so a moved workspace keeps working. The migration creates the row for an existing database and backfills `file.storage_id`; a fresh database gets the row when the workspace is first opened. Every new file row is written with the primary storage ID.

**Vocabularies.** Project status: `active`, `on_hold`, `completed`, `archived`. Assignment priority: `low`, `normal`, `high` (default `normal`). Approval status: `pending`, `approved`, `rejected` (default `pending`). Role directories: `reference` and `concept` → `references`, `generated` → `generations`, `model` and `working` → `models`, `texture` → `textures`, `final` and `other` → `miscellaneous`.

**File placement.** `relocateFile(file, target)` with `target` = `{ assetId, role }` or `null` (inbox). Only `complete` files can be relocated. If the computed path equals the current one (role change inside one directory), only the row is updated. Otherwise: insert the `file_move` row → `Storage.move` (rejects if the target exists) → one transaction that sets `relative_path`, `asset_id`, `role` and deletes the `file_move` row. If the move fails, the intent row is deleted and the error is reported. On open, after import recovery: for each `file_move` row, target exists → complete it; otherwise discard it.

**Core.** `WorkspaceManager` keeps the lifecycle and gains two entry points for everything else: `read(fn)` and `exclusive(fn)`, both handing a `WorkspaceSession` (storage, primary storage ID, database, clock, ID source) to a use-case function. `exclusive` and the lifecycle methods share one queue, so a close can never interleave with an import or a move. Use cases are plain functions in `core` (`projects.ts`, `assets.ts`, `assignments.ts`, `relations.ts`, `asset-files.ts`), each checking existence first and failing with `not_found` or `invalid_operation`.

**IPC.** New channels `assetTypes:list`, `projects:*`, `assets:*`, `assignments:*`, `relations:*`, `files:assign`, `files:unassign`; `files:list` takes a scope (all, inbox, one asset) and `files:import` an optional target. All lists are paged (`limit` ≤ 200). Error codes are a closed union in `contracts`.

**UI.** With a workspace open, a header shows the workspace name, the navigation (Assets, Projects, Inbox) and "Close workspace". *Assets*: filterable, paged table (name, type, status, number of projects and files) and a create form (name, type). *Asset detail*: fields; projects it is assigned to with the per-assignment fields; files grouped by role with import, role change and detach; relations in both directions with add and remove. *Projects* and *project detail* mirror this: fields and the assigned assets with their assignment fields. *Inbox*: the phase 1 file list restricted to unassigned files, with "Assign" (asset picker and role).

## Calls made by the builder (not user decisions)

- **Asset types are fixed rows without an editor.** Proposed to the product owner before this document was written and not objected to; revisit when §18 is decided.
- Vocabularies for project status, priority and approval status, and the role → directory mapping above.
- Names of assets and projects are not unique; identity is the ID.
- No deletion of assets or projects in this phase; `archived` instead.
- Every managed file keeps the `<file-uuid>_<name>` form, also in `models/`; human-readable names for working files come with working-file support.
- Built-in asset types are seeded on open from a list in `core` rather than by migration SQL, so they get ordinary random UUIDs.
- No cover image columns yet; they arrive with thumbnails in phase 3.
- Which backlog items are carried into this phase (listed under Goals).

## Left to the implementation plan

Task breakdown, file layout, exact signatures and schemas, test cases, and the model used for each implementation subagent.
