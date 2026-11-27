# Remembered import directory — design

Date: 2026-11-27. Status: approved. Size: a small change.

## Intent

The file picker of the import (inbox and asset screen, channel `dialog:pickFiles`) is opened without a start
directory, so it opens wherever the operating system puts it — for the owner always in Downloads. The owner
imports from the same few folders again and again and wants the picker to open where the last import came from.

## Goals

- After a confirmed selection the app remembers the directory of the first chosen file.
- The next file picker opens in that directory, also after a restart, and in every workspace.
- A remembered directory that no longer exists (drive removed, share not reachable) is ignored: the picker opens
  as it does today.

## Non-goals

- A directory per workspace, per screen or per role.
- The directory picker used when a workspace is created (`dialog:pickDirectory`) stays unchanged.
- A history of directories, a setting, or anything visible in the renderer.

## Approaches

1. **App-level memory in the main process (chosen).** One small file in `userData`; the main process reads it
   before the dialog and writes it after a confirmed selection. No contract change, the renderer is not involved.
2. **Per workspace.** A column or a file per workspace. More work, and the source folders are the same whichever
   workspace is open. Rejected.
3. **In the renderer (`localStorage`) with a `defaultPath` argument on the channel.** Would hand the renderer a
   path to set and to read; the renderer has no reason to know absolute paths. Rejected.

## Design

- New module `apps/desktop/src/main/import-directory.ts`:
  `createImportDirectoryMemory(filePath: string): ImportDirectoryMemory` with
  - `current(): string | undefined` — the remembered directory when the file is readable, has the expected shape
    and the directory exists and is a directory; otherwise `undefined`. Never throws.
  - `remember(filePaths: readonly string[]): void` — stores `dirname` of the first path; an empty list writes
    nothing; a failed write is ignored (best effort). Never throws. Nothing is written when the directory is
    unchanged.
- The file is `userData/import-directory.json` with the content `{ "v": 1, "directory": "<absolute path>" }`,
  written through `writeAtomic` (`atomic-file.ts`). An unreadable or malformed file counts as "nothing
  remembered"; it is not set aside and is overwritten by the next `remember`. `directory` must be a non-empty
  string and an absolute path, otherwise it counts as malformed.
- `apps/desktop/src/main/index.ts`: `pickFiles` passes `defaultPath: memory.current()` (the key is left out when
  there is none) and calls `memory.remember(result.filePaths)` when the dialog was not cancelled. A cancelled
  dialog changes nothing.
- The path stays in the main process: no IPC channel carries it, the renderer cannot set it, and it is written
  to no log line.
- `userData` is the app's local profile; this file is the one place besides the workspace registry where an
  absolute path of the user's machine is stored outside a workspace database. That is in line with the rule
  that database rows hold relative paths: this is no database row and no workspace data.

## Tests

`apps/desktop/test/import-directory.test.ts` with temporary directories: nothing remembered at first;
remember then `current()`; survives a new instance on the same file; a removed directory answers `undefined`;
a path that is a file answers `undefined`; malformed JSON, a wrong version, a relative or empty `directory`
answer `undefined` and the next `remember` repairs the file; an empty list writes nothing; a write into a
location that cannot be written does not throw. The wiring in `index.ts` is not unit-tested (Electron entry
point, as today).

## Documentation

`ReadMe.md` gets one sentence where the import picker or the app-level files in `userData` are described.
