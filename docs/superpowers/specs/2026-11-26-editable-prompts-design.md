# Editable analysis prompts — named prompts chosen at the analysis start — design

Status: approved by the owner, 2026-11-26; implemented 2026-11-26.

## Changed during the build

- `promptId` is optional on `analysis:enqueue` and `analysis:describe`: without one the prompt used last for the purpose runs, otherwise the first of the purpose.
- `analysisPrompts:save` is discriminated on `purpose`: `maxTags` is required for `tagging` and not part of an `image_prompt` request, rather than optional. A request outside the limits is refused by the IPC validation as `invalid_request`; the store's own check (`invalid_operation`, "The analysis prompt is not valid") sits behind it.
- Without an open workspace `analysis:enqueue` and `analysis:describe` answer `no_workspace_open` before the `promptId` is resolved.
- A describe that answers `cancelled` marks its prompt as used, also when it was refused during a workspace open or close without starting a request; only `busy` and a rejected call do not.
- Version 1 and 2 jobs record `prompt_name` as `null`.
- New in the Prompts section saves a prompt and then resets it, because the renderer does not know the built-in text.
- A failed prompt load reads "The analysis prompts could not be read". While the prompts load, the dialogs' start tooltip is the provider wording "The provider settings are loading" (backlog).

## Intent

The two texts sent to the vision provider — one for tagging, one for Image to prompt — are constants in `packages/core/src/analysis.ts`. The tags they produce are too general for the owner's work ("woman", "man" are not useful tags), and sometimes a set of images needs finer tags than the rest. The owner wants to write these texts themselves, to set the upper limit of tags, and to switch between several texts without a detour through the settings.

## Goals

- Several **named prompts** per purpose (`tagging`, `image_prompt`), created, edited, renamed and deleted in the app.
- A tagging prompt carries its own **tag limit**.
- The prompt is **chosen where an analysis starts**: the start dialog, the single-image result dialog and the Image to prompt dialog. The prompt used last for that purpose is preselected.
- A prompt can be **reset** to the built-in text.
- The answer format stays fixed in the code: the owner edits what the model should look for, not how it must answer.

## Non-goals

- A prompt per asset type, per project or per workspace.
- A history of prompt versions, import or export of prompts.
- Placeholders or variables inside a prompt.
- A tag vocabulary appended to the prompt (owner decision from the tag feature: no growing tag list in prompts).
- One tag set per prompt on a file. A file keeps one set of AI tags and one waiting proposal, as today.
- Choosing the provider in the same dialogs — that is the separate "several vision providers" feature; this design only leaves room for it next to the prompt choice.

## Anti-goals

- An edited, renamed, added or differently chosen prompt that makes files already analysed count as not analysed. Earlier results do not become bad because a prompt changed; a re-analysis stays the owner's explicit choice ("Analyse again").
- A prompt edit that breaks the parsing of answers, so that an analysis silently yields no tags.
- A queued job whose outcome changes because a prompt was edited or deleted after the job was queued.
- Prompt text in error messages or logs.

## Constraints

- `CLAUDE.md` architecture rules: `core` and `contracts` without Electron; validated IPC; fixed error messages; app-level files written atomically in `userData`.
- UI rules: no explanatory text in the layout (tooltips through `title`), buttons from `ui.ts`, tokens only.
- The analysis answer is untrusted and is cleaned as today (`cleanAnalysisTags`); manual tags win over AI tags.
- Jobs already queued with payload version 1 or 2 must still run.

## Approaches

1. **One editable prompt per purpose, in the settings.** Least surface. But finer tags for one series of images would mean rewriting the text in the settings and rewriting it back afterwards — the detour the owner rejected for the provider choice.
2. **Several named prompts, chosen in the analysis dialogs (chosen by the owner).** The owner keeps, for example, "General" and "Characters, detailed", each with its own text and tag limit, and picks one at the start. Costs a small management surface and one more field in three dialogs.
3. **A prompt per asset type.** Automatic, but rigid: inbox files have no asset, and one type still has only one text.

## Design

### The prompt

A prompt has an `id` (UUID), a `purpose` (`tagging` | `image_prompt`), a `name` (1–60 characters after trimming, unique within its purpose regardless of case), a `text` (1–2000 characters) and, for `tagging` only, `maxTags` (integer 1–50, default 15). At most 50 prompts per purpose. Every purpose always has at least one prompt; deleting the last one is refused.

Built-in texts stay in `packages/core/src/analysis.ts` as the seed and the reset target:

- Tagging: the present instructions without the sentence about the number of tags and without the JSON line (short English lower-case tags; what is shown, materials, dominant colours; one view tag; one style tag). Built-in `maxTags`: 15.
- Image to prompt: the present text unchanged.

### What is sent

For tagging the app composes the request text: the prompt's `text`, then a line stating the limit (`Give at most <maxTags> tags.`), then the fixed format line (`Answer only with JSON of the form {"tags": ["...", "..."]}.`). `ANALYSIS_SCHEMA` is passed as today. The cleaned answer is cut at `maxTags`. `MAX_ANALYSIS_TAGS` becomes the upper bound 50; `ProposalViewSchema.tags` allows 50.

For Image to prompt the prompt's `text` is sent as it is. `MAX_PROMPT_TEXT` for the answer is unchanged.

### Fingerprint

Unchanged: checksum + provider + model + `ANALYSIS_PROMPT_VERSION`, and the constant stays `1`. The prompt is deliberately not part of it (owner decision). A file analysed with one prompt is "already analysed" for every prompt of the same model; "Analyse again" (`force`) redoes it. `analysis:preview` therefore does not depend on the prompt.

### Storage

App-level, in `userData/analysis-prompts.json`, next to `provider-settings.json` and written the same way (temporary file, rename; a file that cannot be parsed is renamed to `.corrupt-<stamp>` and replaced by the seed). Content: the list of prompts and, per purpose, the ID of the prompt used last. On first start, and whenever a purpose has no prompt, the built-in prompt of that purpose is seeded under the name `Default`.

The prompts do not live in the workspace database: they describe how the owner works, not a workspace (author's call, stated to the owner).

### Jobs

`vision.analyze_file` gets payload version 3: `{ version: 3, model, mode, prompt: { name, text, maxTags } }`. The prompt is copied into the payload when the job is queued, so later edits or a deletion do not change or break a queued job, and the handler needs no access to the app-level store (author's call). Version 1 and 2 payloads run with the built-in tagging text and the limit 20, as they were queued.

The copy costs up to 2000 characters per job. Job views do not carry the prompt to the renderer.

One active job per file stays the rule (dedupe key `vision.analyze_file:<fileId>`). A file already queued with another prompt counts as `alreadyQueued` and keeps the prompt it was queued with; the queued job is not rewritten (author's call). The recorded prompt name makes visible which prompt a result came from.

### Recorded prompt name

Migration `0010` adds a nullable `prompt_name` to `file_analysis` and `file_analysis_proposal`; the handler writes the payload's prompt name with the result, and rows from before stay `null`. `ProposalViewSchema` gains `promptName: string | null`. The name is a record of what was used, not a reference: renaming or deleting the prompt later does not change it (author's call).

### Relation to the prompt library

The prompt library of ReadMe §7.1 (phase 5: versioned workspace entities with variables, for generation) is a different thing. These are app-level analysis instructions. To keep the names apart, everything here is called "analysis prompt": the type `AnalysisPrompt`, the channels `analysisPrompts:*`, the file `analysis-prompts.json`. The ReadMe gets a sentence telling the two apart (author's call).

### IPC (`packages/contracts`)

Channels that work without a workspace, like the settings channels:

- `analysisPrompts:list` → `{ prompts, lastUsed: { tagging, imagePrompt } }`.
- `analysisPrompts:save` `{ id?, purpose, name, text, maxTags? }` → the saved prompt. Without `id` it creates one. Refusals: `invalid_operation` for a name already used in that purpose or the limit of 50 prompts, `not_found` for an unknown `id`. The purpose of an existing prompt cannot change.
- `analysisPrompts:delete` `{ id }` → `invalid_operation` for the last prompt of a purpose, `not_found` for an unknown one.
- `analysisPrompts:reset` `{ id }` → the prompt with the built-in text (and limit) of its purpose; the name stays.

Changed channels:

- `analysis:enqueue` gains an optional `promptId`; without one the prompt used last for the purpose is taken, otherwise the first. The main process resolves it to a `tagging` prompt and hands name, text and limit to the core use case. An unknown ID or one of the wrong purpose is rejected with `not_found` before anything is queued.
- `analysis:describe` gains an optional `promptId` (an `image_prompt` prompt), with the same fallback. An unknown or wrong-purpose ID is a rejected call with `not_found`, not a `{ ok: false }` result; `DescribeResult` is unchanged.

**Used last** (author's call): the prompt is stored as used last once the request was accepted — for enqueue when the use case returned, whatever its counts (also with nothing newly queued); for describe when the request was started, whatever its outcome, but not when it answered `busy`. Writing it is best effort: a failed write is logged with one fixed warning and never turns an accepted analysis into an error.

### Core

`enqueueAnalysis` takes the prompt (`name`, `text`, `maxTags`) as an argument and writes payload v3. The handler composes the request text from the payload and cuts at the payload's limit. `describeImage` takes the text as an argument. `cleanAnalysisTags` takes the limit. Validation of a prompt (lengths, range) is a pure function in `core` or a Zod schema in `contracts`, used by the store in the main process.

### Renderer

**Settings.** A section `Prompts` below the provider settings with two lists, `Tagging` and `Image to prompt`. Selecting an entry shows its editor: name, text (multi-line), for tagging the tag limit, and the actions Save, Reset, Delete; New adds a prompt with the built-in text. Unsaved changes are kept until Save, as in the provider form. The section is available in the environment mode of the provider settings too.

```
Prompts
  Tagging                         Name       [ Characters, detailed      ]
  ┌──────────────────────────┐   Tag limit  [ 25 ]
  │ Default                  │   ┌──────────────────────────────────────┐
  │ Characters, detailed   ◀ │   │ Describe the person precisely: ...   │
  └──────────────────────────┘   └──────────────────────────────────────┘
  [ New ]                         [ Save ] [ Reset ] [ Delete ]
  Image to prompt
  ...
```

**Dialogs.** The start dialog, the single-image result dialog and the Image to prompt dialog get a prompt select next to the model select, preselected with the prompt used last for that purpose (the first of the list when that one no longer exists). A purpose with exactly one prompt still shows the select, so the owner always sees what will be sent. The select shows names only; the tooltip of an entry shows its tag limit.

```
Analyse 37 files
  Model   [ qwen3.5:9b            ▾ ]
  Prompt  [ Characters, detailed  ▾ ]
  To analyse 31 · Already analysed 6 · ...
  [ ] Analyse again                         [ Cancel ] [ Start ]
```

The result dialog shows the name of the prompt a proposal was made with next to its model (see "Recorded prompt name"). The Jobs screen does not change: it shows no model today and gets no prompt column (author's call).

### Error handling

Fixed messages only. A prompt file that cannot be read or written (other than the corrupt case above) fails the `analysisPrompts:*` call like a failed provider-settings call does today, as `internal_error`. A failed `analysisPrompts:list` blocks the start in the dialogs as its own state, in the way `provider-gate.ts` treats a failed settings load.

### Documentation

ReadMe: the analysis section (prompts, composition, tag limit, fingerprint rule), the settings section, the IPC list, the job payload. `docs/backlog.md`: remove the request, add what the reviews defer. `CLAUDE.md` project state.

## Testing

- Contracts and core: prompt validation (lengths, limit range, unique names regardless of case, last prompt not deletable, 50 per purpose); the composed tagging text for a prompt; the cut at `maxTags` for 1, 15 and 50; payload v1 and v2 still run with the built-in text and limit 20; a job queued with a prompt that is edited or deleted afterwards runs with the copied text.
- Fingerprint: a file analysed with prompt A is skipped for prompt B and for an edited A without `force`, and redone with `force`.
- Persistence: migration `0010` on a database with existing analysis and proposal rows; the prompt name is written with an analysis and a proposal and read back in the proposal view.
- Main process: seeding on first start and after a purpose lost its prompts; a corrupt file is set aside and reseeded; last used is stored after an accepted enqueue (also with nothing newly queued) and a started describe, not after `not_found` or `busy`; a failed last-used write does not fail the call; an unknown or wrong-purpose `promptId` is rejected with `not_found` and queues nothing; a file already queued keeps its prompt; the channels work without an open workspace.
- Renderer (jsdom): the settings section (create, edit, save, reset, delete, the refusals); the three dialogs preselect the prompt used last and send the chosen `promptId`; nothing but names in the layout.

## Left to the builder

- The exact wording of the built-in tagging text after the count sentence is removed, and of the limit line.
- Whether the store is one module beside `vision-settings.ts` or shares its file helpers.
- Whether the settings section edits in place or in a dialog, and the labels, following `labels.ts`.
- Whether a renderer context caches `prompts:list` like the provider context does.
