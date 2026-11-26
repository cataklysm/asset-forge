# ZIP import — design

Status: draft for the owner's approval, 2026-11-26.

## Intent

The owner receives and keeps material as ZIP files: flat archives of files, no folders. Today a ZIP can only be imported as one opaque file, so its contents have to be unpacked by hand outside the app first. The owner wants to pick the ZIP in the normal import and get its contents as individual files, in the inbox or directly in an asset. Sometimes the archive itself is the thing to keep (a texture pack attached to an asset), so importing a ZIP as a file must stay possible.

## Goals

- Picking a `.zip` in the import of the inbox or of an asset offers two ways: **unpack** it (its contents are imported as individual files) or **import it as a file** (today's behaviour).
- Unpacked contents behave exactly like individually imported files: one file row each, the same crash-safe import steps, the same refusals, the same duplicate hint, and in an asset the chosen role.
- An archive that is broken, hostile or too large never harms the workspace and never leaves a half-read state that needs repair.

## Non-goals

- Keeping the folder structure of an archive. Entries in folders are imported flat.
- Unpacking an archive inside an archive.
- Other archive formats (7z, RAR, tar, gz).
- Password-protected archives.
- A progress display or a cancel button for a running import (the import has neither today).
- Keeping the archive beside its unpacked contents, or a link from a file back to the archive it came from.
- Unpacking a ZIP that already sits in the workspace as a file.
- Drag and drop (the app has none yet).

## Anti-goals

- An entry written outside the workspace or outside the path the import chose for it (zip slip, absolute paths, drive letters, `..`, symlink entries).
- A program, installer or shortcut entering the workspace because it was inside an archive.
- An archive that writes without bound (a decompression bomb) or blocks the app's main process. What one import may write is bounded by the limits below; free disk space is not checked beforehand, as for every import today (author's call).
- A partly unpacked archive that looks complete: the owner must see what was imported and what was not.
- The owner losing the ability to store a ZIP as a file.

## Constraints

- `CLAUDE.md`: use case in `core`, adapters behind ports, validated IPC, fixed error messages without paths or cause texts, streams with backpressure, no blocking work on the main event loop, storage operations never escape the workspace, imported originals are never overwritten.
- The import contract (`packages/core/src/import-file.ts`): pending row → staging → checksum verification → move → complete; a failure of one file never rejects the batch. Startup recovery cleans up pending rows.
- `files:import` takes up to 1000 source paths and answers one `ImportResult` per source (`sourcePath`, `file`, `error`, `duplicateOf`). The whole import runs inside the workspace queue, as today.
- Refused types are decided by name (`isRefusedImport`, `REFUSED_IMPORT_EXTENSIONS`).
- UI rules: no explanatory text in the layout (tooltips through `title`), buttons from `ui.ts`, tokens only, labels in `labels.ts`.
- A new dependency must be pure JavaScript or be tested against the Electron ABI.

## Approaches

1. **Stream each entry straight into the existing import (chosen).** The archive's directory is read first; every entry is then handed to the same import routine as a named stream. No temporary folder, the staging file of the import is the only copy written, and checksum, crash safety and recovery apply unchanged. The limits are checked from the directory before anything is written.
2. **Unpack into a temporary folder, then import the paths.** Reuses `files:import` untouched, but writes everything twice, needs its own cleanup after a crash, and puts files with attacker-chosen names on disk outside the import's own naming.
3. **A persistent job per archive.** Would give progress and cancel, but the import is not a job today; making it one is a larger change than this feature and belongs with a general "import as job" step.

Whether a ZIP is unpacked is the owner's choice per import (owner decision, 2026-11-26: both ways are needed).

## Design

### What counts as an archive

A source whose name has the extension `zip` by `importExtension` (trailing dots and spaces stripped, case-insensitive). One shared function decides this for sources and for entries; the alternate-data-stream rule of the refusals is not applied (author's call). Nothing else is offered for unpacking. A `.zip` that turns out not to be a readable ZIP answers an archive-level failure (below).

### The choice

`files:import` gets `unpackArchives: boolean` (optional, default `false`). With `false` every source is imported as a file, exactly as today. With `true` every `.zip` source is unpacked and every other source is imported as a file. One choice covers all archives of one import (author's call: one question per import, not one per archive).

### Reading an archive

A new port in `core`, implemented in `packages/storage` on a pure-JavaScript ZIP reader that reads the central directory first and opens entries lazily as streams (ZIP64 included):

- `open(absolutePath)` → the list of entries (`name`, `uncompressedSize`, `isDirectory`, `isSymlink`, `isEncrypted`) plus `openEntry(index)` → a readable stream, and `close()`.
- The adapter verifies while streaming that an entry yields exactly its declared size and fails the stream otherwise, so the limits below hold for what is actually written.
- Decompression runs through Node's zlib streams (thread pool), not synchronously on the main loop.
- Entry names are decoded as UTF-8 when the entry says so and as CP437 otherwise (the ZIP standard).
- A path that is missing, not a regular file or not readable answers the existing source-not-readable failure; a readable file that is not a ZIP answers the archive-level message below.

### Limits

The limits hold for one `files:import` call, summed over all its archives (the import blocks every other write to the workspace while it runs, and its answer is one IPC response):

- at most **5000** entries (directories included),
- at most **20 GiB** declared uncompressed size.

The directory of an archive is read before its first entry is imported. An archive that would take the call over a limit is not unpacked at all: one failure result, nothing written; archives before it stay imported and later sources are still tried. (Author's call on the numbers; they are constants in `core`.)

### Entries

In directory order, each entry is one of:

- **Skipped silently** (no result): directory entries, and everything under `__MACOSX/` (resource-fork clutter macOS adds; author's call).
- **Refused** (a result with `file: null` and a fixed message, nothing written):
  - a symlink entry, an encrypted entry — `This archive entry cannot be imported`;
  - a refused type by name — the existing `This file type cannot be imported`;
  - a `.zip` entry — the existing refused-type message (archives inside archives are not unpacked and not imported; author's call: one rule, and it closes the nesting question);
  - an entry whose file name (the last path segment) is empty or contains a control character — `This archive entry cannot be imported`. Everything else about the name on disk is already handled by `sanitizeFileName`, which every storage path goes through.
- **Imported**: everything else. The file name is the last segment of the entry path (split on `/` and `\`); the folders are dropped. The entry path never becomes part of a storage path — the import builds its own path from a new ID and the file name, as for every import. Two entries with the same file name are two files.

An imported entry goes through the unchanged import steps (pending row, staging, checksum, move, complete, image measurement, duplicate lookup) and, with an asset target, the same placement with the chosen role. A failure of one entry (for example a size mismatch or a corrupt stream) is that entry's failed file row and result, as for any failed import; the next entry follows.

To make this possible `importFile` is split: the part after "the source is open" takes a name and a stream, so a disk file and an archive entry share it.

### Results

`ImportResult` gets the required field `entryName: string | null`: `null` for a plain source, the entry's path inside the archive for an entry. `sourcePath` stays the archive's path for its entries. `files:import` then answers one result per plain source and, for an unpacked archive, one result per imported or refused entry — or exactly one result with `entryName: null` when the archive as a whole fails:

- not a ZIP, or its directory cannot be read: `This file is not a readable ZIP archive` (a missing or unreadable file answers `This file cannot be read`);
- over a limit: `This archive is too large to unpack`;
- no result at all (empty, or only skipped entries): `This archive contains no files`. An archive holding only refused entries answers one refusal per entry instead.

An archive whose directory was read but that becomes unreadable part-way reports each entry that cannot be opened as a result with `file: null` and `This archive could not be read to the end`, without a file row; the following entries are still tried. The entry being read at that moment fails like any import (a failed file row).

### Crash and repeat

Each entry is an ordinary import, so a crash leaves at most one pending row, which startup recovery handles as today. Entries imported before the crash stay; the rest was never started. Unpacking the same archive again imports everything again and reports the earlier files through `duplicateOf` — consistent with the standing rule that a duplicate is never skipped.

### Renderer

- **Choice dialog.** After the file picker, when at least one picked path ends in `.zip`, a small dialog (shared dialog component) opens before the import starts: title `ZIP archive`, the archive's file name (or `<n> archives`), and the buttons `Cancel`, `Import as file`, `Unpack`. `Unpack` is the default action. `Cancel` imports nothing. The same dialog serves the inbox and the asset screen.
- **Result.** Both screens build the result title with one shared function: imported = results with a complete file, failed = results with an error, and in the inbox the duplicates as today. (Today the inbox counts a failed file as imported too; with entries that would mislead.) A failure line of an entry shows the entry name with the archive's file name; an archive-level failure shows the archive's file name.
- No other change: the import button stays disabled while the import runs, lists reload afterwards as today.

### Error handling

Fixed messages only, listed above; no path, entry name or reader error text inside a message. Entry names reach the renderer only as the `entryName` field of a result. Unexpected errors follow the existing rule (`safeErrorMessage`).

### Documentation

ReadMe: the import section (archive choice, entry rules, limits) and the IPC list. `docs/backlog.md`: remove the ZIP request, add what is deferred. `CLAUDE.md` project state.

## Testing

- Reader adapter (real ZIP fixtures built in the test): entries listed with sizes and flags; an entry stream yields the content; stored and deflated entries; a ZIP64 archive; a file that is not a ZIP; an entry longer or shorter than declared fails its stream; a symlink entry and an encrypted entry are flagged.
- Core: `unpackArchives: false` imports the ZIP as a file; `true` imports each entry with the import contract (checksum, sizes, kind, image measurement); into an asset every entry gets the role; entries in folders are imported flat with the last path segment as name; same file name twice gives two files; entry names with `..`, a leading `/`, a drive letter or backslashes never influence the storage path; directory and `__MACOSX/` entries give no result; refused type, nested `.zip`, symlink and encrypted entries give a refusal and write nothing; entry-count and size limits refuse the whole archive before any write; an empty archive; one failing entry does not stop the next; `duplicateOf` for an entry whose content already exists; a mix of plain files and archives in one call keeps the order.
- Recovery: a pending row left by an interrupted entry is cleaned on open, as for a plain import.
- IPC: `unpackArchives` validated; `entryName` in the response; no workspace → `no_workspace_open`.
- Renderer (jsdom): the dialog appears only when a `.zip` was picked; each button sends the matching request or nothing; the result strip counts entries and names a failed entry; inbox and asset screen both.

## Left to the builder

- The ZIP reader library (pure JavaScript, lazy entries, ZIP64, size validation), and whether the size check is the library's or the adapter's.
- Where the new port lives (beside `SourceFiles` or as part of it) and how `importFile` is split.
- What exactly makes an entry file name unusable, in line with how source names are handled today.
- The exact labels and the layout of the dialog, following `labels.ts`.
