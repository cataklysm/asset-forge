# In-place list updates

## Intent

While jobs run, the Jobs table, the Files tab of an asset and the inbox reload completely every two
seconds: the jobs poll bumps a token, the token is part of the list key, the loader drops every page and
the virtualised view remounts with a restored scroll offset. Scrolling is interrupted and rows flash as
placeholders. The owner collects and analyses assets in bulk, so this is the normal state of the app.

A background change must reach a list without a remount, and a change of metadata must touch only the
record it belongs to.

## Goals

- A finished analysis job replaces the affected file record in the lists that show it. No list query, no
  remount, no placeholder, scrolling goes on.
- A job that changed state replaces its row in the Jobs table the same way.
- A file added in the background (download, generation result) refreshes the list of its target in
  place: the view stays mounted, the visible pages are swapped when their answer arrives.
- Scroll position, focus, multi-select and an open file detail dialog survive all of these.

## Non-goals

- No push channel from the main process. The renderer keeps the 2 s poll.
- No change to what the user's own actions do (filter, search, delete, assign, import, tag rename,
  actions on the Jobs screen): they change the list key and reload as today.
- The asset gallery, the projects list and the prompts list do not react to jobs today and stay so.
- No change feed for anything but jobs and files.

## Anti-goals

- A row must never disappear or move under the pointer because of a metadata change.
- A list must never show a mix of two refreshes or the answer of an earlier one.

## Approaches

1. **Throttle the reload.** Little work, the jolt stays, only less often. Rejected.
2. **Refresh in place for every job change.** Removes the remount, but still queries the visible pages
   every two seconds during a bulk analysis although only single records changed.
3. **Two paths (chosen by the owner):** a metadata change updates only its record; a change of what a
   list contains refreshes that list in place. Since the app has one user and nothing is deleted in the
   background, the second path is needed only for files that jobs add and for the Jobs list itself.

## Design

### Change feed (main process)

A `ChangeFeed` in `apps/desktop/src/main` keeps the changes of the open workspace in memory, numbered,
at most 2000 entries (older ones are dropped). It is cleared on every workspace open, close and remove.
An entry is one of:

- `job` `{ id }`: one job row changed (state, attempt, error, result).
- `jobs`: jobs were added, removed or changed in bulk (enqueue, clear finished, retry failed, cancel
  all, reroute, the assignments and the reconcile on workspace open).
- `file` `{ id }`: the metadata of one file changed (tags, analysis, proposal).
- `files` `{ assetId | null }`: a file was added to this asset, or to the inbox for `null`.

Sources:

- The scheduler's `onChange` carries the job id (`onChange(jobId: string)`); every call is a `job` entry.
- A job handler reports what it did through an `effects` dependency with `fileChanged(fileId)` and
  `fileAdded(assetId | null)`: the analysis handler calls `fileChanged` when it stored tags or a
  proposal, the download handler and the generation handler call `fileAdded` with the place the file
  ended up in (a download that was `already_present` reports nothing); when that is an asset they
  also report the inbox (`null`), which the file passed through, so an inbox page read meanwhile is
  refreshed. The port lives in core, the feed implements it.
- A lane hold (`Retry-After`) moves every waiting job of the lane; the scheduler reports it as a
  change of several rows (`onChange(null)`, a `jobs` entry) when it moved at least one.
- `JobHost.changed()` (the IPC handlers) writes a `jobs` entry.

`jobs:summary.changes` stays as it is and still rises with every entry, so the existing tokens keep
working.

New channel `changes:since` `{ cursor: string | null }` →
`{ cursor, reset, jobIds, jobs, fileIds, added }`: `cursor` is opaque (feed instance and number),
`reset` is true when the given cursor is null, belongs to another feed instance or is older than the
kept entries; then the lists are empty and the caller treats everything as changed. Otherwise
`jobIds` and `fileIds` are distinct ids, `jobs` a boolean and `added` a list of distinct
`{ assetId | null }`. Without a workspace it answers `reset: true` with empty lists. It needs no
workspace read and never waits for the queue.

### Reading single records

`files:list` and `jobs:list` take an optional `ids` (1–100 distinct ids). With it the answer holds
only those of the ids that match the rest of the request (scope, filters, search); offset and limit
apply as before. So a file that fell out of the filter is simply not answered.

### Renderer

- `JobsProvider` asks `changes:since` once after every poll in which `changes` moved and hands the
  answer to subscribers (`useChanges(listener)`), not through state, so nothing re-renders that does
  not listen. `changeToken` and `resultToken` stay for `AnalysisResultDialog`, `GenerationDetails` and
  `GenerationStudio`.
- `PagedLoader` gets two operations, exposed by `usePagedList`:
  - `patch(items)`: replaces loaded items with the same `id`; nothing else changes.
  - `refresh()`: keeps key, total and displayed pages; refetches the wanted pages and swaps each when
    its answer arrives; every other loaded page is dropped and loads again when it is wanted. The
    total follows the newest answer. A refresh gets its own number, so the answer of an earlier
    refresh or of a page request from before it is ignored. Page 0 is refetched when no page is
    wanted, also for an empty list. A refresh asked while one runs, while the loader is inactive,
    while a key change is loading or before page 0 of the key has settled is run once afterwards; a
    further key change clears it, since the new key loads fresh.
- `FileBrowser` no longer takes the job token in its key. On a change answer it:
  - patches: the loaded records whose id is in `fileIds` are read through `files:list` with `ids` and
    the list's own request; answered records are patched, records not answered stay as they are until
    the next reload. More than 100 loaded matches: `refresh()` instead. A read that fails, or whose
    answer is dropped because the list's key changed meanwhile, is followed by `refresh()`, so the
    change is not lost.
  - refreshes in place when `added` holds its scope (the asset of the Files tab, `null` for the
    inbox) or on `reset`. The trash never reacts.
- The Files tab count of the asset screen and the inbox count are read again only on a matching
  `added` or a `reset`.
- `JobsScreen` no longer takes `changeToken` in its key: `jobIds` patch the loaded rows (read through
  `jobs:list` with `ids` and the current filter), `jobs` or `reset` refresh in place. Its own actions
  keep the reload through `reloadToken`.
- The file detail dialog shows the record of the list it was opened from and therefore follows a
  patch as it follows a reload today.

### Known limits

- With a status filter on the Jobs screen, a job that left the filter keeps its row (with the new
  state) and the pages loaded afterwards are shifted by the jobs that left; setting the filter again
  corrects it. The same holds for a file list with a filter the analysis moves a file into.
- A change reaches a list up to 2 s late, as today.

## Tests

- `ChangeFeed`: numbering, distinct ids, the cap and `reset` for an old, foreign or null cursor.
- Scheduler: `onChange` carries the id of the job that changed.
- Handlers: the analysis reports `fileChanged` only when it wrote; download and generation report the
  target; `already_present` reports nothing.
- `files:list` and `jobs:list` with `ids`, with and without a filter that excludes one of them.
- `PagedLoader`: `patch` keeps identity of untouched pages; `refresh` keeps the displayed state until
  the answer, drops unwanted pages, ignores stale answers, coalesces a second request.
- Renderer (jsdom): a `fileIds` answer patches the visible tile without a second page request and
  without a remount (the scroll element is the same node); an `added` for another asset does nothing;
  an `added` for this one refetches the visible page in place; the same for the Jobs table.

## Left to the builder

File and identifier names beyond those above, the shape of the cursor, and how the handlers receive
`effects`.
