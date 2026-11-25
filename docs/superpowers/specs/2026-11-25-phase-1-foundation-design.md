# Phase 1 – Foundation: Design

Date: 2026-11-25 · Status: approved · Source of truth for the overall architecture: `ReadMe.md`

## Intent

Turn the target architecture in `ReadMe.md` into a first runnable desktop application. Phase 1 lays the foundation every later phase builds on: the monorepo, the Electron shell, the workspace concept, local persistence with migrations, and a storage layer with a crash-safe import flow.

The ReadMe describes eight phases (1–6 are the MVP). Each phase is planned and built as its own project; this document covers phase 1 only.

## Acceptance criterion (ReadMe §17)

Create a workspace, close it and reopen it; file import and metadata are preserved.

## Goals

- pnpm workspaces monorepo with `apps/desktop` and the packages `core`, `contracts`, `persistence`, `storage`.
- Electron + React/Vite desktop app with typed IPC and a hardened renderer (`contextIsolation`, no Node integration, sandbox; IPC arguments validated with Zod).
- Workspace lifecycle: create, close, reopen. `workspace.json` (ID, format version, no credentials) in the workspace folder; one SQLite database per workspace under Electron `userData`; a workspace registry in local settings.
- Schema migrations with Drizzle, applied when a workspace is opened.
- File import into the workspace `inbox/` using the restartable flow from ReadMe §9.4: pending DB row → write to `.assetforge/staging/` → verify SHA-256 → move within the same volume → commit final state.
- Startup recovery: incomplete transfers are detected and cleaned up; a failed import never leaves a file marked as complete.
- Vitest tests for storage consistency and migrations from the start.
- Minimal UI: choose or create a workspace, import files, list imported files with their metadata.

## Non-goals (later phases)

- Assets, projects, asset types, roles, relations, workflows (phase 2).
- Gallery, thumbnails, previews, tags, search (phase 3).
- Persistent job queue, workers, providers, Ollama, Docker Compose (phases 4–5).
- Backup/restore workflow, trash, versions (phase 6). Phase 1 only keeps the data layout backup-friendly: one self-contained database per workspace.
- The packages `providers`, `jobs`, `media`, `ui` and the app `apps/api` are not created yet.
- Packaging/installer, multi-platform builds.

## Anti-goals

- Persistence logic in the renderer or preload.
- `core` or `contracts` depending on Electron, SQLite or any concrete adapter.
- Absolute paths stored in the database.
- SQLite on the workspace (possibly NAS) volume.
- Silent overwriting of an imported file.

## Constraints

- Windows 11 is the development target; Node 24, pnpm 11.
- Native modules (better-sqlite3) must load under the Electron ABI. This is verified first, because everything else depends on it.
- Everything in the repository is English.

## Approaches

1. **Vertical slice of phase 1 as specified (chosen).** Build only the four packages and the desktop app that phase 1 needs, with imports landing in `inbox/`. Smallest step that satisfies the acceptance criterion and proves the layering, the native-module build and the staging flow.
2. **Scaffold the full repository structure from ReadMe §13 up front.** Rejected: creates empty packages with speculative interfaces for phases that are not designed in detail yet.
3. **Pull a minimal Asset entity into phase 1** so imported files have an owner. Rejected: the ReadMe already provides `inbox/` for unassigned files; assignment to assets is added in phase 2 without changing the import flow.

## Design

**Layering.** Renderer → preload (typed IPC) → Electron main → use cases in `core` → ports → adapters. `core` defines the ports (`WorkspaceRepository`, `FileRepository`, `Storage`, clock/ID providers) and the use cases (`createWorkspace`, `openWorkspace`, `closeWorkspace`, `importFiles`, `listFiles`, `recoverIncompleteImports`). `contracts` holds Zod schemas and DTOs for IPC. `persistence` implements the repositories on better-sqlite3 + Drizzle. `storage` implements the `Storage` port on the local file system with stream-based reads/writes and path-escape checks. `apps/desktop` wires everything together.

**Data model (phase 1 subset).** `workspace` (id, format version, storage root reference, timestamps) and `file` (id, relative storage path, original file name, MIME type, size, SHA-256 checksum, import status `pending`/`complete`/`failed`, error, import timestamp). `asset_id` is nullable so phase 2 can assign inbox files without a destructive migration. IDs are UUIDs. Paths are stored relative to the workspace root.

**Import.** Files are copied; the source stays untouched. Hashing happens while streaming to staging. The final file name is `<file-uuid>_<sanitized original name>` in `inbox/`. Duplicate content (same SHA-256) is reported to the user but still importable; physical deduplication is out of scope.

**Local application data.** Paths come from the Electron API (`app.getPath('userData')`), never hard-coded: `settings.json` with the workspace registry, `workspaces/<workspace-uuid>/assetforge.sqlite`.

## Calls made by the builder (not user decisions)

- Library versions: current stable releases at implementation time, pinned by the lockfile.
- Build tooling for the Electron app (e.g. electron-vite) and test layout.
- Tailwind/shadcn are introduced only as far as the minimal UI needs them.
- MIME type detection by file extension in phase 1; content sniffing can follow with the media package.

## Left to the implementation plan

Exact task breakdown, file layout inside each package, and the order of verification steps.
