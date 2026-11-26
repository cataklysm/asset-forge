# ZIP Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `.zip` picked in the import of the inbox or of an asset can be unpacked (its entries become individual files through the unchanged import steps) or imported as a file.

**Architecture:** `files:import` gets the flag `unpackArchives`. Core reads an archive through a new `ArchiveReader` port (directory first, entries as lazy streams), checks the limits, and feeds each entry into the import routine that `importFile` is split into. The adapter lives in `packages/storage` on `yauzl`. The renderer asks once per import through a small dialog.

**Tech Stack:** TypeScript, Zod, Vitest, React; new: `yauzl` (runtime, `packages/storage`), `yazl` (dev only, builds test archives).

**Spec:** `docs/superpowers/specs/2026-11-26-zip-import-design.md`

**Execution:** Task 1 in the main tree on branch `zip-import`. Then two parallel lanes in worktrees: lane A = Task 2, lane B = Task 3. Task 4 last.

## Global Constraints

- Everything in the repository is English. No attribution lines in commits. Agents commit and do not push.
- Never launch the app, never trigger "Open externally"/"Show in folder", never touch Docker containers or host port 11434.
- Fixed messages only, exactly these strings; no path, entry name or reader error text inside a message:
  - `This file is not a readable ZIP archive`
  - `This archive is too large to unpack`
  - `This archive contains no files`
  - `This archive entry cannot be imported`
  - `This archive could not be read to the end`
  - existing: `This file type cannot be imported` (`REFUSED_IMPORT_MESSAGE`)
- Limits per `files:import` call, summed over its archives: `MAX_ARCHIVE_ENTRIES = 5000` (directories included), `MAX_ARCHIVE_BYTES = 20 * 1024 ** 3` (declared uncompressed).
- No new error code in `contracts`; the two new error classes extend the existing `ValidationFailedError`.
- An entry path never becomes part of a storage path; storage paths come from `inboxPath`/`assetFilePath` only.
- `core` and `contracts` do not import `yauzl`. New dependencies are pure JavaScript and pinned through the lockfile.
- UI: no explanatory text in the layout, buttons from `ui.ts` (`BUTTON`), tokens only, labels in `labels.ts`.
- Commands: `pnpm --filter @assetforge/<package> test <file>` (no `--`), `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build`. Known flaky test: `inbox.test.tsx > filters and scroll offset survive navigation`.

## Review Focus

1. A `.zip` source imported with `unpackArchives: false` (or omitted) stays one file of kind `other`, byte-identical — today's behaviour must not change. (Task 1 test.)
2. An entry whose stream yields more or fewer bytes than declared: that entry is a failed file, the next entry is still imported, and no staging file is left. (Task 2 adapter test, Task 1 core test with a failing stream.)
3. Two archives in one call where the second takes the call over a limit: the first stays imported, the second writes nothing, a plain file after it is still imported. (Task 1 test.)
4. Entry names such as `../../x.png`, `C:\x.png`, `/x.png`, `a\b\x.png`, `x.png:stream`: the stored `relativePath` stays inside the inbox/asset path built from the file ID. (Task 1 test.)
5. Picking a ZIP and pressing `Cancel` in the choice dialog sends no `files:import` and leaves the import button usable again. (Task 3 test.)

---

### Task 1: Contracts and core

**Files:**
- Modify: `packages/contracts/src/ipc.ts` (`files:import`), `packages/contracts/src/files.ts` (`ImportResultSchema`)
- Modify: `packages/core/src/ports.ts`, `errors.ts`, `media-types.ts`, `import-file.ts`, `workspace-manager.ts`, `index.ts`
- Create: `packages/core/src/import-archive.ts`
- Create: `packages/storage/src/zip-archive-reader.ts` (stub), modify `packages/storage/src/index.ts`
- Modify: `apps/desktop/src/main/composition.ts`, `apps/desktop/src/main/library-handlers.ts`
- Modify: `packages/core/test/fakes.ts`; every place that builds or asserts an `ImportResult` (core tests, desktop tests, `apps/desktop/test/renderer/fake-api.ts`, fixtures)
- Test: `packages/core/test/import-archive.test.ts` (new), `packages/core/test/media-types.test.ts`, `packages/core/test/import.test.ts`, `packages/contracts` schema tests, `apps/desktop/test/library-ipc.test.ts`

**Interfaces — Produces:**

```ts
// contracts
'files:import'.request: { sourcePaths: string[1..1000]; target?: FileTarget; unpackArchives?: boolean }
ImportResult: { sourcePath: string; entryName: string | null; file: FileRecord | null; error: string | null; duplicateOf: string[] }

// core/ports.ts
export interface ArchiveEntry {
  /** The entry's path as stored in the archive. */
  name: string;
  uncompressedSize: number;
  isDirectory: boolean;
  isSymlink: boolean;
  /** Encrypted, or a compression method other than stored/deflate. */
  isUnsupported: boolean;
}
export interface OpenArchive {
  entries: readonly ArchiveEntry[];
  /** A stream of the entry's content that fails when it does not yield exactly `uncompressedSize` bytes. */
  openEntry(index: number): Promise<Readable>;
  close(): Promise<void>;
}
export interface ArchiveReader {
  /**
   * Rejects with SourceNotReadableError (missing, not a regular file, not readable),
   * ArchiveNotReadableError (not a ZIP) or ArchiveTooLargeError (more than `maxEntries` entries, decided before reading the directory).
   */
  open(absolutePath: string, limits: { maxEntries: number }): Promise<OpenArchive>;
}
WorkspaceHost.archives: ArchiveReader

// core/errors.ts
class ArchiveNotReadableError extends ValidationFailedError  // message 'This file is not a readable ZIP archive'
class ArchiveTooLargeError extends ValidationFailedError     // message 'This archive is too large to unpack'

// core/media-types.ts
export function isZipArchive(fileName: string): boolean      // importExtension(fileName) === 'zip'

// core/import-file.ts
export interface ImportSource { sourcePath: string; entryName: string | null; name: string; stream: Readable }
export async function importStream(ctx: ImportContext, source: ImportSource): Promise<ImportResult>  // everything of importFile after the source is open
export async function importFile(ctx: ImportContext, sourcePath: string): Promise<ImportResult>      // unchanged behaviour, entryName null

// core/import-archive.ts
export const MAX_ARCHIVE_ENTRIES = 5000;
export const MAX_ARCHIVE_BYTES = 20 * 1024 ** 3;
export const ARCHIVE_EMPTY_MESSAGE, ARCHIVE_ENTRY_REFUSED_MESSAGE, ARCHIVE_TRUNCATED_MESSAGE: string;
export interface ArchiveBudget { entries: number; bytes: number }   // what the call may still unpack; mutated
export async function importArchive(
  ctx: ImportContext & { archives: ArchiveReader },
  sourcePath: string,
  budget: ArchiveBudget,
  onImported: (result: ImportResult) => Promise<void>,   // called for each result with a complete file, before the next entry (placement)
): Promise<ImportResult[]>

// core/workspace-manager.ts
importFiles(sourcePaths: string[], target?: FileTarget | null, options?: { unpackArchives?: boolean }): Promise<ImportResult[]>
```

`importArchive` rules (spec sections "Limits", "Entries", "Results"):
- `archives.open(sourcePath, { maxEntries: budget.entries })`. A rejection gives one result `{ sourcePath, entryName: null, file: null, error }` with the error's message through `safeErrorMessage` (so a `SourceNotReadableError` reads as for a plain file).
- `entries.length > budget.entries` or the sum of `uncompressedSize` `> budget.bytes` → one result with `This archive is too large to unpack`, nothing imported, budget unchanged. Otherwise both are subtracted from the budget.
- Per entry, in order: skip (no result) when `isDirectory` or the path, with `\` read as `/`, starts with `__MACOSX/`. File name = last segment split on `/` and `\`. `isSymlink`, `isUnsupported`, an empty file name or one with a character in `\u0000-\u001f\u007f` → `This archive entry cannot be imported`. `isRefusedImport(fileName)` or `isZipArchive(fileName)` → `REFUSED_IMPORT_MESSAGE`. Otherwise `openEntry(index)` then `importStream` with `name` = file name, `entryName` = the entry path, `sourcePath` = the archive path.
- `openEntry` rejecting: that entry and every later entry that would not have been skipped get `{ file: null, error: 'This archive could not be read to the end' }`; stop.
- No result at all → one result with `This archive contains no files`.
- `close()` always runs.

`doImportFiles`: one `ArchiveBudget` per call from the two constants; a source is unpacked when `options.unpackArchives === true` and `isZipArchive(<its file name>)`, otherwise `importFile`. The existing placement block (relocate into the target, error into `result.error`) becomes one local function used for plain results and as `onImported`.

- [ ] **Step 1: Contracts.** Add `unpackArchives: z.boolean().optional()` and the required `entryName: z.string().nullable()`. Tests: the request accepts and rejects (`unpackArchives: 'yes'`), a result without `entryName` fails to parse. Fix every `ImportResult` literal in the repo (`entryName: null`).
- [ ] **Step 2: Failing core tests** in `import-archive.test.ts` (through `WorkspaceManager.importFiles` with the fake host unless noted) and `media-types.test.ts`:
  - `isZipArchive`: `a.zip`, `A.ZIP`, `a.zip. ` true; `a.zip.png`, `zip`, `a.zipx` false.
  - `unpackArchives` omitted/false: a `.zip` source is one complete file with the archive's bytes, kind `other`, `entryName: null`.
  - true: each entry is a complete file with its own sha256 and size, `originalName` = last segment, `entryName` = entry path, `sourcePath` = archive path; results in directory order; plain files and archives mixed keep the order of `sourcePaths`.
  - with an asset target every entry has the asset and the role.
  - `tex/wood/a.png` → `originalName` `a.png`; two entries `a.png` → two files.
  - Review Focus 4 names: every `relativePath` matches the inbox path of its ID (no `..`, no `:`, no drive).
  - directory and `__MACOSX/x.png` entries give no result; `.exe`, nested `.zip` → `REFUSED_IMPORT_MESSAGE`; symlink, unsupported, empty name, control character → `This archive entry cannot be imported`; none writes a row or a file.
  - only refused entries → one refusal each, no "contains no files"; an archive with no entries, and one with only a directory → `This archive contains no files`.
  - 5001 entries → too large, nothing written; declared sizes summing above `MAX_ARCHIVE_BYTES` (fake sizes) → too large; Review Focus 3.
  - a reader rejecting with `ArchiveNotReadableError` → that message; an unknown path → the source-not-readable message of a plain import.
  - an entry stream that errors → that entry is a failed file row with a result, the next entry is imported, no staging file remains.
  - `openEntry` rejecting on the 2nd of 4 entries (4th is a directory) → 1st imported, 2nd and 3rd `could not be read to the end` with `file: null`, no rows for them; `close` called.
  - an entry whose content already exists → `duplicateOf` holds the earlier file.
  - recovery: a pending row left from an interrupted entry import is cleaned on open (reuse the pattern of `recovery.test.ts`).
- [ ] **Step 3: Fake.** `FakeArchives implements ArchiveReader` in `fakes.ts` (a map path → `'not-zip'` or a list of `{ name, content?, declaredSize?, isDirectory?, isSymlink?, isUnsupported?, failOpen?, failStream? }`), counting `close` calls; `createFakeHost` returns it as `archives`.
- [ ] **Step 4: Implement** the interfaces above. Run the core tests until green.
- [ ] **Step 5: Host wiring.** `packages/storage/src/zip-archive-reader.ts`: `export class ZipArchiveReader implements ArchiveReader` whose `open` rejects with `ArchiveNotReadableError` (Task 2 replaces the body). `composition.ts`: `archives: new ZipArchiveReader()`. `library-handlers.ts`: pass `{ unpackArchives: r.unpackArchives }`. `library-ipc.test.ts`: `files:import` with `unpackArchives: 'x'` is `validation_failed`; a plain import answers `entryName: null`.
- [ ] **Step 6:** `pnpm test`, `pnpm typecheck` green. Commit `feat: unpack ZIP archives in the import use case`.

### Task 2: ZIP reader adapter (lane A)

**Files:**
- Modify: `packages/storage/package.json` (`yauzl` dependency; `yazl`, `@types/yauzl`, `@types/yazl` dev), lockfile
- Modify: `packages/storage/src/zip-archive-reader.ts`
- Test: `packages/storage/test/zip-archive-reader.test.ts`

**Interfaces — Consumes:** `ArchiveReader`, `OpenArchive`, `ArchiveEntry`, `ArchiveNotReadableError`, `ArchiveTooLargeError`, `SourceNotReadableError` from `@assetforge/core`.

Approach: `yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: true })`. Before it, the same regular-file check as `NodeSourceFiles` (→ `SourceNotReadableError`). `zipfile.entryCount > maxEntries` → close, `ArchiveTooLargeError`. Read all entries, keep the `yauzl.Entry` objects for `openEntry`. `isDirectory`: name ends with `/`. `isSymlink`: `(externalFileAttributes >>> 16 & 0o170000) === 0o120000`. `isUnsupported`: `entry.isEncrypted()` or `compressionMethod` not 0 or 8. Any yauzl error while opening or reading the directory → `ArchiveNotReadableError` (no cause text in the message). Note: `yauzl` rejects entry names with `..` or absolute paths while reading the directory when `decodeStrings` is on; such an archive must still open — read names with `decodeStrings: false` and decode them in the adapter (UTF-8 when general purpose bit 11 is set, CP437 otherwise) if that is what it takes; the test below decides.

- [ ] **Step 1: Failing tests** (archives built with `yazl` into a temp dir; the encrypted and the size-lying fixtures by patching bytes of a built archive):
  - lists names, sizes and flags for a stored entry, a deflated entry, a directory entry, a symlink entry (`mode: 0o120777`) and an entry with the encryption bit set;
  - `openEntry` yields each entry's exact bytes; two entries can be read one after the other in any order;
  - a ZIP64 archive (`forceZip64Format`) opens and reads;
  - a UTF-8 name (`größe.png`) and a CP437 name round-trip;
  - an archive holding `../evil.png` and `/abs.png` opens and lists those names unchanged;
  - a text file renamed `.zip` → `ArchiveNotReadableError`; a missing path and a directory → `SourceNotReadableError`; `maxEntries: 2` on three entries → `ArchiveTooLargeError`;
  - an entry whose declared uncompressed size is larger, and one smaller, than its content → the stream errors;
  - after `close()` the file can be deleted (the handle is released), also after a failed `open`.
- [ ] **Step 2: Implement.** `pnpm install` for the dependencies. Tests green.
- [ ] **Step 3:** `pnpm --filter @assetforge/desktop build` succeeds with `yauzl` in the main bundle; `pnpm test`, `pnpm typecheck` green. Commit `feat: read ZIP archives through yauzl`.

### Task 3: Renderer (lane B)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/ZipChoiceDialog.tsx`, `apps/desktop/src/renderer/src/import-result.ts`
- Modify: `components/ResultStrip.tsx` (`importFailures`), `screens/InboxScreen.tsx`, `screens/AssetScreen.tsx`, `labels.ts`
- Modify: `apps/desktop/test/renderer/fake-api.ts` (accept `unpackArchives`, let a test script results with `entryName`)
- Test: `apps/desktop/test/renderer/zip-choice.test.tsx` (new), `inbox.test.tsx`, `asset-screen.test.tsx`, a unit test for `import-result.ts`

**Interfaces — Consumes:** `files:import` request/response of Task 1.

**Produces:**

```ts
// import-result.ts
export function isZipPath(path: string): boolean                      // file name ends in .zip, case-insensitive, trailing dots and spaces ignored
export function importTitle(results: readonly ImportResult[], options: { duplicates: boolean }): string
//   imported = results whose file has status 'complete'; failed = results with an error
//   '<i> imported, <f> failed' and, with duplicates, ', <d> duplicates' (results with duplicateOf.length > 0)

// components/ZipChoiceDialog.tsx
export function useZipChoice(): {
  /** true = unpack, false = import as file, null = cancelled. Resolves false at once, without a dialog, when no path is a ZIP. */
  choose(sourcePaths: readonly string[]): Promise<boolean | null>;
  dialog: ReactNode;   // rendered by the screen
}
```

Dialog: shared `Dialog`, title `ZIP archive`; body is the archive's file name for one ZIP, `<n> archives` for several (no other text); buttons `Cancel`, `Import as file`, `Unpack` (all `BUTTON`; `Unpack` has the initial focus). Esc and the close button count as `Cancel`. `importFailures`: the name of an entry failure is `<entryName> (<archive file name>)`, of any other failure the source's file name as today.

Both screens: after `dialog:pickFiles`, `choose(sourcePaths)`; `null` → nothing is sent and the importing state ends; otherwise `files:import` with `unpackArchives` set to the answer. Titles from `importTitle` (inbox with duplicates, asset without).

- [ ] **Step 1: Failing tests:** `isZipPath` and `importTitle` (a failed file row counts as failed, not imported; an entry refusal counts as failed); the dialog appears only when a `.zip` was picked; `Unpack` sends `unpackArchives: true`, `Import as file` sends `false`, `Cancel` and Esc send nothing and the import button is enabled again (Review Focus 5); several ZIPs show `2 archives`; plain files send `unpackArchives: false` without a dialog; the result strip of the inbox and of the asset screen shows the entry counts and names a failed entry as `a.exe (pack.zip)`; an archive-level failure is named `pack.zip`.
- [ ] **Step 2: Implement.** Tests, `test/theme.test.ts` and `labels.test.ts` green.
- [ ] **Step 3:** `pnpm test`, `pnpm typecheck` green. Commit `feat: choose between unpacking and importing a ZIP`.

### Task 4: Acceptance and documentation

**Files:**
- Modify: `apps/desktop/package.json` (`yazl`, `@types/yazl` dev), `apps/desktop/test/acceptance.test.ts`
- Modify: `ReadMe.md` (import section, IPC list, the archive line of the security constraints), `docs/backlog.md`

- [ ] **Step 1: Acceptance test** through the real handlers, a real workspace and a real archive built with `yazl`: an archive with two PNGs (one in a folder), a `.exe` and a `__MACOSX/` entry, unpacked into an asset with a role → two complete files in the asset with that role and the names of the last segments, one refusal naming the `.exe` entry, no result for the clutter, both findable through `files:list`; the same archive with `unpackArchives: false` → one file of kind `other`; unpacking it a second time reports `duplicateOf` for both PNGs.
- [ ] **Step 2: ReadMe:** the choice, the entry rules, the limits and messages, `unpackArchives` and `entryName` in the IPC list. **Backlog:** remove the "ZIP import" request (and adjust the intro line); add a section "ZIP import" with what is deferred: no progress or cancel, no other formats, no password archives, no nested archives, no unpacking of a ZIP already in the workspace, no free-space check, no folder structure.
- [ ] **Step 3:** `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build` green. Commit `test: accept ZIP import end to end; docs`.
