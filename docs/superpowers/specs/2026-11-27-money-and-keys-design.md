# Money and keys: backlog package 1

## Intent

Eight backlog entries share one risk: the owner pays for a provider request twice or loses a paid
result, or an API key is lost or sent to the wrong place. This package closes them. Nothing new is
built; visible behaviour changes only where stated below.

## Goals

- A paid request is never started twice by accident and never aborted by an unrelated action.
- A paid answer that could not be kept is reported as exactly that.
- A damaged settings file never costs a stored key, and a key is only ever sent to the origin it was
  saved for.
- A cancel the owner asked for is never lost.
- No error message that crosses IPC carries a path.

## Non-goals

- No deduplication of identical generation requests: deliberate variants stay possible.
- No quarantine view for broken provider entries.
- No protection against code running as the same OS user (DPAPI is per user).

## Decisions

The owner decided 1–3; the rest are the builder's calls recorded here.

1. **Source trashed while its generation runs:** the running request finishes. Its result goes into
   the asset the source was in (`trashedAssetId`, role `generated`) when that asset still exists,
   otherwise into the inbox. Waiting generation jobs of the file are still cancelled (free).
2. **Purge while a generation of the file runs:** refused for that file with `invalid_operation`,
   `This file still has a running generation`. `trash:empty` counts it as failed.
3. **Studio:** a start in flight keeps Generate and Upscale disabled across a remount, and the form
   (prompt, attached library prompt and values, model, parameters) survives raising the studio.

## Design

### 1. Double start in the studio

- The set of starts in flight lives in `StudioProvider` (keyed by source file id and kind) and is
  exposed as state, so a fresh `GenerationStudio` instance renders disabled. The existing upscale
  guard of the file menu uses the same set.
- The studio's form state survives a raise. Left to the builder: stop remounting (re-raise the
  dialog instead) or keep the draft per source file in the provider. Closing the studio drops it.
- Main process: `generations:start` keeps the source file ids of the starts it is handling; a second
  start for the same file and kind while the first is in the call answers `busy`
  (`A generation for this file is already being started`). The entry is removed in `finally`.

### 2. Trash and purge against a running generation

- `cancelFileJobs` on trash skips `image.generate` jobs in state `running`; everything else is
  cancelled as today.
- The generation handler places the result with: source has an asset → that asset; source trashed
  and `trashedAssetId` names an existing asset → that asset; otherwise the inbox. `JobEffects`
  reports the place it ended up in, as today.
- A restore of the source later is unaffected; the result is never moved again.
- Purge checks for a running `image.generate` job of the file before anything is written and
  refuses (decision 2). Queued ones are cancelled and their generations settled `cancelled`.

### 3. A paid answer that could not be stored

- New job error code `generation_result_not_stored`, message
  `The provider answered, but the result could not be stored`, not retryable, no pause.
- Used when the import of the answer fails without a stream error and when the link transaction
  reports nothing linked. A stream error stays `provider_outcome_unknown`.
- The import runs with `discardOnFailure: true` and `onStreamError`; no failed row is left in the
  inbox.

### 4. Damaged provider settings

- The file is read as an envelope and each entry is checked on its own. A broken entry is left out;
  `lastUsedId` pointing at it becomes null. When anything was left out, or the whole file is
  unreadable, the original is **copied** to `.corrupt-<stamp>` (unreadable: set aside as today).
- After such a degraded load no key file is swept for the rest of the app session. A clean load
  sweeps as today.
- File-level rules that cannot be judged per entry (more than `MAX_PROVIDERS`, duplicate ids): the
  first ten, the first of each id.

### 5. Key bound to its origin

- A key file holds the `safeStorage` ciphertext of a versioned payload with the origin and the key.
  A key is used only when the payload's origin equals the entry's origin; otherwise the entry has no
  key (`hasApiKey: false`) and nothing is sent. The file is left alone; saving a key replaces it.
- A file in the old form (bare key) is bound to the entry's current origin and rewritten at load,
  before any request. A failed rewrite keeps the old file and the key stays usable for the session.
- The adoption of the version 1 single key file writes the new form.

### 6. Paths in error messages

Fixed messages: `Storage is not reachable`, `Directory is not empty`, `No workspace found there`,
`This workspace is already known`, `Path escapes the workspace`, `Absolute path not allowed`.

### 7. Cancel without a scheduler

- `JobHost.cancel` and `cancelAll` fall back to `cancelPending` in the database when no scheduler
  exists or it is stopping, settling a generation through the same helper the handler's `settled`
  uses (`settleGenerationOfJob` in core). Running rows during a stop stay as they are.
- `cancelAll` with a scheduler cancels only the jobs that existed when it was called: the second
  pass is limited to the ids collected before the wait.

### 8. Removing another workspace

`workspace:remove` notifies `workspaceClosing`/`workspaceOpened` only when the removed workspace is
the open one; the check runs inside the lifecycle queue.

## Tests

Each point gets a test that fails today: a remounted studio with a start in flight is disabled and
shows the typed prompt; a second `generations:start` in flight answers `busy`; trash leaves a running
generation job and cancels a queued one; the result of a trashed source lands in its former asset;
purge is refused while running; an import failure answers `generation_result_not_stored` and leaves
no row; one broken entry keeps the others and every key file; a totally unreadable file keeps every
key file; a key file whose origin differs yields no key and no request header; a bare key file is
rewritten and still works; none of the six messages contains the path; cancel and cancel all without
a scheduler end queued jobs and settle a generation; cancel all leaves a job enqueued during the
wait; removing a workspace that is not open sends no lifecycle notification.
