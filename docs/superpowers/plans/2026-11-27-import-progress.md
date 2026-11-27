# Import Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show how far a running file import is and let the user cancel it after the current item.

**Architecture:** The workspace manager keeps the progress of the running import in memory. Two IPC channels read it and mark a cancel. The renderer polls every 500 ms while its import call is pending.

**Tech Stack:** TypeScript, Zod 4, Vitest (+ jsdom), React. No new dependency, no migration.

**Spec:** `docs/superpowers/specs/2026-11-27-import-progress-design.md` — binding; read it first.

## Global Constraints

- Everything in the repository is English. No attribution lines in commit messages. Commit, do not push.
- Never launch the app, a browser or a dialog; never call the network. Tests only.
- `core` and `contracts` do not depend on Electron or a concrete adapter.
- The step order of an import (pending row → staging → checksum → move → complete) and the stream and error
  handling of `LocalStorage.writeStream` must not change; the item in progress is always finished.
- Renderer: no explanatory text in the layout (tooltips through `title`), buttons only through the constants
  of `apps/desktop/src/renderer/src/ui.ts`, tokens only (no colour literals; `test/theme.test.ts` guards it),
  labels in `labels.ts`.
- Exact strings: `<done> of <total>`, `Cancel`, tooltip `Stops after the current file`, title suffix
  `, cancelled`, poll interval 500 ms, list reload at most every 3 s.
- Verification per task: `pnpm typecheck` and `pnpm test` (no `--` separator with `--filter`). Known flakes:
  `inbox.test.tsx > filters and scroll offset survive navigation`,
  `venice-image.test.ts > maps a refused connection to provider_unreachable`.

## Review Focus

- A cancel that arrives while the last item is being imported: the import ends normally with every result.
- An import that throws before the first item (unknown asset): the progress is `null` afterwards and the next
  import starts clean, with no leftover cancel mark.
- A source of 0 bytes or of unknown size: the bar value is a finite number between 0 and 1.
- A failed poll in the renderer: the last value stays and polling continues.
- The list reload during an import must not drop the selection or the scroll position of the file browser.

Each of these has a test in the task that owns the code.

---

### Task 1: Contract, storage, core and main process

**Files:**
- Modify: `packages/contracts/src/ipc.ts` and the file that defines `ImportResultSchema` (add `ImportProgressSchema`, export the type)
- Modify: `packages/core/src/ports.ts`, `packages/core/src/import-file.ts`, `packages/core/src/import-archive.ts`, `packages/core/src/workspace-manager.ts`
- Modify: `packages/storage/src/local-storage.ts`, `packages/storage/src/node-source-files.ts`
- Modify: `apps/desktop/src/main/library-handlers.ts` (and the preload/channel lists if channels are enumerated anywhere)
- Tests: the existing test files beside each of these; new cases as listed in the spec under Tests (contracts, storage, core, main)

**Interfaces (produces):**
- `ImportProgress = { done: number; total: number; currentBytes: number; currentSize: number | null; cancelling: boolean }`
- Channels `files:importProgress` (`{}` → `ImportProgress | null`) and `files:cancelImport` (`{}` → `{ cancelling: boolean }`)
- `WorkspaceManager.importProgress(): ImportProgress | null`, `WorkspaceManager.cancelImport(): boolean`
- `Storage.writeStream(relPath, source, options?: { onProgress?(bytesWritten: number): void })`
- `SourceFiles.open(...)` → `{ name; stream; sizeBytes?: number }`
- `ImportOptions.onProgress?(bytesWritten: number): void`

- [ ] Write the failing tests of the spec's Tests section for contracts, storage, core and main, plus the
      first two Review Focus lines (cancel during the last item; a throw before the first item).
- [ ] Run them and see them fail.
- [ ] Implement per the spec's sections Contract, Semantics, Ports and Main process. `importProgress()`
      answers a copy, never the live object.
- [ ] `pnpm typecheck` and `pnpm test` green.
- [ ] Commit: `feat: import progress and cancel in core and IPC`.

### Task 2: Renderer, documentation

**Files:**
- Create: `apps/desktop/src/renderer/src/import-progress.ts`, `apps/desktop/src/renderer/src/components/ImportProgressView.tsx`
- Modify: `apps/desktop/src/renderer/src/screens/InboxScreen.tsx`, `screens/AssetScreen.tsx`, `import-result.ts`, `labels.ts`
- Tests: `apps/desktop/test/renderer/` (new `import-progress.test.tsx`; cases in the existing inbox and asset screen tests)
- Modify: `ReadMe.md`, `docs/backlog.md`

**Interfaces (consumes):** the two channels and `ImportProgress` from Task 1.

**Interfaces (produces):**
- `useImportProgress(active: boolean): { progress: ImportProgress | null; cancel(): void; cancelRequested: boolean }`
  (`cancelRequested` resets when `active` turns false → true)
- `ImportProgressView({ progress, onCancel })`
- `importTitle(results, { duplicates, cancelled? })`

- [ ] Write the failing renderer tests of the spec, plus the last three Review Focus lines.
- [ ] Run them and see them fail.
- [ ] Implement per the spec's section Renderer.
- [ ] Update `ReadMe.md` and `docs/backlog.md` per the spec's section Documentation.
- [ ] `pnpm typecheck` and `pnpm test` green.
- [ ] Commit: `feat(desktop): show import progress with cancel`.
