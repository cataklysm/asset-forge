# Editable Analysis Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner keeps several named analysis prompts per purpose (tagging with a tag limit, Image to prompt), manages them in the settings and picks one in every analysis dialog.

**Architecture:** Prompts are app-level data in `userData/analysis-prompts.json`, owned by a store in the main process and reached through `analysisPrompts:*` channels that need no workspace. `analysis:enqueue` and `analysis:describe` take a `promptId`; the main process resolves it and hands name, text and limit to core, which copies them into job payload v3. Core composes the tagging request (owner text + limit line + fixed format line) and cuts the answer at the limit. The fingerprint does not change. The name of the prompt used is recorded on `file_analysis` and `file_analysis_proposal` (migration `0010`).

**Tech Stack:** TypeScript, Zod, better-sqlite3 + Drizzle (migration `0010`), Vitest (+ jsdom), React, Tailwind tokens.

**Spec:** `docs/superpowers/specs/2026-11-26-editable-prompts-design.md` — read it together with the task brief; it wins over this plan.

## Global Constraints

- Everything in the repository is English. No attribution lines in commits. Agents commit but do not push.
- Never launch the app, never call "Open externally"/"Show in folder", never touch host port 11434, never start, stop or remove Docker containers. Tests that need a key use the literal `test-key-not-real`.
- `core` and `contracts` do not import Electron, Drizzle or a provider. Renderer and preload hold no persistence logic.
- Error messages and log lines are fixed strings: no prompt text, prompt name, path, cause message or credential in them.
- The fingerprint stays checksum + provider + model + `ANALYSIS_PROMPT_VERSION`, and `ANALYSIS_PROMPT_VERSION` stays `1`. No prompt field enters `AnalysisFingerprint`, `analysisTargets.count` or `analysisTargets.page`.
- Limits, exact: name 1–60 characters after trimming; text 1–2000 characters after trimming; `maxTags` integer 1–50, built-in 15; at most 50 prompts per purpose; at least one prompt per purpose.
- Names are unique within a purpose compared with `toLowerCase()` after trimming.
- Payload v1 and v2 jobs keep running: they send the unchanged constant `ANALYSIS_PROMPT` and cut at 20 tags.
- Migration `0010` contains only `ALTER TABLE … ADD` statements.
- Everything new is named "analysis prompt" (`AnalysisPrompt`, `analysisPrompts:*`, `analysis-prompts.json`), never plain "prompt", to stay apart from the phase 5 prompt library.
- UI: no explanatory text in the layout (tooltips through `title`), buttons only from `BUTTON` / `ICON_BUTTON` / `BUTTON_INLINE` in `ui.ts`, tokens only, labels in `labels.ts`. `test/theme.test.ts` and `test/labels.test.ts` stay green.
- Commands: `pnpm --filter @assetforge/<package> test <file>` (no `--`), `pnpm typecheck`, `pnpm test`. After a schema change `pnpm --filter @assetforge/persistence db:generate`. Known flaky test, unrelated: `inbox.test.tsx > filters and scroll offset survive navigation`.
- Fixed messages used by more than one task:
  - `'The analysis prompt does not exist'` (`NotFoundError`) — unknown id, or an id of the other purpose.
  - `'An analysis prompt with this name already exists'`, `'No more than 50 analysis prompts per purpose'`, `'The last analysis prompt of a purpose cannot be deleted'`, `'The purpose of an analysis prompt cannot be changed'`, `'The analysis prompt is not valid'` (`InvalidOperationError`).
  - Log line: `'The analysis prompt used last could not be stored'`.

## Review Focus

1. A prompt text that ends in blank lines, is whitespace only, or is 2000 characters over many lines: whitespace only is refused, and for every accepted text the request ends with the limit line and the format line, in that order. → Task 1 (schema), Task 2 (composition).
2. The model answers more tags than the limit, repeats tags, or the limit is 1: the result holds at most `maxTags` distinct tags, counted after dropping repeats and unusable entries. → Task 2.
3. A prompt is deleted or edited while jobs with it wait, or while a dialog that has it selected is open: the waiting jobs run with the copied text; a start with the deleted id answers `not_found`, queues nothing and the dialog shows the error and falls back to another prompt. → Task 2, Task 4, Task 6.
4. A workspace from before this feature: queued v2 jobs run, and a proposal or analysis without a prompt name shows the model alone, without an empty label. → Task 1 (migration test), Task 2, Task 6.
5. `analysis-prompts.json` cannot be written when the prompt used last is stored (read-only profile, full disk): the analysis still starts and reports its counts. → Task 3, Task 4.

## Lanes

Task 1 runs first and alone. Then two lanes in parallel worktrees: **A** core (Task 2), **B** main-process store and channels (Task 3). After both are integrated, in parallel: Task 4 (main wiring) and lane **C** renderer (Tasks 5, 6). Last: Task 7 (acceptance and documentation).

Lane ownership: A edits `packages/core` and the two stopgap lines named in Task 2; B edits `apps/desktop/src/main/{analysis-prompts,analysis-prompt-handlers,atomic-file,vision-settings,ipc,composition}.ts`, `packages/contracts/src/ipc.ts` and its own tests; Task 4 edits `apps/desktop/src/main/{job-handlers,describe-controller,ipc,composition}.ts` and main-process tests; C edits only `apps/desktop/src/renderer` and `apps/desktop/test/renderer`.

---

### Task 1: Contracts, ports, migration `0010` and the recorded prompt name

**Files:**
- Create: `packages/contracts/src/analysis-prompts.ts`, `packages/contracts/test/analysis-prompts.test.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/jobs.ts`, `packages/contracts/src/analysis.ts`, `packages/contracts/src/ipc.ts`
- Modify: `packages/core/src/ports.ts`, `packages/core/src/analysis-proposals.ts`, `packages/core/src/analysis-handler.ts` (pass `promptName: null` only), `packages/core/test/fakes.ts` and any other fake of `FileAnalysisRepository`
- Modify: `packages/persistence/src/schema.ts`, `packages/persistence/src/file-analysis-repository.ts`, `packages/persistence/test/file-analysis-repository.test.ts`
- Create: `packages/persistence/migrations/0010_*.sql` (generated), `packages/persistence/test/migration-0010.test.ts`
- Modify: every fixture that builds a `ProposalView`, `Proposal` or `FileAnalysis` literal (typecheck finds them)

**Interfaces — produces:**

```ts
// packages/contracts/src/analysis-prompts.ts
export const ANALYSIS_PROMPT_NAME_MAX = 60;
export const ANALYSIS_PROMPT_TEXT_MAX = 2000;
export const ANALYSIS_TAG_LIMIT_MIN = 1;
export const ANALYSIS_TAG_LIMIT_MAX = 50;
export const ANALYSIS_TAG_LIMIT_DEFAULT = 15;
export const ANALYSIS_PROMPTS_PER_PURPOSE = 50;

export const AnalysisPromptPurposeSchema = z.enum(['tagging', 'image_prompt']);
export const AnalysisPromptNameSchema = z.string().trim().min(1).max(ANALYSIS_PROMPT_NAME_MAX);
export const AnalysisPromptTextSchema = z.string().trim().min(1).max(ANALYSIS_PROMPT_TEXT_MAX);
export const AnalysisTagLimitSchema = z.number().int().min(ANALYSIS_TAG_LIMIT_MIN).max(ANALYSIS_TAG_LIMIT_MAX);

/** Discriminated on `purpose`: only a tagging prompt has `maxTags`. */
export const AnalysisPromptSchema = z.discriminatedUnion('purpose', [
  z.object({ id: z.uuid(), purpose: z.literal('tagging'), name: AnalysisPromptNameSchema, text: AnalysisPromptTextSchema, maxTags: AnalysisTagLimitSchema }),
  z.object({ id: z.uuid(), purpose: z.literal('image_prompt'), name: AnalysisPromptNameSchema, text: AnalysisPromptTextSchema }),
]);
/** The same two shapes with `id: z.uuid().optional()`; without an id the prompt is created. */
export const SaveAnalysisPromptSchema = /* … */;
export const AnalysisPromptListSchema = z.object({
  prompts: z.array(AnalysisPromptSchema),
  lastUsed: z.object({ tagging: z.uuid().nullable(), imagePrompt: z.uuid().nullable() }),
});
// plus the inferred types AnalysisPromptPurpose, AnalysisPrompt, SaveAnalysisPrompt, AnalysisPromptList
```

```ts
// packages/contracts/src/jobs.ts — third member of AnalyzeFilePayloadSchema
export const AnalyzeFilePromptSchema = z.object({ name: AnalysisPromptNameSchema, text: AnalysisPromptTextSchema, maxTags: AnalysisTagLimitSchema });
export type AnalyzeFilePrompt = z.infer<typeof AnalyzeFilePromptSchema>;
z.object({ version: z.literal(3), model: ModelNameSchema, mode: z.enum(['apply', 'propose']), prompt: AnalyzeFilePromptSchema })
```

- `ProposalViewSchema`: `promptName: z.string().nullable()` added; `tags` `.max(50)`.
- `ipc.ts`: `analysis:acceptProposal` `names` `.max(50)`; `analysis:enqueue` and `analysis:describe` requests gain `promptId: IdSchema.optional()` (absent means the prompt used last for the purpose, otherwise the first; the main process ignores the field until Task 4). The four `analysisPrompts:*` channels are **not** added here (Task 3).
- `ports.ts`: `FileAnalysis.promptName: string | null`; `Proposal.promptName: string | null` (comment "at most 50"); `FileAnalysisRepository.apply` request gains `promptName: string | null`. `acceptProposal` copies the proposal's `promptName` into the analysis row.
- `schema.ts`: `promptName: text('prompt_name')` (nullable) on `fileAnalysis` and `fileAnalysisProposal`.
- `getProposal` (core) returns `promptName` in the view.

- [ ] **Step 1: Failing contract tests** in `packages/contracts/test/analysis-prompts.test.ts`:
  - `AnalysisPromptNameSchema` trims `'  General  '` to `'General'`, refuses `'   '` and 61 characters, accepts 60.
  - `AnalysisPromptTextSchema` refuses `' \n '` and 2001 characters, accepts 2000.
  - `AnalysisTagLimitSchema` accepts 1 and 50, refuses 0, 51 and 2.5.
  - `SaveAnalysisPromptSchema` refuses a tagging prompt without `maxTags`; an `image_prompt` input parses without `maxTags`.
  - `AnalyzeFilePayloadSchema` parses `{ version: 1 }`, a v2 payload and `{ version: 3, model: 'm', mode: 'apply', prompt: { name: 'General', text: 'x', maxTags: 15 } }`; refuses v3 without `prompt`.
  - `ProposalViewSchema` accepts 50 tags and `promptName: null`, refuses 51 tags.
- [ ] **Step 2:** Run `pnpm --filter @assetforge/contracts test analysis-prompts` — FAIL (module missing).
- [ ] **Step 3:** Implement the contracts above; export the new module from `index.ts`.
- [ ] **Step 4: Failing persistence tests.** `migration-0010.test.ts` (same shape as `migration-0009.test.ts`): a database migrated to `0009` with one `file_analysis` and one `file_analysis_proposal` row migrates to `0010`, both rows survive with `prompt_name` null. In `file-analysis-repository.test.ts`: `apply` with `promptName: 'General'` → `get` returns it; `propose` with `promptName: 'Detail'` → `getProposal` returns it; `acceptProposal` writes `'Detail'` to the analysis row; `apply` with `promptName: null` after a named one stores null.
- [ ] **Step 5:** Change `schema.ts`, run `pnpm --filter @assetforge/persistence db:generate`, check the migration holds exactly two `ALTER TABLE … ADD` statements, implement the repository and port changes, update fakes and fixtures. In `analysis-handler.ts` pass `promptName: null` to `apply` and `propose` for now.
- [ ] **Step 6:** `pnpm typecheck` and `pnpm test` — green.
- [ ] **Step 7:** Commit `feat: analysis prompt contracts, payload v3 and recorded prompt name`.

---

### Task 2 (lane A): Core — composition, enqueue, handler, describe

**Files:**
- Modify: `packages/core/src/analysis.ts`, `packages/core/src/analysis-enqueue.ts`, `packages/core/src/analysis-handler.ts`, `packages/core/src/index.ts` (exports)
- Modify (stopgap, one argument each): `apps/desktop/src/main/job-handlers.ts`, `apps/desktop/src/main/describe-controller.ts`
- Test: `packages/core/test/analysis.test.ts`, `analysis-enqueue.test.ts`, `analysis-describe.test.ts`, and the handler test in `packages/core/test/` or `packages/jobs/test/` that runs `createAnalyzeFileHandler` today

**Interfaces:**
- Consumes: `AnalyzeFilePrompt`, `AnalysisPromptPurpose`, payload v3, `promptName` on the ports (Task 1).
- Produces:

```ts
// analysis.ts
/** Sent verbatim by v1 and v2 jobs. Unchanged text. */
export const ANALYSIS_PROMPT: string;                 // as today
export const LEGACY_TAG_LIMIT = 20;
export const MAX_ANALYSIS_TAGS = 50;                  // was 20
export const ANALYSIS_FORMAT_LINE = 'Answer only with JSON of the form {"tags": ["...", "..."]}.';
/** The built-in content of a purpose: seed and reset target. `maxTags` is null for `image_prompt`. */
export function builtInAnalysisPrompt(purpose: AnalysisPromptPurpose): { text: string; maxTags: number | null };
/** `${text}\nGive at most ${maxTags} tags.\n${ANALYSIS_FORMAT_LINE}` */
export function composeTaggingRequest(p: { text: string; maxTags: number }): string;
export function cleanAnalysisTags(answer: unknown, limit: number): { name: string; displayName: string }[];

// analysis-enqueue.ts — `prompt` is required and written into payload v3
enqueueAnalysis(s, r: { target; model; mode; force; provider; prompt: AnalyzeFilePrompt }): Promise<EnqueueAnalysisResult>

// analysis-handler.ts — `prompt` is the text sent as it is
describeImage(deps, r: { fileId: string; model: string; prompt: string; signal: AbortSignal }): Promise<string>
```

- Built-in tagging text, exact (`maxTags` 15):

```text
Describe this image with short tags in English, all in lower case.
Cover what is shown, the materials and the dominant colours.
Include exactly one view tag, for example "front view", "side view", "three-quarter view", "top view" or "close-up".
Include exactly one style tag, for example "photorealistic", "stylized", "concept art", "line drawing" or "pixel art".
```

- Built-in Image to prompt text: today's `IMAGE_PROMPT`, unchanged; `builtInAnalysisPrompt('image_prompt')` returns it with `maxTags: null`.
- Handler: v3 sends `composeTaggingRequest(payload.prompt)`, cuts with `cleanAnalysisTags(answer, payload.prompt.maxTags)` and records `promptName: payload.prompt.name`; v1 and v2 send `ANALYSIS_PROMPT`, cut at `LEGACY_TAG_LIMIT` and record `promptName: null`.

- [ ] **Step 1: Failing tests.**
  - `analysis.test.ts`: `composeTaggingRequest({ text: 'Look at the armour.', maxTags: 25 })` equals `'Look at the armour.\nGive at most 25 tags.\n' + ANALYSIS_FORMAT_LINE`; `cleanAnalysisTags({ tags: ['a','A','b','',3,'c'] }, 2)` returns the tags `a` and `b`; with limit 1 one tag; 60 distinct tags with limit 50 → 50; `builtInAnalysisPrompt('tagging').maxTags === 15` and its text contains neither `'JSON'` nor a digit followed by `' tags'`; `builtInAnalysisPrompt('image_prompt')` is `{ text: IMAGE_PROMPT, maxTags: null }`.
  - `analysis-enqueue.test.ts`: enqueue with `prompt: { name: 'Detail', text: 'T', maxTags: 30 }` writes payload `{ version: 3, model, mode, prompt }` on every job; a file analysed with prompt A is counted `alreadyAnalysed` for prompt B without `force` and enqueued with `force`; `previewAnalysis` takes no prompt.
  - Handler test: a v3 job sends a request text that ends with `'Give at most 3 tags.\n' + ANALYSIS_FORMAT_LINE`, applies at most 3 tags from an answer of 10 and stores `promptName: 'Detail'` (mode `apply` on the analysis, mode `propose` on the proposal); a v2 job sends exactly `ANALYSIS_PROMPT`, keeps up to 20 of 30 answered tags and stores `promptName: null`; a v1 job likewise with the default model.
  - `analysis-describe.test.ts`: the provider receives exactly the `prompt` passed in.
- [ ] **Step 2:** Run the four files — FAIL.
- [ ] **Step 3:** Implement. In `job-handlers.ts` pass `prompt: { name: 'Default', text: builtInAnalysisPrompt('tagging').text, maxTags: 15 }` and in `describe-controller.ts` pass `prompt: IMAGE_PROMPT`, each marked `// Stopgap until the prompt store is wired (Task 4).`
- [ ] **Step 4:** `pnpm --filter @assetforge/core test`, `pnpm --filter @assetforge/jobs test`, `pnpm --filter @assetforge/desktop test analysis`, `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat: compose the tagging request from an analysis prompt`.

---

### Task 3 (lane B): Main process — the analysis prompt store and its channels

**Files:**
- Create: `apps/desktop/src/main/atomic-file.ts` (`writeAtomic` moved out of `vision-settings.ts`, same behaviour), `apps/desktop/src/main/analysis-prompts.ts`, `apps/desktop/src/main/analysis-prompt-handlers.ts`
- Modify: `apps/desktop/src/main/vision-settings.ts` (import `writeAtomic`), `apps/desktop/src/main/ipc.ts` (`AppServices`, spread the handlers next to `services.settings`), `apps/desktop/src/main/composition.ts`, `packages/contracts/src/ipc.ts`
- Test: `apps/desktop/test/analysis-prompts.test.ts`, `apps/desktop/test/analysis-prompts-ipc.test.ts` (modelled on `settings-ipc.test.ts`)

**Interfaces:**
- Consumes: the contracts of Task 1. Until lane A is integrated, the built-in content comes through the `builtIn` option below, so this lane does not import `builtInAnalysisPrompt`; `composition.ts` passes a local stand-in marked `// Replaced by builtInAnalysisPrompt in Task 4.`
- Produces:

```ts
// analysis-prompts.ts
export const ANALYSIS_PROMPTS_FILE = 'analysis-prompts.json';
export const DEFAULT_PROMPT_NAME = 'Default';
export const LAST_USED_WRITE_FAILED = 'The analysis prompt used last could not be stored';

export interface AnalysisPromptStore {
  list(): AnalysisPromptList;
  save(input: SaveAnalysisPrompt): AnalysisPrompt;
  remove(id: string): void;
  /** Text (and `maxTags`) back to the built-in content of its purpose; the name stays. */
  reset(id: string): AnalysisPrompt;
  /** The prompt of `purpose` with `id`; without an id the one used last, otherwise the first. `NotFoundError` for an unknown id or one of the other purpose. */
  resolve<P extends AnalysisPromptPurpose>(purpose: P, id: string | undefined): Extract<AnalysisPrompt, { purpose: P }>;
  /** Best effort: a failed write logs `LAST_USED_WRITE_FAILED` and never throws. */
  markUsed(prompt: AnalysisPrompt): void;
}
export function createAnalysisPromptStore(o: {
  userData: string;
  newId: () => string;
  builtIn: (purpose: AnalysisPromptPurpose) => { text: string; maxTags: number | null };
  log: (line: string) => void;
}): AnalysisPromptStore;

// analysis-prompt-handlers.ts
export type AnalysisPromptHandlers = Pick<IpcHandlers, 'analysisPrompts:list' | 'analysisPrompts:save' | 'analysisPrompts:delete' | 'analysisPrompts:reset'>;
export function createAnalysisPromptHandlers(store: AnalysisPromptStore): AnalysisPromptHandlers;

// ipc.ts (main): AppServices gains
analysisPrompts: AnalysisPromptHandlers;
prompts: AnalysisPromptStore;
```

- Channels (contracts): `analysisPrompts:list` (`EmptyRequestSchema` → `AnalysisPromptListSchema`), `analysisPrompts:save` (`SaveAnalysisPromptSchema` → `AnalysisPromptSchema`), `analysisPrompts:delete` (`{ id: IdSchema }` → `{}`), `analysisPrompts:reset` (`{ id: IdSchema }` → `AnalysisPromptSchema`). Not behind the workspace guard.
- File content: `{ "version": 1, "prompts": [...], "lastUsed": { "tagging": id | null, "imagePrompt": id | null } }`, validated with Zod on load. Loaded lazily on first use, like the vision settings.
- Behaviour: a missing file starts empty; a file that does not parse or validate is renamed to `<file>.corrupt-<stamp>` and starts empty; any other read error is thrown. After loading, every purpose without a prompt gets one named `Default` with the built-in content, and the seeded state is written at once (a failed write is thrown). `list` keeps file order; a `lastUsed` id that no longer exists reads as null. `save` with an id keeps the position; a different `purpose` than stored is refused. `remove` of the prompt used last sets that `lastUsed` to null. Input is parsed again in the store; a parse failure is `'The analysis prompt is not valid'`.

- [ ] **Step 1: Failing store tests** (`analysis-prompts.test.ts`, a temp directory per test, `newId` a counter of UUIDs, `builtIn` a fixed fake):
  - first `list()` returns one `Default` per purpose (tagging with `maxTags` 15), `lastUsed` both null, and the file exists; a second store on the same directory returns the same ids.
  - a file with only an `image_prompt` entry gets a tagging `Default` added and keeps the existing entry.
  - a file holding `not json`, and one holding `{ "version": 2 }`, are renamed to `analysis-prompts.json.corrupt-*` and replaced by the seed.
  - `save` without id appends; with id replaces in place; `'general'` next to `'General'` and `'  General '` next to `'General'` are refused with `'An analysis prompt with this name already exists'`; renaming `'General'` to `'GENERAL'` on itself succeeds; the same name in the other purpose succeeds.
  - the 51st prompt of a purpose is refused with `'No more than 50 analysis prompts per purpose'`.
  - `save` with an unknown id → `NotFoundError('The analysis prompt does not exist')`; with a stored id but the other purpose → `'The purpose of an analysis prompt cannot be changed'`.
  - `remove` of the only prompt of a purpose → `'The last analysis prompt of a purpose cannot be deleted'`; of an unknown id → `NotFoundError`; of the prompt used last → `list().lastUsed` null for that purpose.
  - `reset` restores text and `maxTags` from `builtIn`, keeps name and id.
  - `resolve('tagging', id)` returns it; with an `image_prompt` id → `NotFoundError`; with `undefined` → the prompt used last, and the first one when none was used.
  - `markUsed` persists across a new store; when the write fails (make the file path a directory, or stub through an injected seam of your choice) it calls `log` once with exactly `LAST_USED_WRITE_FAILED` and does not throw.
  - no temporary `*.tmp` file is left after a save.
- [ ] **Step 2: Failing IPC tests** (`analysis-prompts-ipc.test.ts`): the four channels answer without an open workspace; a save with a 61-character name is rejected by request validation; a duplicate name answers `invalid_operation` with the fixed message; delete of an unknown id answers `not_found`.
- [ ] **Step 3:** Run both — FAIL.
- [ ] **Step 4:** Implement: `atomic-file.ts`, the store, the handlers, the four channels in the contract, `AppServices` and `createAnalysisServices` (store built with `userData: o.userDataPath`, `newId: randomUUID`, `log: o.log`).
- [ ] **Step 5:** `pnpm --filter @assetforge/contracts test`, `pnpm --filter @assetforge/desktop test analysis-prompts`, `test vision-settings`, `test settings-ipc`, `test ipc`, `pnpm typecheck` — green. Renderer tests whose fake API enumerates channels are fixed here if typecheck demands it, with handlers that reject.
- [ ] **Step 6:** Commit `feat: app-level analysis prompt store and channels`.

---

### Task 4: Main process — resolve the prompt for enqueue and describe

Runs after lanes A and B are integrated.

**Files:**
- Modify: `apps/desktop/src/main/job-handlers.ts`, `apps/desktop/src/main/describe-controller.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/composition.ts`
- Test: `apps/desktop/test/analysis-harness.ts`, `apps/desktop/test/jobs-ipc.test.ts`, `apps/desktop/test/describe.test.ts`

**Interfaces:**
- Consumes: `AnalysisPromptStore` (Task 3), `enqueueAnalysis` with `prompt`, `describeImage` with `prompt`, `builtInAnalysisPrompt` (Task 2).
- Produces: `createJobHandlers(manager, jobs, describe, prompts: AnalysisPromptStore)`; `DescribeController.describe(r: { requestId; fileId; model; prompt: string })`; `composition.ts` passes `builtIn: builtInAnalysisPrompt`; both stopgaps of Task 2 and the stand-in of Task 3 are gone.
- `analysis:enqueue`: `prompts.resolve('tagging', r.promptId)` first (a `NotFoundError` rejects the call, nothing is queued), then `enqueueAnalysis` with `{ name, text, maxTags }`, then `prompts.markUsed(prompt)` whenever the use case returned, whatever its counts.
- `analysis:describe`: `prompts.resolve('image_prompt', r.promptId)` first (rejects with `not_found`), then the controller with `prompt.text`; `markUsed` after the controller answered, unless the answer is `{ ok: false, code: 'busy' }`. Without an open workspace the call rejects with `no_workspace_open` and nothing is marked.

- [ ] **Step 1: Failing tests.**
  - `jobs-ipc.test.ts`: enqueue with the id of a second tagging prompt (`text: 'Only armour.'`, `maxTags: 3`) stores a v3 payload with that name, text and limit, and `analysisPrompts:list` then reports it as `lastUsed.tagging`; enqueue without `promptId` uses the prompt used last; enqueue with an unknown id and with an `image_prompt` id answer `not_found` and no job exists afterwards; enqueue of an already analysed file without `force` (`enqueued: 0`) still sets `lastUsed`; with the prompts file made unwritable after seeding the enqueue still returns its counts.
  - Same file or `analysis-acceptance.test.ts`: a job queued with prompt P, then P edited through `analysisPrompts:save` and, in a second case, deleted — the mock provider receives the text as it was when queued (assert on the request the mock recorded, or on a fake vision in the harness).
  - `describe.test.ts`: the provider receives the chosen prompt's text; a successful and a provider-failed describe set `lastUsed.imagePrompt`; a `busy` answer and an unknown id do not; an unknown id rejects with `not_found`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** `pnpm --filter @assetforge/desktop test` (main-process files) and `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat: resolve the chosen analysis prompt for enqueue and describe`.

---

### Task 5 (lane C): Renderer — prompts context and the Prompts section of the settings

**Files:**
- Create: `apps/desktop/src/renderer/src/analysis-prompts-context.tsx`, `apps/desktop/src/renderer/src/components/PromptSettings.tsx`
- Modify: the provider tree where `ProviderSettingsProvider` is mounted, `screens/SettingsScreen.tsx`, `labels.ts`
- Test: `apps/desktop/test/renderer/analysis-prompts-context.test.tsx`, `apps/desktop/test/renderer/prompt-settings.test.tsx`, `fake-api.ts`, `fixtures.ts`

**Interfaces — produces:**

```ts
export interface AnalysisPromptsState {
  /** Null until the first answer, or when loading failed. */
  prompts: AnalysisPrompt[] | null;
  lastUsed: { tagging: string | null; imagePrompt: string | null };
  loading: boolean;
  /** True when the last load failed. */
  failed: boolean;
  reload(): Promise<void>;
  save(input: SaveAnalysisPrompt): Promise<AnalysisPrompt>;
  remove(id: string): Promise<void>;
  reset(id: string): Promise<AnalysisPrompt>;
  /** Records locally what the main process stored after a start, so the next dialog preselects it. */
  noteUsed(purpose: AnalysisPromptPurpose, id: string): void;
}
export function AnalysisPromptsProvider(props: { children: ReactNode }): JSX.Element;
export function useAnalysisPrompts(): AnalysisPromptsState;
/** The prompt a dialog preselects: the one used last when it still exists, otherwise the first of the purpose; null when there is none or nothing is loaded. */
export function defaultPromptId(state: Pick<AnalysisPromptsState, 'prompts' | 'lastUsed'>, purpose: AnalysisPromptPurpose): string | null;
```

- The context loads once on mount (superseding like `provider-context.tsx`), and `save`/`remove`/`reset` update the list from the answer without a second round trip (`remove` also clears a matching `lastUsed`).
- `PromptSettings`: heading `Prompts`; per purpose (`Tagging`, `Image to prompt`) a list of names and a `New` button; the selected entry's editor with `Name` (`maxLength` 60), `Tag limit` (number, 1–50, tagging only), the text area (`maxLength` 2000) and `Save`, `Reset`, `Delete`. Edits in place.
  - `New` saves a prompt at once with the built-in content of the purpose — taken from the `Default`-seeded reset path: create it with the text of the first prompt of that purpose and then call `reset` — under the first free name of `New prompt`, `New prompt 2`, …, and selects it.
  - A draft per entry lives as long as the screen is mounted; switching entries does not lose it. An entry with an unsaved draft carries a marker with the tooltip `Unsaved changes`. `Save` is disabled without changes or while the draft is invalid (empty name or text, limit outside 1–50), with the reason as tooltip.
  - `Reset` asks nothing and replaces the draft with the answer. `Delete` asks through `ConfirmDialog` and is disabled, with the tooltip `The last prompt cannot be deleted`, for the only prompt of a purpose.
  - A refused action shows the fixed message in an `ALERT`. A failed load shows the alert with a retry icon button, as the provider settings do.
  - The section is rendered in every state of the settings screen, including the environment mode and without a configured provider.

- [ ] **Step 1: Failing tests.** Context: loads and exposes list and `lastUsed`; a failed load sets `failed` and `reload` recovers; `save` of a new prompt appends, of an existing one replaces; `remove` drops it and clears a matching `lastUsed`; `noteUsed` changes `lastUsed`; `defaultPromptId` returns the one used last, the first of the purpose when that id is gone, null when nothing is loaded. Settings section: both lists render; selecting shows the editor (no tag limit field for Image to prompt); editing and `Save` calls `analysisPrompts:save` with the trimmed values; a draft survives switching to another entry and back, with the marker shown meanwhile; `New` creates `New prompt`, then `New prompt 2`; `Reset` calls the channel and shows the returned text; `Delete` confirms, then calls the channel; `Delete` is disabled for the only prompt; a refused save shows its message; the section is present when `fromEnvironment` is true. `labels.test.ts` and `theme.test.ts` stay green.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** `pnpm --filter @assetforge/desktop test renderer` and `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat: manage analysis prompts in the settings`.

---

### Task 6 (lane C): Renderer — the prompt choice in the three dialogs

**Files:**
- Create: `apps/desktop/src/renderer/src/components/PromptSelect.tsx`
- Modify: `components/AnalysisStartDialog.tsx`, `components/AnalysisResultDialog.tsx`, `components/PromptDialog.tsx`, `provider-gate.ts`, `labels.ts`
- Test: `apps/desktop/test/renderer/analysis-start-dialog.test.tsx`, `analysis-result-dialog.test.tsx`, `prompt-dialog.test.tsx`, plus a `provider-gate` test beside the existing one

**Interfaces:**
- Consumes: `useAnalysisPrompts`, `defaultPromptId` (Task 5); `promptId` on both channels; `ProposalView.promptName`.
- Produces:

```ts
// PromptSelect.tsx — label "Prompt", one option per prompt of the purpose showing its name;
// a tagging option's `title` is `Tag limit <n>`.
export function PromptSelect(props: { purpose: AnalysisPromptPurpose; value: string | null; onChange(id: string): void; disabled?: boolean }): JSX.Element;

// provider-gate.ts — why nothing can start with this prompt, as the start button's tooltip; null when it can.
export function promptGate(state: Pick<AnalysisPromptsState, 'prompts' | 'loading' | 'failed'>, promptId: string | null): string | null;
```

- `promptGate`: failed load → `PROMPTS_LOAD_FAILED` (`'The prompts could not be loaded'`); not loaded yet → `START_LOADING`; `promptId` null or not in the list → `CHOOSE_PROMPT` (`'Choose a prompt'`). Each dialog's `blocked` is `providerBlocked ?? promptGate(...) ?? <its own reasons>`.
- Each dialog keeps the owner's choice like the model choice (null until chosen, then `defaultPromptId` is in force; reset on every opening), places `PromptSelect` directly below `ModelSelect`, sends `promptId` and calls `noteUsed` after an accepted start (for describe: after any answer but `busy`).
- A start refused with `not_found` shows the error, calls `reload()` and drops the owner's choice, so the dialog falls back to an existing prompt.
- `AnalysisResultDialog`: where it shows `proposal.model`, it shows `proposal.promptName` after it when not null, and nothing extra when null. `proposalKey` includes `promptName`.
- The preview of the start dialog does not depend on the prompt: changing the prompt sends no `analysis:preview`.

- [ ] **Step 1: Failing tests.** For each of the three dialogs: the select lists the prompts of its purpose only; the prompt used last is preselected; with a `lastUsed` id that is gone the first is preselected; choosing another and starting sends its `promptId`; `noteUsed` was called, so reopening preselects it; a failed prompt load disables the start with `'The prompts could not be loaded'`; a start rejected with `not_found` shows the message and the select falls back. Start dialog: changing the prompt triggers no further `analysis:preview`. Result dialog: a proposal with `promptName: 'Detail'` shows `Detail` beside the model, one with null shows the model only. Prompt dialog: a `busy` answer does not call `noteUsed`. `promptGate` unit cases as listed above.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** `pnpm --filter @assetforge/desktop test renderer` and `pnpm typecheck` — green.
- [ ] **Step 5:** Commit `feat: choose the analysis prompt in the analysis dialogs`.

---

### Task 7: Acceptance and documentation

**Files:**
- Modify: `apps/desktop/test/analysis-acceptance.test.ts`, `ReadMe.md`, `docs/backlog.md`, `docs/superpowers/specs/2026-11-26-editable-prompts-design.md`

- [ ] **Step 1: Acceptance test** against the harness with the mock provider on its usual seam: create a tagging prompt with `maxTags: 2` through the channel, enqueue one image with it, run the job, and assert the file carries at most 2 AI tags, `file_analysis.prompt_name` is the prompt's name, and a second enqueue with the `Default` prompt and without `force` reports `alreadyAnalysed: 1`; the same with `force: true` enqueues it and the record then carries `Default`. A `propose` run shows the prompt name in `analysis:getProposal`.
- [ ] **Step 2:** `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build` — green.
- [ ] **Step 3: ReadMe.** The analysis section (named analysis prompts, the composed request, the tag limit, the unchanged fingerprint and what "Analyse again" means for another prompt, payload v3, the recorded name), the settings section and `userData` layout (`analysis-prompts.json`), the IPC list (four channels, `promptId`), the schema section (`prompt_name`), and one sentence in §7 that tells analysis prompts apart from the prompt library.
- [ ] **Step 4:** `docs/backlog.md`: remove "Editable analysis prompts" from the requested features; add a section "Editable prompts" for what the reviews deferred. Design doc: status to implemented, with a "Changed during the build" note (at least: `promptId` is optional and falls back to the prompt used last).
- [ ] **Step 5:** Commit `docs: analysis prompts`.
