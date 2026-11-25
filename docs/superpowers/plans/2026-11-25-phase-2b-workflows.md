# Phase 2b – Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Versioned built-in workflow templates, one workflow per asset with independent step states and notes, and derived progress — visible and editable on the asset detail screen and visible in the asset list.

**Architecture:** One Drizzle migration (`0002`) adds template, version, step-definition and instance tables. Built-in templates are defined in `core` and synchronised into the database when a workspace is opened; a (`key`, `version`) pair that is missing is inserted, existing rows are never changed. Use cases are plain functions over the `WorkspaceSession` of phase 2a; progress is computed in queries, never stored.

**Tech Stack:** unchanged. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-25-phase-2b-workflows-design.md` (builds on `2026-11-25-phase-2a-asset-management-design.md`)

**Precondition:** phase 2a is merged into `main` and its plan's Task 11 is complete. Do not start before that.

**Branch:** `phase-2b-workflows`, created from `main` after the 2a merge.

**Models:** each task names the model for its implementer subagent. Task reviewers run on `sonnet`, except Tasks 1 and 3 (`opus`). The final whole-branch review runs on the most capable model.

## Global Constraints

- Everything in the repository is English. No attribution lines in commit messages.
- Every commit is followed by `git push` of the current branch (`git push -u origin phase-2b-workflows` the first time).
- `core` and `contracts` must not import Electron, better-sqlite3, Drizzle, `storage` or `persistence`. IPC handler modules stay free of Electron imports.
- No persistence logic in renderer or preload. No new dependencies.
- IDs are UUID v4 from the session / host; timestamps are ISO 8601 UTC strings. Port methods return `Promise`. Transactions are short.
- Exactly one migration is added in this phase: `0002`. Tasks after Task 1 do not change `schema.ts`.
- Template, template-version and step-definition rows are immutable once written: no repository method updates or deletes them.
- A step state changes only through `updateWorkflowStep`. Nothing sets a step to `done` as a side effect, and no workflow code reads or writes `asset.status`.
- `AssetForgeError` messages reach the renderer: no cause messages, absolute paths or credentials in them.
- UI: every button uses the `BUTTON` class from `apps/desktop/src/renderer/src/ui.ts`; no explanatory sentences in the layout (use `title` tooltips); interactive elements have an accessible name.
- Tests in `packages/persistence` and `apps/desktop` run under Electron's Node. Single test: `pnpm --filter @assetforge/<package> test <file> -t "<name>"` (no `--`).
- Each task ends with `pnpm test` and `pnpm typecheck` green in the whole repository.

## Review Focus

1. A built-in template gets a new version while workflows of the old version exist → those workflows keep their steps, states, notes and version number; a workflow started afterwards uses the new version. (Tasks 2, 3)
2. A phase 2a database with assets → opens after migration `0002`; those assets have no workflow and `workflowProgress: null`, their types get a default template, and a workflow can be started for them. (Tasks 1, 4)
3. Skipping a mandatory step, starting a second workflow for an asset, starting with an unknown template → `invalid_operation` / `invalid_operation` / `not_found`; nothing changed. (Task 3)
4. Changing an asset's type after its workflow started → the workflow is untouched and still shows the original template. (Task 3)
5. `done` → `in_progress` → `done` on one step → `completedAt` is cleared and set again; progress follows; a notes-only update changes neither state nor `completedAt`. (Task 3)
6. Removing a workflow → its steps are gone, the asset, its files and its assignments are untouched, and a new workflow with another template can be started. (Tasks 3, 4)

---

### Task 1: Contracts, schema, migration 0002 and repositories

**Model:** opus

**Files:**
- Create: `packages/contracts/src/workflows.ts`, `packages/persistence/src/workflow-template-repository.ts`, `packages/persistence/src/asset-workflow-repository.ts`, `packages/persistence/migrations/0002_*.sql` (+ generated `meta/` files)
- Modify: `packages/contracts/src/library.ts`, `packages/contracts/src/index.ts`, `packages/persistence/src/schema.ts`, `asset-type-repository.ts`, `asset-repository.ts`, `open-database.ts`, `index.ts`, `packages/core/src/ports.ts`, `packages/core/src/asset-types.ts`, `packages/core/test/fakes.ts`
- Test: `packages/persistence/test/workflow-repositories.test.ts`, `packages/persistence/test/migration-0002.test.ts`, `packages/contracts/test/schemas.test.ts`

**Interfaces — produces:**

```ts
// contracts/workflows.ts (ids z.uuid(), timestamps z.iso.datetime())
export const WorkflowStepStateSchema = z.enum(['not_started', 'in_progress', 'done', 'skipped']);
export const WorkflowProgressSchema = z.object({ done: z.number().int().min(0), total: z.number().int().min(0) });
export const WorkflowTemplateSchema = z.object({ id, key: z.string(), name: z.string(), builtIn: z.boolean(), latestVersion: z.number().int().min(1) });
export const WorkflowStepSchema = z.object({
  id, key: z.string(), name: z.string(), position: z.number().int().min(0), mandatory: z.boolean(),
  state: WorkflowStepStateSchema, notes: z.string(), updatedAt, completedAt: z.iso.datetime().nullable(),
});
export const AssetWorkflowSchema = z.object({
  id, assetId, templateId, templateName: z.string(), templateVersion: z.number().int().min(1), createdAt,
  progress: WorkflowProgressSchema, steps: z.array(WorkflowStepSchema),   // steps by position
});
export const StepNotesInputSchema = z.string().max(5000);
// + inferred types WorkflowStepState, WorkflowProgress, WorkflowTemplate, WorkflowStep, AssetWorkflow

// contracts/library.ts
AssetTypeSchema    gains defaultWorkflowTemplateId: z.uuid().nullable()
AssetSummarySchema gains workflowProgress: WorkflowProgressSchema.nullable()

// core/ports.ts
export interface StepDefinitionInput { id: string; position: number; key: string; name: string; mandatory: boolean }
export interface TemplateVersion { id: string; templateId: string; version: number; steps: StepDefinitionInput[] } // steps by position
export interface WorkflowTemplateRepository {
  list(): Promise<WorkflowTemplate[]>;                          // by name; only templates with at least one version
  get(id: string): Promise<WorkflowTemplate | null>;
  findByKey(key: string): Promise<{ id: string } | null>;
  insertTemplate(t: { id: string; key: string; name: string; builtIn: boolean; createdAt: string }): Promise<void>;
  hasVersion(templateId: string, version: number): Promise<boolean>;
  /** One transaction: the version row and all its step definitions. */
  insertVersion(v: TemplateVersion & { createdAt: string }): Promise<void>;
  latestVersion(templateId: string): Promise<TemplateVersion | null>;
}
export interface NewWorkflowStep { id: string; stepDefinitionId: string; updatedAt: string }
export interface StepContext { stepId: string; assetId: string; mandatory: boolean; state: WorkflowStepState }
export interface AssetWorkflowRepository {
  /** One transaction: the workflow row and one step row per entry, state 'not_started', notes ''. */
  insert(w: { id: string; assetId: string; templateVersionId: string; createdAt: string }, steps: NewWorkflowStep[]): Promise<void>;
  getByAsset(assetId: string): Promise<AssetWorkflow | null>;
  getStepContext(stepId: string): Promise<StepContext | null>;
  updateStep(stepId: string, patch: { state?: WorkflowStepState; notes?: string; completedAt?: string | null; updatedAt: string }): Promise<void>;
  remove(assetId: string): Promise<boolean>;                     // false if the asset had none
}
// AssetTypeRepository gains:
setDefaultWorkflowTemplateIfUnset(typeKey: string, templateId: string): Promise<void>;
// WorkflowDatabase members added to WorkspaceDatabase: workflowTemplates, assetWorkflows
```

**Schema (migration `0002`; no other changes):**

- `workflow_template`: `id` PK; `key` not null unique; `name` not null; `built_in` integer (boolean) not null; `created_at` not null.
- `workflow_template_version`: `id` PK; `template_id` not null → `workflow_template.id`; `version` integer not null; `created_at` not null; unique (`template_id`, `version`).
- `workflow_step_definition`: `id` PK; `template_version_id` not null → `workflow_template_version.id`; `position` integer not null; `key` not null; `name` not null; `mandatory` integer (boolean) not null; unique (`template_version_id`, `position`) and (`template_version_id`, `key`).
- `asset_type`: add `default_workflow_template_id` text nullable → `workflow_template.id`.
- `asset_workflow`: `id` PK; `asset_id` not null unique → `asset.id`; `template_version_id` not null → `workflow_template_version.id`; `created_at` not null.
- `asset_workflow_step`: `id` PK; `asset_workflow_id` not null → `asset_workflow.id` **on delete cascade**; `step_definition_id` not null → `workflow_step_definition.id`; `state` not null default `'not_started'` with check on the four values; `notes` not null default `''`; `updated_at` not null; `completed_at` nullable; unique (`asset_workflow_id`, `step_definition_id`); check `(state = 'done') = (completed_at is not null)`.

Progress in `getByAsset` and in `AssetRepository.list`: `done` = mandatory steps with state `done`, `total` = mandatory steps; `null` in the list when the asset has no workflow.

- [ ] **Step 1: Write the failing tests.**
  - `schemas.test.ts`: `AssetWorkflowSchema accepts a well-formed workflow and rejects an unknown step state`; `AssetSummarySchema accepts workflowProgress null and { done, total }`.
  - `migration-0002.test.ts` (same technique as `migration-0001.test.ts`: temporary migrations folder with `0000` and `0001` only, seed, then the full folder): `upgrades a phase 2a database` — the seeded asset types and assets are still there, each type has `defaultWorkflowTemplateId: null`, `assets.list` returns the seeded asset with `workflowProgress: null`, `assetWorkflows.getByAsset` is `null`.
  - `workflow-repositories.test.ts`: `insertVersion writes the version and its steps` (`latestVersion` returns them by position); `latestVersion returns the highest version` (insert 1 then 2); `list reports latestVersion and omits templates without a version`; `rejects a duplicate (template, version)` and `a duplicate step key inside one version`; `insert creates one not_started step per definition` (`getByAsset`: steps by position, `templateName`, `templateVersion`, progress `{ done: 0, total: <mandatory count> }`); `an asset cannot have two workflows` (unique violation); `updateStep changes only the given fields`; `progress counts only mandatory done steps` (one mandatory done, one optional done, one optional skipped → `done: 1`); `rejects state done without completed_at` (raw update → throws); `remove deletes the workflow and its steps and nothing else` (step rows gone by raw count; asset row, a file row of the asset and its assignment still there; second `remove` → `false`); `asset list carries workflow progress` (one asset with, one without); `setDefaultWorkflowTemplateIfUnset does not replace an existing default`.
- [ ] **Step 2: Run** the tests — they fail.
- [ ] **Step 3: Implement** contracts and `schema.ts`; run `pnpm --filter @assetforge/persistence db:generate`; check the generated `0002` SQL adds the `asset_type` column without rebuilding or emptying the table (hand-edit to a plain `ALTER TABLE … ADD COLUMN … REFERENCES …` if drizzle-kit generated a rebuild that would not preserve rows; note the edit in a comment at the top).
- [ ] **Step 4: Implement** repositories, the `AssetType` / `AssetSummary` mapping, `openWorkspaceDatabase` wiring, and the fakes (in-memory versions of both new repositories; asset fake reports `workflowProgress`; type fake stores the default). `ensureBuiltInAssetTypes` inserts types with `defaultWorkflowTemplateId: null`.
- [ ] **Step 5: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 6: Commit and push** — `feat(persistence): workflow templates and asset workflows (migration 0002)`.

---

### Task 2: Built-in templates and synchronisation on open

**Model:** sonnet

**Files:**
- Create: `packages/core/src/workflow-templates.ts`
- Modify: `packages/core/src/workspace-manager.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/workflow-templates.test.ts`

**Interfaces — consumes:** `WorkflowTemplateRepository`, `AssetTypeRepository.setDefaultWorkflowTemplateIfUnset` (Task 1).

**Interfaces — produces:**

```ts
export interface BuiltInStep { key: string; name: string; mandatory: boolean }
export interface BuiltInWorkflowTemplate { key: string; name: string; version: number; assetTypeKeys: readonly string[]; steps: readonly BuiltInStep[] }
export const BUILT_IN_WORKFLOW_TEMPLATES: readonly BuiltInWorkflowTemplate[];
export function ensureBuiltInWorkflowTemplates(
  ctx: { database: WorkspaceDatabase; newId(): string; now(): Date },
  definitions?: readonly BuiltInWorkflowTemplate[],   // default BUILT_IN_WORKFLOW_TEMPLATES; parameter exists for tests
): Promise<void>;
export function listWorkflowTemplates(s: WorkspaceSession): Promise<WorkflowTemplate[]>;
```

**Built-in templates, all `version: 1`** (step `key` — name — M mandatory / O optional; array order = `position`):

| `key` / name | `assetTypeKeys` | Steps |
| --- | --- | --- |
| `character` / Character | `character`, `creature` | `references_collected` References collected M · `references_prepared` References prepared O · `character_views_generated` Character views generated M · `model_created` 3D model created M · `retopology_completed` Retopology completed O · `textures_materials_created` Textures / materials created M · `rigging_completed` Rigging completed O · `approved` Approved M |
| `landscape` / Landscape | `landscape` | `references_collected` References collected M · `concept_images_created` Concept images created M · `terrain_created` Terrain created M · `materials_created` Materials created M · `vegetation_details_added` Vegetation and details added O · `approved` Approved M |
| `object` / Object | `building`, `vehicle`, `prop` | `references_collected` References collected M · `concept_images_created` Concept images created M · `model_created` 3D model created M · `textures_materials_created` Textures / materials created M · `approved` Approved M |
| `material` / Material | `material` | `references_collected` References collected M · `texture_set_created` Texture set created M · `material_assembled` Material assembled M · `approved` Approved M |
| `basic` / Basic | `other` | `references_collected` References collected O · `work_completed` Work completed M · `approved` Approved M |

**`ensureBuiltInWorkflowTemplates`:** for each definition: find the template by `key`, insert it (`builtIn: true`) if missing; if (`template`, `version`) is missing, `insertVersion` with fresh step IDs; then `setDefaultWorkflowTemplateIfUnset` for each of its `assetTypeKeys`. Existing rows are never changed. `WorkspaceManager.open` calls it directly after `ensureBuiltInAssetTypes`.

- [ ] **Step 1: Write the failing tests** (fakes): `the built-in definitions are consistent` (unique template keys; unique step keys per template; every template has at least one mandatory step; every asset type key of `BUILT_IN_ASSET_TYPES` appears in exactly one template's `assetTypeKeys`); `opening a workspace installs five templates at version 1 and sets every type's default`; `reopening changes nothing` (same template IDs, same version IDs, same step-definition IDs); `a bumped version is added next to the old one` (call with a copy of `character` at `version: 2` and one step removed → `latestVersion` is 2 with the new steps, version 1's steps are unchanged, template ID unchanged); `does not replace a default that is already set`.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/core test workflow-templates` — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 5: Commit and push** — `feat(core): built-in workflow templates synchronised on open`.

---

### Task 3: Workflow use cases

**Model:** opus

**Files:**
- Create: `packages/core/src/workflows.ts`
- Modify: `packages/core/src/assets.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/workflows.test.ts`, `packages/core/test/projects-assets.test.ts`

**Interfaces — consumes:** Tasks 1 and 2; `getAsset`, `createAsset`, `NotFoundError`, `InvalidOperationError`, `WorkspaceSession` (phase 2a).

**Interfaces — produces:**

```ts
export function startWorkflow(s: WorkspaceSession, assetId: string, templateId?: string): Promise<AssetWorkflow>;
export function getWorkflow(s: WorkspaceSession, assetId: string): Promise<AssetWorkflow | null>;
export function updateWorkflowStep(s: WorkspaceSession, stepId: string, patch: { state?: WorkflowStepState; notes?: string }): Promise<AssetWorkflow>;
export function removeWorkflow(s: WorkspaceSession, assetId: string): Promise<boolean>;
```

Rules:
- `startWorkflow`: unknown asset → `NotFoundError`; asset already has a workflow → `InvalidOperationError`; template = the given one (unknown → `NotFoundError`) or the default of the asset's type (none → `InvalidOperationError`); version = `latestVersion` (none → `InvalidOperationError`); then `assetWorkflows.insert` and return `getByAsset`.
- `getWorkflow`: unknown asset → `NotFoundError`; otherwise the workflow or `null`.
- `updateWorkflowStep`: unknown step → `NotFoundError`; `state: 'skipped'` on a mandatory step → `InvalidOperationError`. When `state` is given: `completedAt` = now if it is `done` and the step was not `done` before, unchanged if it stays `done`, `null` otherwise. A patch without `state` leaves state and `completedAt` alone. `updatedAt` = now. Returns the whole workflow.
- `removeWorkflow`: unknown asset → `NotFoundError`; returns whether there was one.
- `createAsset` (changed): after inserting the asset, if its type has a default template, call `startWorkflow(s, asset.id)`. `updateAsset` does not touch workflows.

- [ ] **Step 1: Write the failing tests** (fakes, advancing clock):
  - `a new asset gets the workflow of its type` (type `character` → template `character`, version 1, eight steps `not_started`, progress `{ done: 0, total: 5 }`).
  - `an asset of a type without a default gets no workflow` (clear the default in the fake) and `can start one by naming a template`.
  - `starting without a template and without a default fails with invalid_operation`; `starting a second workflow fails with invalid_operation`; `an unknown template fails with not_found`.
  - `marking a mandatory step done advances progress and sets completedAt`; `reopening a done step clears completedAt and lowers progress`; `done again sets a new completedAt`; `a notes-only update keeps state and completedAt`.
  - `an optional step can be skipped and does not count`; `skipping a mandatory step fails with invalid_operation and changes nothing`.
  - `steps are independent` (last step `done` while the first is `not_started`).
  - `finishing every mandatory step does not change the asset status` (still `draft`) and `changing the asset status does not change any step`.
  - `changing the asset type keeps the workflow` (template name still Character).
  - `a new template version does not alter a running workflow` (start; `ensureBuiltInWorkflowTemplates` with `character` v2 having fewer steps; the existing workflow still has eight steps, its states and notes, `templateVersion: 1`; a new character asset gets `templateVersion: 2`).
  - `removing a workflow allows starting another template` (remove → `true`; `getWorkflow` → `null`; start with `basic` → three steps; remove on an asset without one → `false`).
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — green.
- [ ] **Step 5: Commit and push** — `feat(core): asset workflows with step states and progress`.

---

### Task 4: IPC channels, handlers and acceptance test

**Model:** sonnet

**Files:**
- Modify: `packages/contracts/src/ipc.ts`, `apps/desktop/src/main/ipc.ts` (`Dialogs`), `apps/desktop/src/main/index.ts` (native dialog), `apps/desktop/src/main/library-handlers.ts`
- Test: `apps/desktop/test/library-ipc.test.ts`, `apps/desktop/test/acceptance.test.ts`

**Interfaces — produces:**

| Channel | Request | Response |
| --- | --- | --- |
| `workflowTemplates:list` | `{}` | `WorkflowTemplate[]` |
| `workflows:get` | `{ assetId }` | `AssetWorkflow \| null` |
| `workflows:start` | `{ assetId, templateId?: uuid }` | `AssetWorkflow` |
| `workflows:updateStep` | `{ stepId, patch: { state?: WorkflowStepState, notes?: StepNotesInput } }` (patch strict) | `AssetWorkflow` |
| `workflows:remove` | `{ assetId }` | `{ removed: boolean }` |

```ts
// Dialogs gains
confirmRemoveWorkflow(assetName: string): Promise<boolean>;
```

`workflows:remove`: load the asset (`not_found` if unknown); no workflow → `{ removed: false }` without a dialog; otherwise ask `confirmRemoveWorkflow(asset.name)` **outside** `manager.exclusive`; on confirmation run `removeWorkflow` inside `exclusive` and return its result. The native dialog in `index.ts` follows the workspace-removal dialog: message `Remove the workflow from "<name>"?`, detail `Step states and notes are deleted. The asset and its files are kept.`, buttons "Remove workflow" and "Cancel", Cancel as default and cancel button. `createLibraryHandlers` takes the dialogs as a second argument.

- [ ] **Step 1: Write the failing tests.**
  - `library-ipc.test.ts`: `returns no_workspace_open for the workflow channels`; `skipping a mandatory step maps to invalid_operation`; `workflows:remove does nothing when the dialog is declined` (fake dialogs → `false`; workflow still there, `{ removed: false }`); `workflows:remove does not ask when there is no workflow`; `workflows:updateStep rejects unknown patch keys as invalid_request`.
  - `acceptance.test.ts`, `describe('phase 2b acceptance')` on real adapters: `traces production progress across a restart` — create a `landscape` asset → `workflows:get` shows Landscape v1 with six steps; set two mandatory steps `done`, one `in_progress` with notes, skip the optional one → progress `{ done: 2, total: 5 }`, and `assets:list` reports the same for that asset; close, new manager, reopen → identical workflow (same step IDs, states, notes, `completedAt`), templates not duplicated (`workflowTemplates:list` has five entries).
  - `upgrades a workspace created before workflows existed`: build a workspace with a temporary migrations folder limited to `0000` + `0001`, create an asset, close; open with the full composition → the asset has `workflowProgress: null`; `workflows:start` without a template gives it its type's workflow.
- [ ] **Step 2: Run** `pnpm --filter @assetforge/desktop test` — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build` — green.
- [ ] **Step 5: Commit and push** — `feat(desktop): IPC for workflows`.

---

### Task 5: Renderer — workflow section and progress column

**Model:** sonnet

**Files:**
- Create: `apps/desktop/src/renderer/src/components/WorkflowSection.tsx`, `apps/desktop/src/renderer/src/progress.ts`
- Modify: `screens/AssetScreen.tsx`, `screens/AssetsScreen.tsx`
- Test: `apps/desktop/test/progress.test.ts`

**Interfaces — consumes:** `useLoad`, `label`, `CommitInput` (phase 2a), the channels of Task 4.

**Interfaces — produces:**

```ts
// progress.ts
export function formatProgress(p: WorkflowProgress | null): string;   // { done: 3, total: 5 } -> '3 / 5'; null -> '–'
// components/WorkflowSection.tsx
export function WorkflowSection(props: { assetId: string; assetTypeId: string }): JSX.Element;
```

Behaviour:
- *With a workflow*: heading "Workflow"; one line with the template name, `v<version>` and `formatProgress`; a `<progress>` element (`value` = done, `max` = total, `aria-label="Workflow progress"`); a list with one row per step in position order: step name, the marker "Optional" for non-mandatory steps, a state select (`aria-label="State of <step name>"`; options labelled with `label()`; `skipped` is offered only for optional steps), and a notes field (`CommitInput`, multiline, max 5000, label `Notes for <step name>`). Each change calls `workflows:updateStep` and replaces the section's data with the returned workflow; a failed save shows the error (`role="alert"`) and restores the last saved value. A "Remove workflow" button (tooltip: "Step states and notes are deleted; asks first") calls `workflows:remove` and reloads.
- *Without a workflow*: a template select (`aria-label="Workflow template"`, options from `workflowTemplates:list`, preselected with the default of the asset's type from `assetTypes:list`) and "Start workflow".
- `AssetScreen` renders the section between the asset's fields and **Projects**. `AssetsScreen` gets a "Progress" column showing `formatProgress(asset.workflowProgress)`.

- [ ] **Step 1: Write the failing test** `progress.test.ts`: `formatProgress({ done: 3, total: 5 }) === '3 / 5'`, `formatProgress({ done: 0, total: 0 }) === '0 / 0'`, `formatProgress(null) === '–'`.
- [ ] **Step 2: Run** — fail. **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm --filter @assetforge/desktop build` — green. Grep the renderer: every `<button` uses `BUTTON`; no instructional paragraph was added.
- [ ] **Step 5: Commit and push** — `feat(desktop): workflow section and progress column`.

---

### Task 6: End-to-end check and documentation

**Model:** controller (the session running the plan), not a subagent.

- [ ] **Step 1: Build and drive the real application** (as in phase 2a Task 11) through: open the workspace left by the 2a check → its existing asset shows no workflow and `–` in the list → start the default workflow → create a new Character asset: the workflow is there immediately with eight steps → set steps to in progress / done, skip an optional one, confirm a mandatory step offers no "Skipped", write notes → progress in the detail and in the list agree → change the asset status and confirm no step changed → remove the workflow (decline once, then confirm) and start "Basic" → close and reopen the workspace: everything is as left. No console errors; the step selects and notes are reachable by keyboard.
- [ ] **Step 2: Update the documentation.** `ReadMe.md` §5: the step states, that only optional steps can be skipped, how built-in templates are versioned and synchronised, what is not built yet (editor, version upgrade, result files); §10 mark what exists. `CLAUDE.md` "Project state": phase 2 implemented. `docs/backlog.md`: add what the task reviews parked.
- [ ] **Step 3: Run** `pnpm test`, `pnpm typecheck` — green. **Commit and push** — `docs: phase 2b state and workflow model`.
- [ ] **Step 4: Final whole-branch review** (most capable model), one fix wave, then finish the branch.
