# Prompt Library (Phase 5b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prompts become versioned workspace entities with title, description, tags and `{{variables}}`; the generation studio can start an edit from a prompt version, and the generation records which version and which values produced it.

**Architecture:** The template rules (finding variables, resolving) are pure functions in `packages/contracts`, so the main process and the renderer use the same code. Use cases live in `packages/core/src/prompts.ts` behind a new port `PromptRepository` (`database.prompts`); SQLite tables come with migration `0014`. `generations:start` gets a second form (`promptVersionId` + `variables`) that core resolves itself; the renderer never sends a resolved text together with a version reference.

**Tech Stack:** TypeScript, Zod 4, better-sqlite3 + Drizzle, Electron IPC, React, Vitest (+ jsdom).

**Spec:** `docs/superpowers/specs/2026-11-27-prompt-library-design.md` (read it; its section "Amendments from planning" records the six points where this plan settles something the design left open or got wrong).

## Global Constraints

### Repository and commits

- Everything written into the repository is English. Commit messages have no attribution lines.
- Implementers commit on their task branch and never push, merge or switch branches; the controller integrates.
- `CLAUDE.md` is git-ignored and edited only by the controller. Never edit permission or agent configuration.
- Single test: `pnpm --filter @assetforge/<package> test <file> -t "<name>"` (no `--`). Whole check: `pnpm typecheck` and `pnpm test`. Every task ends with both green for the packages it touched; `inbox.test.tsx > filters and scroll offset survive navigation` is a known flake (rerun once).
- The latest migration is `0013`; this plan adds exactly one, `0014`, generated with `pnpm --filter @assetforge/persistence db:generate`. `DERIVED_DATA_VERSION` stays as it is.

### What implementers and tests must never touch

- Never start the app, never trigger "Open externally", "Show in folder" or a browser.
- Never call anything on host port 11434, never call the real Venice API, never start, stop or remove Docker containers.
- Tests that need a provider start the mock in-process (`startMockProvider` from `docker/mock-provider/server.mjs`) and use the key literal `test-key-not-real` (`TEST_KEY` of `apps/desktop/test/analysis-harness.ts`).

### Values

| Constant (in `packages/contracts/src/prompts.ts`) | Value |
|---|---|
| `PROMPT_TITLE_MAX` | 120 |
| `PROMPT_DESCRIPTION_MAX` | 2000 |
| `PROMPT_VARIABLE_NAME_MAX` | 40 |
| `MAX_PROMPT_VARIABLES` | 20 |
| `PROMPT_VARIABLE_VALUE_MAX` | 2000 (default values and values) |
| `MAX_PROMPT_TAGS` | 50 |
| content limit | `GENERATION_PROMPT_MAX` (8000, existing) |

### Messages (fixed, never with a value, cause or path)

| Code | Message | When |
|---|---|---|
| `validation_failed` | `A prompt needs a title` | title empty after trim |
| `validation_failed` | `A prompt needs a text` | content empty after trim |
| `validation_failed` | `This title is already used` | another prompt has the title (any case) |
| `validation_failed` | `A prompt can have at most 20 variables` | more than 20 distinct variables |
| `validation_failed` | `This text is too long` | title > 120, description > 2000, content > 8000, a default or a value > 2000 |
| `validation_failed` | `Every variable needs a value` | a variable has no value, or only whitespace |
| `validation_failed` | `This prompt has no such variable` | a value for a name the version does not hold, or two keys for one variable |
| `validation_failed` | `This prompt cannot take more tags` | 51st tag |
| `invalid_operation` | `This prompt was changed in the meantime` | `baseVersionId` is not the current version |
| `not_found` | `This prompt does not exist` | unknown prompt id |
| `not_found` | `This prompt version does not exist` | unknown version id (`generations:start`) |

The resolved text of a library prompt goes through the unchanged phase 5a checks and their messages (`The prompt must have 1 to 8000 characters`, `The prompt is longer than this model allows`).

### Package boundaries

- `contracts` and `core` import no Electron, no database, no provider. The renderer imports only `@assetforge/contracts`.
- Repositories return plain data and outcome values; rule violations become `AssetForgeError`s in core.
- Short transactions; no network or file work inside one.

### UI rules

- No explanatory text in the layout; explanations are `title` tooltips. Every button uses `BUTTON`, `ICON_BUTTON`, `BUTTON_INLINE` or `ICON_BUTTON_INLINE` from `apps/desktop/src/renderer/src/ui.ts`. Colours only through tokens (`test/theme.test.ts` guards it). Every visible string is a constant or function in `labels.ts`.
- The UI says "Prompts" for the library and keeps "analysis prompts" for the Settings section; the two never share a component or a label.

### Author's calls (settled here, do not reopen)

- Lists page by `offset`/`limit` with `total`, like `projects:list`, because `usePagedList` works that way (the design said "cursor").
- `Generation` also carries `promptId` (read through the version row, no column), because `prompts:get` and the details link need it.
- DTOs carry `variables` as a plain array and `promptVariables` as a plain record; the `{ v: 1, … }` wrappers exist only in the database columns.
- Prompt tags are `TagAssignment`s with origin `manual`, so `TagRow`, `TagChip` and `renameInTags` work unchanged.
- The unsaved-changes guard covers choosing another prompt, `New` and the main navigation; closing the window is not guarded.

## Review Focus

1. A search word containing `%`, `_` or `\` must match literally (a query `100%` must not match every prompt). Pinned in Task 2.
2. A value that itself contains `{{name}}` must reach the provider verbatim, and a text like `{{ }}`, `{{a{{b}}` or `{{x!}}` must stay plain text and never count as a variable. Pinned in Task 1.
3. A prompt deleted or given a new version while the studio has it loaded: Generate with the old version id still works when the version exists and answers `not_found` (shown as the start error, form kept) when the prompt is gone. Pinned in Tasks 4 and 6.
4. Two prompts whose titles differ only in case or surrounding spaces, including renaming a prompt to its own title in another case (allowed). Pinned in Tasks 2 and 3.
5. A tag merge where one prompt carries both tags must leave one link and must not fail on the primary key. Pinned in Task 2.

## Lanes

Task 1 → Task 2 → (Task 3 ∥ Task 4) → (Task 5 ∥ Task 6) → (Task 7 ∥ Task 8). Parallel tasks run in separate worktrees; both tasks of a pair append to `labels.ts` or `ipc.ts`/`generations.ts` in different places, and the controller merges.

---

### Task 1: Template rules and prompt contracts

**Files:**
- Create: `packages/contracts/src/prompt-template.ts`, `packages/contracts/src/prompts.ts`
- Modify: `packages/contracts/src/index.ts` (export both)
- Test: `packages/contracts/test/prompt-template.test.ts`, `packages/contracts/test/prompts.test.ts`

**Interfaces — Produces:**

```ts
// prompt-template.ts
export interface PromptVariable { name: string; defaultValue: string }
/** Distinct variable names in order of first occurrence, each in its first spelling. */
export function parsePromptVariables(content: string): string[];
/** The items core stores: one per parsed name; a default is matched regardless of case, others are dropped; missing → ''. */
export function buildPromptVariables(content: string, defaults: Readonly<Record<string, string>>): PromptVariable[];
export type ResolveResult =
  | { ok: true; text: string; values: Record<string, string> }   // values keyed by the version's spelling, trimmed
  | { ok: false; reason: 'missing' | 'unknown' | 'value_too_long' };
export function resolvePromptText(content: string, variables: readonly PromptVariable[], values: Readonly<Record<string, string>>): ResolveResult;
export const variableKey = (name: string) => name.toLowerCase();
```

```ts
// prompts.ts — constants of the Values table, plus:
PromptVariableSchema        // { name: string 1..40, defaultValue: string max 2000 }
PromptVersionSchema         // { id: uuid, number: int >= 1, content: string, variables: PromptVariable[], createdAt: string }
PromptSummarySchema         // { id, title, description, tags: TagAssignment[], currentVersion: PromptVersion, updatedAt }
PromptDetailSchema          // summary + { versions: PromptVersion[] (newest first), createdAt }
PromptDefaultsSchema        // z.record(z.string().max(200), z.string().max(2000)), at most 40 keys
ListPromptsSchema           // { query?: string max 200, tagNames?: string[] max 20 (each max 200), offset: int >= 0, limit: int 1..200 }
PromptPageSchema            // { items: PromptSummary[], total: int >= 0 }
CreatePromptSchema          // { title: string max 500, description: string max 5000, content: string max 20000, defaults: PromptDefaults }
UpdatePromptSchema          // { promptId: uuid, title, description } (same bounds)
SavePromptVersionSchema     // { promptId: uuid, baseVersionId: uuid, content, defaults }
```

The transport bounds are deliberately wider than the rules, so core answers the fixed messages.

- [ ] **Step 1: Write `prompt-template.test.ts`** with these cases (exact values):

```ts
parsePromptVariables('A {{View}} of {{ view }} and {{pose-1}}')      // ['View', 'pose-1']
parsePromptVariables('{{ }} {{a{{b}} {{x!}} {single} {{' + 'n'.repeat(41) + '}}') // ['b']
parsePromptVariables('{{{a}}}')                                       // ['a']
parsePromptVariables('{{Überschrift 2}}')                             // ['Überschrift 2']
buildPromptVariables('{{View}} {{pose}}', { view: 'front', gone: 'x' })
  // [{ name: 'View', defaultValue: 'front' }, { name: 'pose', defaultValue: '' }]
resolvePromptText('A {{View}}, again {{ view }}.', [{ name: 'View', defaultValue: '' }], { VIEW: '  side  ' })
  // { ok: true, text: 'A side, again side.', values: { View: 'side' } }
resolvePromptText('{{a}}', [{ name: 'a', defaultValue: '' }], { a: '{{a}} {{b}}' })   // ok, text '{{a}} {{b}}' (one pass)
resolvePromptText('{{a}}', [{ name: 'a', defaultValue: 'd' }], {})                    // { ok: false, reason: 'missing' } (defaults are not applied)
resolvePromptText('{{a}}', [{ name: 'a', defaultValue: '' }], { a: '   ' })           // missing
resolvePromptText('x', [], { a: 'v' })                                                // unknown
resolvePromptText('{{a}}', [{ name: 'a', defaultValue: '' }], { a: 'v', A: 'w' })     // unknown
resolvePromptText('{{a}}', [{ name: 'a', defaultValue: '' }], { a: 'v'.repeat(2001) }) // value_too_long
resolvePromptText('no variables', [], {})                                             // ok, text unchanged
```

- [ ] **Step 2: Run** `pnpm --filter @assetforge/contracts test prompt-template` — fails (module missing).
- [ ] **Step 3: Implement `prompt-template.ts`.** One scanner for all three functions: the pattern `/\{\{([^{}]*)\}\}/gu`; a match is a variable only when its trimmed inside matches `/^[\p{L}\p{N} _-]{1,40}$/u`; everything else is left in place. Resolving uses a single `replace` with a callback over the original content. Text is not trimmed here (core trims the result).
- [ ] **Step 4: Write `prompts.test.ts`:** each schema accepts a minimal valid object; `PromptDefaultsSchema` refuses 41 keys and a 2001-character value; `ListPromptsSchema` refuses `limit: 0` and `limit: 201`.
- [ ] **Step 5: Implement `prompts.ts`, export both files from `index.ts`.**
- [ ] **Step 6: Run** `pnpm --filter @assetforge/contracts test` and `pnpm typecheck` — green.
- [ ] **Step 7: Commit** `feat(contracts): prompt template rules and prompt DTOs`.

---

### Task 2: Persistence — tables, prompt repository, generation columns, tags

**Files:**
- Modify: `packages/persistence/src/schema.ts` (tables `prompt`, `prompt_version`, `prompt_tag`; four columns on `generation`), `packages/persistence/src/generation-repository.ts`, `packages/persistence/src/tag-repository.ts`, `packages/persistence/src/open-database.ts`, `packages/core/src/ports.ts`, `packages/contracts/src/generations.ts` (`GenerationSchema`), `packages/contracts/src/tags.ts` (`TagUsageSchema.prompts`), `packages/core/src/tags.ts` (`tagUsage` passes `prompts`), `packages/core/src/generations.ts` (passes `promptRef: null`), `packages/core/test/memory-generations.ts`, `packages/core/test/fakes.ts`, renderer test fixtures that build a `Generation` or a `TagUsage`
- Create: `packages/persistence/src/prompt-repository.ts`, migration `0014_*.sql` (generated), `packages/core/test/memory-prompts.ts`
- Test: `packages/persistence/test/prompt-repository.test.ts`, `packages/persistence/test/migration-0014.test.ts`, additions to `generation-repository.test.ts` and `tag-repository.test.ts`, `packages/core/test/memory-prompts.test.ts`

**Interfaces — Consumes:** the Task 1 DTOs.

**Interfaces — Produces:**

```ts
// contracts: GenerationSchema gains (all nullable)
promptId: uuid | null            // prompt_version.prompt_id through the version row
promptVersionId: uuid | null
promptTitle: string | null
promptVersionNumber: number | null
promptVariables: Record<string, string> | null
// contracts: TagUsageSchema gains  prompts: int >= 0

// core ports
export interface GenerationPromptRef { versionId: string; title: string; versionNumber: number; variables: Record<string, string> }
// NewGeneration gains:  promptRef: GenerationPromptRef | null
export interface NewPromptVersion { id: string; content: string; variables: PromptVariable[] }
export interface PromptRepository {
  /** One transaction: the prompt and version 1. False, writing nothing, when `titleKey` is taken. */
  create(r: { id: string; title: string; titleKey: string; description: string; version: NewPromptVersion; now: string }): Promise<boolean>;
  /** Sets title, description and updated_at. */
  update(r: { id: string; title: string; titleKey: string; description: string; now: string }): Promise<'ok' | 'missing' | 'title_taken'>;
  get(id: string): Promise<PromptDetail | null>;
  /** A version with the id and current title of its prompt. */
  getVersion(versionId: string): Promise<{ promptId: string; title: string; version: PromptVersion } | null>;
  /** One transaction guarded on `baseVersionId` being the highest number: inserts number + 1, sets updated_at. */
  addVersion(r: { promptId: string; baseVersionId: string; version: NewPromptVersion; now: string }): Promise<'ok' | 'missing' | 'stale'>;
  /** Deletes the prompt with versions and tag links. */
  remove(id: string): Promise<boolean>;
  /** `words` and `tagNames` are already normalised; order updated_at desc, then id asc. */
  list(q: { words: readonly string[]; tagNames: readonly string[]; offset: number; limit: number }): Promise<{ items: PromptSummary[]; total: number }>;
  /** Inserts the tag row if its name is missing, then the link; sets updated_at. A link that exists is a no-op ('ok'). */
  addTag(r: { promptId: string; name: string; displayName: string; newId: string; now: string; max: number }): Promise<'ok' | 'missing' | 'limit'>;
  removeTag(r: { promptId: string; name: string; now: string }): Promise<'ok' | 'missing'>;
}
// WorkspaceDatabase gains  prompts: PromptRepository
// TagRepository.usage returns { displayName, assets, files, prompts }
```

Schema facts: `prompt.title_key` has a unique index; `prompt_version` has a unique index on (`prompt_id`, `number`) and `prompt_id` cascades; `prompt_tag` has primary key (`prompt_id`, `tag_id`), `prompt_id` cascades, an index on `tag_id`, and `tag_id` has no `on delete` (like `asset_tag`); `generation.prompt_version_id` references `prompt_version` with `set null`. `prompt_version.variables` holds `{ "v": 1, "items": [...] }`, `generation.prompt_variables` holds `{ "v": 1, "values": {...} }`; a column that does not parse reads as an empty list / null.

- [ ] **Step 1: Write the failing persistence tests.**
  - `prompt-repository.test.ts`: create + get (version 1 current, `versions` newest first); create with a taken `titleKey` → `false` and no row; `update` → `'title_taken'` for another prompt's key, `'ok'` for its own key; `addVersion` → numbers 1, 2, 3, `'stale'` with an old base, `'missing'` for an unknown prompt, `updated_at` moves; `remove` deletes versions and links and leaves the `tag` row; `addTag` twice → one link, the 51st with `max: 50` → `'limit'`; `list`: order by `updated_at` desc then id, `offset`/`limit`/`total`, a word matches title, description, **current** content (not an older version's) and a tag display name regardless of case, two words must both match (in any of the fields), `tagNames` all present, and **Review Focus 1**: prompts titled `100% wool` and `plain`, `words: ['100%']` → only the first; `words: ['a_c']` does not match `abc`; `words: ['\\']` matches only a text holding a backslash.
  - `generation-repository.test.ts` additions: `create` with a `promptRef` → `get` returns the five fields; without → all null; after `prompts.remove` the generation has `promptId` and `promptVersionId` null and still `promptTitle`, `promptVersionNumber`, `promptVariables`; `requeue` leaves them.
  - `tag-repository.test.ts` additions: `suggest` returns a tag only a prompt carries; `usage` counts `prompts`; `rename` to a free name keeps the prompt link; merge where prompt A carries both tags and prompt B only the source → A has one link to the kept tag with the earlier `created_at`, B has one, the source row is gone (**Review Focus 5**); `prompt.updated_at` is unchanged by a rename.
  - `migration-0014.test.ts` (pattern of `migration-0013.test.ts`): a database migrated up to `0013` with one generation → after `0014` the generation reads with the five fields null and the three tables exist and are empty.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/persistence test prompt-repository` — fails.
- [ ] **Step 3: Change `schema.ts`, run `db:generate`,** check that the generated SQL only creates the three tables and adds four columns (SQLite `ALTER TABLE … ADD` with a reference is allowed for a nullable column; if Drizzle rebuilds the `generation` table instead, keep its output as generated).
- [ ] **Step 4: Implement `prompt-repository.ts`** and register it in `open-database.ts`. The list filter per word: `(title like ? escape '\' or description like ? escape '\' or current content like ? … or exists (tag display name like ? …))` with `%`, `_` and `\` in the word escaped; SQLite `LIKE` is case-insensitive only for ASCII, so compare `lower(column)` against the lower-cased word.
- [ ] **Step 5: Extend `generation-repository.ts`** (`create` writes the four columns, `load` reads them and joins `prompt_version` for `promptId`) and `tag-repository.ts`: `suggest` gets a third `union all` branch over `prompt_tag`; `usage` a third count; `rename` handles `prompt_tag` in its own helper `mergePromptLinks(tx, sourceId, targetId)` — set the kept link's `created_at` to the earlier one where a prompt carries both, delete the source links of those prompts, repoint the rest — called before the source `tag` row is deleted.
- [ ] **Step 6: Make the other packages compile:** `GenerationSchema`, `TagUsageSchema`, `ports.ts`, `tagUsage`, `startGeneration` (passes `promptRef: null` for now), `memory-generations.ts`, and a `memory-prompts.ts` implementing `PromptRepository` in memory (wired into the fake database of `fakes.ts`) with `memory-prompts.test.ts` covering create/update/addVersion outcomes and the list order, so core tests in Tasks 3 and 4 can rely on it. Renderer fixtures get the new fields as null / `prompts: 0`.
- [ ] **Step 7: Run** `pnpm typecheck` and `pnpm test` — green.
- [ ] **Step 8: Commit** `feat(persistence): prompt tables, repository and generation prompt reference`.

---

### Task 3: Prompt use cases and channels

**Files:**
- Create: `packages/core/src/prompts.ts`, `apps/desktop/src/main/prompt-handlers.ts`
- Modify: `packages/core/src/index.ts`, `packages/contracts/src/ipc.ts` (eight `prompts:*` entries after `generations:recentPrompts`), `apps/desktop/src/main/composition.ts` and wherever the handler groups are merged into `IpcHandlers`
- Test: `packages/core/test/prompts.test.ts`, `apps/desktop/test/prompts-ipc.test.ts`

**Interfaces — Consumes:** `PromptRepository`, the Task 1 functions and schemas, `tagName` from `packages/core/src/tags.ts`.

**Interfaces — Produces:**

```ts
// core/prompts.ts — all take (s: WorkspaceSession, r)
listPrompts(s, r: ListPrompts): Promise<PromptPage>
getPrompt(s, promptId): Promise<PromptDetail>
createPrompt(s, r: CreatePrompt): Promise<PromptDetail>
updatePrompt(s, r: UpdatePrompt): Promise<PromptDetail>
savePromptVersion(s, r: SavePromptVersion): Promise<PromptDetail>
deletePrompt(s, promptId): Promise<void>
addPromptTag(s, r: { promptId: string; name: string }): Promise<PromptDetail>
removePromptTag(s, r: { promptId: string; name: string }): Promise<PromptDetail>
export const promptTitleKey = (title: string) => title.trim().toLowerCase();

// ipc.ts
'prompts:list'        ListPromptsSchema → PromptPageSchema
'prompts:get'         { promptId } → PromptDetailSchema
'prompts:create'      CreatePromptSchema → PromptDetailSchema
'prompts:update'      UpdatePromptSchema → PromptDetailSchema
'prompts:saveVersion' SavePromptVersionSchema → PromptDetailSchema
'prompts:delete'      { promptId } → {}
'prompts:addTag' / 'prompts:removeTag'  { promptId, name: string max 200 } → PromptDetailSchema
```

Rules (messages from the table): title and description are trimmed, content is trimmed and stored trimmed; the variable count is checked on the parsed content; `listPrompts` splits the query on whitespace into lower-cased words and normalises `tagNames` with `normalizeTagName` (an invalid tag name answers an empty page); `savePromptVersion` loads the prompt, refuses a `baseVersionId` that is not the current version, builds the variables, and returns the unchanged detail without writing when trimmed content and built variables equal the current version's (deep equality of name and default), otherwise calls `addVersion` (`'stale'` → the same `invalid_operation`). Reads go through `manager.read`, writes through `manager.exclusive`, as `library-handlers.ts` does for tags.

- [ ] **Step 1: Write `packages/core/test/prompts.test.ts`** on the memory database:
  - create: version 1, variables built from content and defaults; each message of the table for title/content/length/21 variables; ` Hero ` then `hero` → `This title is already used`; exactly 20 variables is accepted.
  - update: own title in another case is accepted (**Review Focus 4**), another prompt's title refused, unknown id → `not_found`.
  - saveVersion: changed content → version 2 and `updatedAt` moves; same content with surrounding spaces and same defaults → no new version, same `updatedAt`; only a default changed → version 2; a default for a variable no longer in the text is dropped and alone causes no version; stale base → `invalid_operation` `This prompt was changed in the meantime`.
  - tags: add twice → once; invalid name → the tag message of `tagName`; 51st → `This prompt cannot take more tags`; remove of a missing tag is a no-op.
  - delete: gone, second delete → `not_found`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/core test prompts` — fails.
- [ ] **Step 3: Implement `core/prompts.ts`.**
- [ ] **Step 4: Write `apps/desktop/test/prompts-ipc.test.ts`** (pattern and harness of `library-ipc.test.ts`): every channel without a workspace → `no_workspace_open`; a round trip create → list (query and tag filter) → saveVersion → get (two versions, newest first) → delete; a malformed request (`limit: 0`, non-uuid id) → `invalid_request`; `tags:usage` counts the prompt and `tags:suggest` offers its tag; `tags:rename` with `merge: true` over a prompt carrying both tags answers `merged: true` and `prompts:get` shows one tag.
- [ ] **Step 5: Add the channels and `createPromptHandlers(manager)`**, wire them in.
- [ ] **Step 6: Run** `pnpm typecheck`, `pnpm --filter @assetforge/core test`, `pnpm --filter @assetforge/desktop test prompts-ipc library-ipc ipc` — green.
- [ ] **Step 7: Commit** `feat: prompt library use cases and channels`.

---

### Task 4: Starting an edit from a prompt version

**Files:**
- Modify: `packages/contracts/src/generations.ts` (`StartGenerationSchema`), `packages/core/src/generations.ts` (`startGeneration`)
- Test: `packages/contracts/test/generations.test.ts` (or the existing schema test file for generations), `packages/core/test/generations.test.ts`, `apps/desktop/test/generation-acceptance.test.ts`

**Interfaces — Consumes:** `resolvePromptText`, `PromptRepository.getVersion`, `GenerationPromptRef`.

**Interfaces — Produces:** the edit member of `StartGenerationSchema` becomes

```ts
{ kind: 'edit', fileId, providerId?, model,
  prompt?: string (max 20000),
  promptVersionId?: uuid,
  variables?: Record<string (max 200), string (max 20000)>,   // at most 40 keys
  aspectRatio?, resolution?, safeMode }
```

valid only when exactly one of `prompt` and `promptVersionId` is present and `variables` is present exactly when `promptVersionId` is (a refinement on the member; if the discriminated union refuses a refined member, refine the union). Everything else answers `invalid_request` through the existing IPC validation.

`startGeneration`, at the place of today's prompt check (after the provider is resolved, before the model list is asked): with `promptVersionId`, `getVersion` (null → `NotFoundError('This prompt version does not exist')`), `resolvePromptText` (`missing` → `Every variable needs a value`, `unknown` → `This prompt has no such variable`, `value_too_long` → `This text is too long`), then `prompt = text.trim()` and the unchanged checks. `create` gets `promptRef: { versionId, title, versionNumber, variables: result.values }`; a free prompt and an upscale pass `null`. `retryGeneration` is not changed.

- [ ] **Step 1: Schema tests:** free prompt alone valid; version + `variables: {}` valid; both forms → invalid; neither → invalid; version without `variables` → invalid; `prompt` with `variables` → invalid; 41 keys → invalid.
- [ ] **Step 2: Core tests** (memory database, existing `generation-setup.ts`): a version `A {{view}} view` with `{ VIEW: ' side ' }` stores prompt `A side view`, `promptTitle`, `promptVersionNumber`, `promptVersionId`, `promptId` and `promptVariables` `{ view: 'side' }`; a value containing `{{view}}` is stored verbatim (**Review Focus 2**); missing value, unknown name, unknown version id → the messages above and no generation row, and the provider's model list was not asked; a resolved text over the model's `promptCharacterLimit` → `The prompt is longer than this model allows`; an older version of a prompt that has a newer one still starts and records the older number; a free prompt stores all five fields null.
- [ ] **Step 3: Run** the two test files — fail. **Implement** schema and `startGeneration`.
- [ ] **Step 4: Acceptance test** in `generation-acceptance.test.ts`: create a prompt through `prompts:create`, start with its version and values, wait for success, assert the mock's `imageRequests` entry carries the resolved text as its prompt field and `generations:forFile` shows the five fields; then `prompts:delete` and assert the result's generation keeps title, number, values and text with `promptId` and `promptVersionId` null; a start with the deleted version id answers `not_found` (**Review Focus 3**); `generations:retry` of a failed version-based generation (use `MOCK_PROMPT_FAIL` as the resolved text) keeps the five fields and the text.
- [ ] **Step 5: Run** `pnpm typecheck`, `pnpm --filter @assetforge/core test generations`, `pnpm --filter @assetforge/desktop test generation-acceptance generation-ipc` — green.
- [ ] **Step 6: Commit** `feat: start an edit from a prompt version`.

---

### Task 5: Prompts screen

**Files:**
- Create: `apps/desktop/src/renderer/src/screens/PromptsScreen.tsx`, `components/PromptEditor.tsx`, `prompt-editor-state.ts`, `leave-guard.tsx`
- Modify: `nav.ts` (`{ name: 'prompts'; id?: string }`), `components/AppShell.tsx` (`Section` and a `NAV` entry `Prompts` directly after `Projects`), `components/WorkspaceShell.tsx` (render, `sectionOf`, leave guard in `navigate`, rename handling), `labels.ts`, `components/RenameTagDialog.tsx` + `labels.ts` (`tagUsageLine` names prompts), `tag-rename.ts` if a helper for a prompt record is needed
- Test: `apps/desktop/test/renderer/prompts-screen.test.tsx`, `apps/desktop/test/prompt-editor-state.test.ts`, additions to `rename-tag-dialog.test.tsx`, `shell.test.tsx`, `labels.test.ts`

**Interfaces — Consumes:** the `prompts:*` channels, `usePagedList`, `SearchField`, `TagFilter`, `TagRow`, `ConfirmDialog`, `useRenamed`, `parsePromptVariables`.

**Interfaces — Produces:**

```ts
// nav.ts: View gains { name: 'prompts'; id?: string } — `id` preselects that prompt (used by Task 7)
// leave-guard.tsx
export function LeaveGuardProvider(props: { children: ReactNode }): JSX.Element;
/** While mounted with a non-null guard, the main navigation awaits it and stays when it answers false. */
export function useLeaveGuard(guard: (() => Promise<boolean>) | null): void;
export function useConfirmLeave(): () => Promise<boolean>;   // WorkspaceShell.navigate calls this first
// prompt-editor-state.ts (pure)
export interface EditorDraft { title: string; description: string; content: string; defaults: Record<string, string> }
export function draftOf(detail: PromptDetail, version?: PromptVersion): EditorDraft;
export function variablesOf(draft: EditorDraft): PromptVariable[];              // parse + defaults by case-insensitive name
export function metaDirty(draft: EditorDraft, detail: PromptDetail): boolean;   // title or description differ after trim
export function versionDirty(draft: EditorDraft, detail: PromptDetail): boolean; // trimmed content or variables differ from the current version
// labels.ts
PROMPTS_LABEL = 'Prompts', NEW_PROMPT_LABEL = 'New', PROMPT_TITLE_LABEL = 'Title', PROMPT_TEXT_LABEL = 'Text',
PROMPT_TEXT_TITLE = 'Write {{name}} for a part that changes', USE_VERSION_LABEL = 'Use this version',
UNSAVED_PROMPT_TITLE = 'Discard the unsaved changes?', DELETE_PROMPT_TITLE = 'Delete this prompt?',
promptVersionLabel(number, createdAt) // `v3 · <date as the lists format it>`
tagUsageLine(usage) // `<name> · 2 files · 1 asset · 1 prompt`
```

Behaviour: left column with search (250 ms debounce like the other lists), tag filter, `New` and the endless list (title, first line of the current text, tags), keyed for `usePagedList` by query + tags + a reload counter; right column the editor of the selected prompt. `New` opens an empty draft that is created by Save (`prompts:create`). One Save button: it sends `prompts:update` when `metaDirty`, then `prompts:saveVersion` (with the loaded current version id as base) when `versionDirty`, is disabled when neither is dirty, and shows a failure as an alert with the draft kept. The version select lists all versions newest first; choosing an older one shows its text and defaults read-only with `Use this version`, which loads them into the draft against the current version (so Save writes a new version). Delete asks through `ConfirmDialog`, then selects nothing and reloads the list. Choosing another prompt, `New` or the main navigation with a dirty draft asks `UNSAVED_PROMPT_TITLE` through `ConfirmDialog`; cancel keeps everything. After every successful save, tag change or delete the list reloads. A rename signal (`useRenamed`) rewrites the tag filter (`renameInNames`) and the loaded detail's tags (`renameInTags`), and the list reloads on `renameToken`. During an import (the shell's busy state) Save, Delete, `New` and tag editing are disabled like the other screens do.

- [ ] **Step 1: Write `prompt-editor-state.test.ts`:** `variablesOf` follows the text as it is typed and keeps a default typed for `View` when the text now says `{{view}}`; `versionDirty` false for content differing only in surrounding whitespace and for a default of a removed variable, true for a changed default; `metaDirty` ignores surrounding whitespace.
- [ ] **Step 2: Write `prompts-screen.test.tsx`** with the fake API: the list shows pages and reloads for a typed query; `New` → fill title and text `A {{view}}` → a default input labelled `view` appears → Save calls `prompts:create` with `defaults`; editing only the title calls only `prompts:update`; editing the text calls `prompts:saveVersion` with the loaded `baseVersionId`; a `prompts:saveVersion` failure (`invalid_operation`) shows the message and keeps the draft; an older version is read-only (textarea `readOnly`, no Save), `Use this version` makes Save enabled; Delete → confirm → `prompts:delete`; a dirty draft plus a click on another prompt opens the confirm dialog, cancel keeps the draft, confirm switches; a dirty draft plus a main navigation click asks too (in `shell.test.tsx`); the view `{ name: 'prompts', id }` opens with that prompt selected; no element of the screen has a colour literal or free explanatory paragraph (the existing theme test covers the former).
- [ ] **Step 3: Run** `pnpm --filter @assetforge/desktop test prompts-screen prompt-editor-state` — fail.
- [ ] **Step 4: Implement** state, leave guard, screen, editor, navigation entry and the usage line.
- [ ] **Step 5: Run** `pnpm typecheck` and `pnpm --filter @assetforge/desktop test` — green.
- [ ] **Step 6: Commit** `feat(desktop): prompts screen`.

---

### Task 6: Library prompts in the studio

**Files:**
- Create: `apps/desktop/src/renderer/src/components/PromptPicker.tsx`, `components/SavePromptDialog.tsx`, `studio-prompt.ts`
- Modify: `studio-state.ts`, `components/StudioForm.tsx`, `components/GenerationStudio.tsx`, `studio-context.tsx` (variable memory), `labels.ts`
- Test: `apps/desktop/test/studio-prompt.test.ts`, additions to `studio-state.test.ts` and `renderer/generation-studio.test.tsx`, `renderer/prompt-picker.test.tsx`

**Interfaces — Consumes:** `prompts:list`, `prompts:get`, `prompts:create`, `prompts:saveVersion`, `generations:start` (version form), `resolvePromptText`, `variableKey`.

**Interfaces — Produces:**

```ts
// studio-prompt.ts (pure)
export interface AttachedPrompt {
  promptId: string; title: string; version: PromptVersion;
  /** The id of the prompt's current version when this one was loaded. */
  currentVersionId: string;
  values: Record<string, string>;        // keyed by the version's spelling
}
export function attach(detail: PromptDetail, version: PromptVersion, recall: (name: string) => string | undefined, given?: Record<string, string>): AttachedPrompt;
  // value per variable: `given` (case-insensitive) → recalled → defaultValue
export function preview(a: AttachedPrompt): { text: string; blocked: 'missing' | 'value_too_long' | null };
  // text: variables with a usable value replaced, others left as written
// studio-state.ts: StudioForm gains
attached: AttachedPrompt | null;                         // a library prompt is in use; `prompt` is ignored while set
origin: { promptId: string; title: string } | null;      // the prompt a free text was detached from
// studio-context.tsx: StudioState gains
recallVariable(name: string): string | undefined;        // case-insensitive, lives as long as the provider
rememberVariables(values: Readonly<Record<string, string>>): void;
// labels.ts
LIBRARY_PROMPT_LABEL = 'Library', EDIT_PROMPT_TEXT_LABEL = 'Edit text', SAVE_TO_LIBRARY_LABEL = 'Save to library',
VARIABLE_MISSING_TITLE = 'Fill in every variable', NEWER_VERSION_TITLE = 'A newer version exists; click to load it',
attachedPromptLabel(title, number)   // `<title> v<n>`
newVersionOfLabel(title)             // `New version of <title>`
```

Behaviour:
- `PromptPicker` is a small `Dialog` with a `SearchField` and a list from `prompts:list` (same debounce and superseding as the lists); choosing a row loads `prompts:get` and attaches the current version.
- Attached: the form shows `attachedPromptLabel` (button; with `NEWER_VERSION_TITLE` and a click that re-attaches the current version, keeping values, only when `version.id !== currentVersionId`), one labelled input per variable, the preview in the read-only textarea, and `Edit text`. Typing a value updates the form and calls `rememberVariables`.
- Blocking: the existing `blocked` value gains, after the provider gate: `VARIABLE_MISSING_TITLE` when the preview is blocked, and the existing prompt-length reason when the preview text is empty or over `min(model limit, 8000)`.
- Generate sends `promptVersionId` and `variables` (and no `prompt`) when attached, otherwise `prompt` as today. A `not_found` start error is shown as the start error and the form stays as it is.
- `Edit text` → `prompt = preview text`, `attached = null`, `origin = { promptId, title }`. Choosing a recent prompt sets `origin = null`. Choosing a library prompt replaces both.
- `Save to library` (only with a free, non-empty prompt): `SavePromptDialog` with a title input and, when `origin` is set and `prompts:get` still finds it, a choice between a new prompt and `newVersionOfLabel(title)` (default: new version). New prompt → `prompts:create { title, description: '', content: prompt, defaults: {} }`; new version → `prompts:saveVersion` with the fetched current version id, the prompt as content and the current version's defaults. A failure shows the message inside the dialog. Afterwards the form is attached to the returned current version (which has the variables the text holds).
- `Use settings` (`formFromGeneration`): the function stays pure and returns the free-text form; `GenerationStudio.applySettings` then, when `g.promptId !== null`, loads `prompts:get(g.promptId)`, finds the version `g.promptVersionId` in `versions` and attaches it with `given = g.promptVariables`; when the load fails or the version is not in the list the free text stays. A later answer of an earlier `Use settings` is ignored (sequence counter, as the studio's other loads do).

- [ ] **Step 1: Write `studio-prompt.test.ts`:** `attach` precedence (given over recalled over default, names matched regardless of case); `preview` of `A {{view}} of {{who}}` with only `view` filled → text `A side of {{who}}`, `blocked: 'missing'`; a 2001-character value → `value_too_long`; no variables → `blocked: null`.
- [ ] **Step 2: Add renderer tests** to `generation-studio.test.tsx` / `prompt-picker.test.tsx`: picking a prompt shows its variable inputs prefilled with defaults; Generate is disabled with `VARIABLE_MISSING_TITLE` until all are filled; Generate calls `generations:start` with `promptVersionId` and `variables` and without `prompt`; a value typed for `view` is prefilled when a second prompt with `{{View}}` is picked, also after the studio is closed and opened for another file under the same provider; `Edit text` makes the textarea editable holding the resolved text and the next start sends only `prompt`; `Save to library` after a detach offers `New version of <title>` and calls `prompts:saveVersion`, without an origin it calls `prompts:create`, and afterwards the form is attached; `Use settings` on a result with `promptId` attaches that version with its values, on one with `promptId: null` fills the free text; a `generations:start` rejection `not_found` shows the message and keeps the inputs (**Review Focus 3**); with a newer version the title button carries `NEWER_VERSION_TITLE` and a click loads the current one.
- [ ] **Step 3: Run** the test files — fail. **Implement.**
- [ ] **Step 4: Run** `pnpm typecheck` and `pnpm --filter @assetforge/desktop test` — green.
- [ ] **Step 5: Commit** `feat(desktop): library prompts in the generation studio`.

---

### Task 7: Prompt origin in the generation details

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/GenerationDetails.tsx`, `studio-context.tsx` (`openPrompt`), `components/WorkspaceShell.tsx` (passes the navigation to `StudioProvider`), `labels.ts`
- Test: additions to `apps/desktop/test/renderer/generation-details.test.tsx`, `studio-stacking.test.tsx`

**Interfaces — Consumes:** `Generation.promptId/promptTitle/promptVersionNumber/promptVariables`, the view `{ name: 'prompts', id }`, `attachedPromptLabel`.

**Interfaces — Produces:** `StudioState.openPrompt(promptId: string): void` — closes the studio and the linked file dialog and navigates to `{ name: 'prompts', id: promptId }` (through the leave guard like every navigation); `StudioProvider` gets the prop `onOpenPrompt(promptId: string): void`. `promptValuesTitle(values)` in `labels.ts`: one `name: value` per line, empty string for no values.

- [ ] **Step 1: Tests:** a `madeBy` generation with `promptTitle: 'Turnaround'`, `promptVersionNumber: 3`, `promptId` set → a `Link` reading `Turnaround v3` with the values as `title`, and following it calls `openPrompt` with the id; with `promptId: null` the same text is plain (no link role); with `promptTitle: null` the line is absent; after `openPrompt` no studio or linked dialog is mounted.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test generation-details` — fails. **Implement.**
- [ ] **Step 3: Run** `pnpm typecheck` and `pnpm --filter @assetforge/desktop test` — green.
- [ ] **Step 4: Commit** `feat(desktop): show the library prompt of a generation`.

---

### Task 8: Documentation

**Files:**
- Modify: `ReadMe.md` (§7.1 "Implemented so far"; §7.2 start request and record; §10 data model; §17 phase list), `docs/backlog.md` (section "Prompt library")

- [ ] **Step 1: ReadMe.** §7.1: what exists (entities, versions, variables with the name rule, tags, search by `LIKE`, the screen, the studio integration, the record on the generation) and what does not (the design's non-goals). §7.2: the two forms of an edit start, resolution in the main process, the five record fields, retry reusing the stored text. §10: the three tables and the four columns. §17: phase 5b marked implemented. Write from the code as merged, not from this plan.
- [ ] **Step 2: Backlog** "Prompt library": negative prompts; typed variables; a generations list per prompt; saving Image-to-prompt text directly; a guard for closing the window with unsaved prompt changes; a trash for prompts; export/import; plus every finding parked during this plan (the controller supplies the ledger lines).
- [ ] **Step 3: Check** that every channel, table, constant and message named in the new text exists in the code (`Grep`), then commit `docs: prompt library`.
