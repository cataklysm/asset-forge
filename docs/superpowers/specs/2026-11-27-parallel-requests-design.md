# Parallel requests per vision provider — design

Date: 2026-11-27. Status: approved. Size: a small change across contracts, jobs, main and renderer.

## Intent

Analysis jobs run in the resource class `local_gpu`, one at a time per provider entry. That fits a local
Ollama, but a vLLM server on a rented GPU batches requests and sits nearly idle with one request at a time, so
a large batch takes far longer than the server needs. The owner must be able to set how many analysis requests
an entry gets at once.

## Goals

- Every vision entry (`ollama`, `openai`) has a setting `Parallel requests`, 1–64, default 1.
- A saved value takes effect at once, also for jobs that already wait; no restart, no reopen.
- Lowering the value never aborts a running request; no new one starts until the lane is below the value.

## Non-goals

- A setting for image providers: `venice` stays at two generations at a time.
- A change to the download limits of the URL import, the class totals or the media worker pool.
- A setting in the environment mode (its one entry is read-only and runs one request at a time).
- Automatic tuning, a per-model value, a value chosen per analysis start.

## Approaches

1. **A per-lane limit the scheduler asks for on every pass (chosen).** The scheduler already recomputes the
   excluded lanes before every claim. An optional function answers the limit of one lane; the host answers it
   from the provider store. A provider save already resumes and wakes the lane, so the new value applies
   immediately.
2. **Recreate the scheduler with new limits on save.** Stops running jobs or needs a hand-over. Rejected.
3. **Raise the class limit of `local_gpu` globally.** One number for a local Ollama and a rented server is
   exactly what does not fit. Rejected.

## Design

### Contract (`packages/contracts/src/provider-settings.ts`)

- `PARALLEL_REQUESTS_MIN = 1`, `PARALLEL_REQUESTS_MAX = 64`, `PARALLEL_REQUESTS_DEFAULT = 1`.
- `ProviderOptionsSchema` gets `parallelRequests`: an integer in that range. `DEFAULT_PROVIDER_OPTIONS` carries
  the default. `options` stays `null` on `venice`.
- `VisionRequestOptions` is unchanged: the value is never part of a request body.

### Settings file (`provider-store.ts`)

The file stays version 4. A stored vision entry whose options lack `parallelRequests` reads as 1 (a default in
the stored-entry schema only, not in the IPC schema); a stored value outside the rule also reads as 1 and keeps
the entry. The first write stores the field. The upgrades from versions 1–3 give the default.
`providers:save` with options refuses a value outside the rule like every other schema violation of the
options (`invalid_request` from the IPC schema, `invalid_operation` from the store).

### Scheduler (`packages/jobs`)

`SchedulerOptions.laneLimit?(resourceClass, lane: string | null): number | undefined`. Where the scheduler
decides whether a lane is full, the limit is the function's answer when that is an integer of at least 1,
otherwise the class limit (`limits[rc]`); a function that throws counts as no answer (logged through `log`
with a fixed message). It is asked before every claim, so a changed answer applies on the next pass. Class
totals and the pause gate are unchanged. Without the option nothing changes.

### Main process

`JobHostDeps.laneLimit` with the same signature, passed to the scheduler. `composition.ts` wires it: for the
analysis class the `parallelRequests` of the vision entry with the lane's id, `undefined` for every other class,
an unknown lane or an entry without options. The existing `store.onChange` → `host.resume` already wakes the
scheduler after a save.

### Renderer (`ProviderSettings.tsx`)

A number input `Parallel requests` (label in `labels.ts`) with the vision option fields, tooltip
`Analysis requests sent at the same time`, min 1, max 64, step 1; handled like the timeout field (required,
out of range blocks Save the same way). Not shown for `venice`. No explanatory text.

## Tests

- Contracts: the range, the default.
- Store: a version 4 file without the field reads as 1 and is written with it; an out-of-range stored value
  reads as 1; save and list round-trip a value; save refuses 0, 65 and 1.5.
- Scheduler: with `laneLimit` 3 for lane A and none for lane B, three jobs of A and one of B run at once;
  raising the answer and `wake()` starts more without a restart; lowering it lets running jobs finish and
  starts none until below; answers 0, 2.5, NaN and a throw fall back to the class limit; a paused lane still
  claims nothing.
- Main: the composition answers the entry's value for the analysis class and `undefined` for a `venice` lane
  and an unknown lane; after a save with a higher value waiting jobs start (existing job-host test style, mock
  provider in-process).
- Renderer: the field shows the stored value, saves a changed one, blocks an invalid one and is absent for
  `venice`.

## Documentation

`ReadMe.md` where the job limits and provider options are described. `docs/backlog.md`: no setting in the
environment mode; with many parallel requests the media worker pool (which prepares the image of every request)
may become the bottleneck and is not configurable.
