# Import progress — design

Date: 2026-11-27. Status: approved. Size: a small feature across contracts, core, storage, main and renderer.

## Intent

`files:import` is one call that answers when every source is imported. Until then the inbox and the asset
screen show only `Importing…` beside a disabled button. With a few hundred images or a large archive the owner
cannot tell how far the import is, and cannot stop an import started by mistake.

## Goals

- While an import runs, the screen that started it shows how many items are done out of how many, and a bar
  that also moves while one large file is being copied.
- The entries of an unpacked ZIP archive count as items.
- The file list fills while the import runs.
- A Cancel button stops the import after the item that is being imported; what is imported stays.

## Non-goals

- Aborting in the middle of one file.
- A persisted import, an import as jobs, progress that survives a restart.
- Progress for the URL import (its downloads are jobs and are shown on the Jobs screen).
- An estimate of the remaining time, a transfer rate, the name of the current file.

## Approaches

1. **State in the core, polled by the renderer (chosen).** The workspace manager keeps the progress of the
   running import in memory; the renderer asks for it twice a second through a read channel. This is how the
   jobs summary already works; no new mechanism.
2. **Push events from the main process.** The app has no main-to-renderer events today; adding the mechanism,
   its preload surface and its validation buys nothing over a poll at this rate. Rejected.
3. **The import as a job queue.** One job per file would give progress and cancel for free, but changes the
   crash-safety flow, the result dialog and both screens. Far too large for the need. Rejected.

## Design

### Contract (`packages/contracts`)

`ImportProgressSchema` / `ImportProgress`:

```ts
{ done: number; total: number; currentBytes: number; currentSize: number | null; cancelling: boolean }
```

All numbers are non-negative integers.

- `files:importProgress` — request `{}`, response `ImportProgress | null`. `null` when no import is running
  (also when no workspace is open; the channel never fails for that reason). It does not wait for the queue.
- `files:cancelImport` — request `{}`, response `{ cancelling: boolean }`: `true` when an import was running
  and is now marked, `false` otherwise. Calling it twice is harmless.
- `files:import` is unchanged in request and response. After a cancel its answer holds only the results of the
  items that were handled.

### Semantics (core)

`WorkspaceManager` gets `importProgress(): ImportProgress | null` and `cancelImport(): boolean`. The state
exists from the start of `doImportFiles` (after the target check) until it settles, also when it throws.

- `total` starts as the number of source paths.
- A plain source is one item. An archive that is unpacked is one item until its directory is read and the
  limits have passed; then `total` grows by the number of its entries that give a result (everything except
  directory entries and `__MACOSX/`) minus one. An archive that fails as a whole or contains no files stays
  one item.
- `done` grows by one whenever an item has its result: a plain source after it is placed, an archive entry
  after it is placed or refused, a failed archive when it fails.
- `currentBytes` and `currentSize` describe the item being imported: both are reset (`0`, `null`) when an item
  starts; `currentSize` is the size of the source file or the declared uncompressed size of the entry, when
  known; `currentBytes` is what the storage has written to staging so far.
- Cancel is checked before every source and before every archive entry. Once it is set, no further item is
  started and the remaining ones give no result. An archive cancelled before its first entry answers no
  result at all (not `This archive contains no files`). The item in progress is always finished, so the
  crash-safety steps of an import are untouched.

Ports:

- `Storage.writeStream(relPath, source, options?: { onProgress?(bytesWritten: number): void })` — called with
  the cumulative number of bytes as chunks are written. The local storage adapter implements it where it
  already hashes the chunks; the stream handling and the error attribution do not change.
- `SourceFiles.open` answers `{ name, stream, sizeBytes?: number }`; `NodeSourceFiles` fills it from the stat
  it already takes.
- `ImportOptions` (`importStream`) gets `onProgress?(bytesWritten: number): void`, passed on to `writeStream`.

How `importArchive` reports its directory, its items and the cancel is left to the builder (a hooks object
beside `onImported` is the obvious shape); the download import does not use any of it.

### Main process

Two handlers in `library-handlers.ts`: `files:importProgress` answers `manager.importProgress()`,
`files:cancelImport` answers `{ cancelling: manager.cancelImport() }`. Nothing is logged.

### Renderer

- A hook `useImportProgress(active)` (new file `import-progress.ts`): while `active`, asks
  `files:importProgress` every 500 ms, one request at a time; a failed request keeps the last value; inactive
  resets to `null`. It also offers `cancel()` (calls `files:cancelImport`) and `cancelRequested`.
- A component `ImportProgressView`: the text `<done> of <total>`, a bar (`role="progressbar"`, tokens only)
  whose value is `(done + fraction) / total` with `fraction = currentBytes / currentSize` capped at 1 (0 when
  the size is unknown or 0), and a `Cancel` button in the shared button look, with the tooltip
  `Stops after the current file`, disabled once cancelling. No explanatory text. Labels live in `labels.ts`.
- Inbox and asset screen show the view instead of `Importing…` as soon as a progress is known; before that
  (file picker, ZIP choice) `Importing…` stays as today.
- While an import runs, the screen reloads its file list at most every 3 s, and only when `done` has changed
  since the last reload.
- When a cancel was requested, the result title ends with `, cancelled` (`import-result.ts`).

## Tests

- Contracts: the schema and both channels.
- Storage: `writeStream` reports cumulative bytes ending at the file size; without the option nothing changes;
  `NodeSourceFiles.open` answers the size.
- Core: `null` before and after an import and after one that throws (unknown asset); `total`, `done`,
  `currentBytes` and `currentSize` observed during plain imports; the total growing for an archive with
  directory entries, refused entries and `__MACOSX/`; a failed and an empty archive stay one item; cancel
  between two sources and between two entries keeps the earlier results and starts nothing further; cancel
  with nothing running answers `false`.
- Main: both handlers, with and without an open workspace.
- Renderer (jsdom, fake timers): the hook polls only while active, supersedes nothing and survives a failed
  request; the view's text, bar value and Cancel state; both screens show the view, reload the list while
  `done` changes and end the result title with `, cancelled` after a cancel.

## Documentation

`ReadMe.md` where the import is described; `docs/backlog.md` gets what is left out (no abort inside a file,
no progress for a second import waiting in the queue).
