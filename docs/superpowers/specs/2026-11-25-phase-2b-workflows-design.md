# Phase 2b – Workflows: Design

Second half of phase 2 (`ReadMe.md` §5, §17). Builds on phase 2a (`2026-11-25-phase-2a-asset-management-design.md`), which must be merged first.

## Intent

An asset's status says where it stands overall; it does not say what has been done. Phase 2b adds production workflows: a list of domain steps per asset, each with its own state and notes, from which progress is derived. Templates are versioned and separate from the workflows running on assets, so improving a template never rewrites history.

## Acceptance criterion (ReadMe §17, part covered by 2b)

Trace status: for any asset, see which production steps are done, in progress, skipped or open, change them, and see the resulting progress — also after closing and reopening the workspace.

## Goals

- **Templates.** `WorkflowTemplate` → versions → step definitions (name, order, mandatory or optional). Built-in templates are defined in `core` and written to the database when a workspace is opened; a changed built-in definition becomes a new version.
- **Default template per asset type.** Each built-in asset type points to a template.
- **Instances.** An asset has at most one workflow, bound to one template version, with one step row per step definition. A new asset gets the workflow of its type automatically; an asset without one (created in 2a) can start one, choosing the template.
- **Step states.** `not_started`, `in_progress`, `done`, `skipped`. Steps are independent of each other (parallel work, any order). Reopening is a normal transition back to `not_started` or `in_progress`. Only optional steps can be skipped. Each step has free-text notes.
- **Progress.** Derived, never stored: mandatory steps that are `done` out of all mandatory steps. Shown on the asset detail and in the asset list.
- **Removing a workflow** from an asset after a native confirmation, so a wrongly chosen template can be replaced.
- **UI.** A workflow section on the asset detail screen; a progress column in the asset list.

## Non-goals

- An editor for templates (ReadMe §18, still open). Templates are built in.
- Moving a running workflow to a newer template version.
- Result files attached to steps. They arrive with generations (phase 5), when there is something that produces step results.
- Jobs, automatic rules that complete a step, notifications.
- Project-specific workflows or approvals; the approval on the project assignment (2a) stays independent.
- Step ordering constraints, dependencies between steps, due dates, assignees.

## Anti-goals

- A template change (new version) altering a running or finished workflow.
- Any code path other than the explicit user action changing a step state — in particular nothing that sets a step to `done` because something else succeeded.
- Coupling the three status concepts: finishing all steps does not change the asset status, and changing the asset status does not touch steps.
- Changing an asset's type silently replacing or deleting its workflow.

## Constraints

- All constraints of phases 1 and 2a hold, including the UI rules (no explanatory text in the layout, one button style).
- One Drizzle migration (`0002`) on top of 2a's `0001`.

## Approaches

**Where templates come from**

1. **Definitions in `core`, synchronised into the database on open — chosen.** Each built-in template has a `key`, a `version` number and its steps. On open, a (`key`, `version`) pair that is missing is inserted. Editing a built-in template means bumping its version in code; existing instances keep pointing at the old version rows. This exercises the versioning that a later editor needs, without an editor.
2. Seed by migration SQL. Rejected: fixed UUIDs in SQL, and every template tweak is a schema migration.
3. Copy the step list into each instance and have no template tables. Rejected: ReadMe §5 and §10 ask for versioned templates separate from instances, and progress across assets would have nothing to group by.

**Step state on the instance**

1. **One row per step, created when the workflow starts — chosen.** Simple queries, progress is one aggregate, and the instance is self-contained once created.
2. Rows only for touched steps. Rejected: every reader has to merge definitions and sparse rows.

## Design

**Data model (migration `0002`).**

| Table | Columns |
| --- | --- |
| `workflow_template` | `id`, `key` (unique), `name`, `built_in`, `created_at` |
| `workflow_template_version` | `id`, `template_id` → `workflow_template`, `version` (unique per template), `created_at` |
| `workflow_step_definition` | `id`, `template_version_id` → `workflow_template_version`, `position`, `key`, `name`, `mandatory`; unique (`template_version_id`, `position`) and (`template_version_id`, `key`) |
| `asset_type` (changed) | adds `default_workflow_template_id` → `workflow_template` (nullable) |
| `asset_workflow` | `id`, `asset_id` → `asset` (unique), `template_version_id` → `workflow_template_version`, `created_at` |
| `asset_workflow_step` | `id`, `asset_workflow_id` → `asset_workflow` (cascade on delete), `step_definition_id` → `workflow_step_definition`, `state`, `notes`, `updated_at`, `completed_at`; unique (`asset_workflow_id`, `step_definition_id`) |

Template, version and step definition rows are immutable once written.

**Built-in templates (version 1).** M = mandatory, O = optional.

| Template (`key`) | Default for | Steps |
| --- | --- | --- |
| Character (`character`) | Character, Creature | References collected (M), References prepared (O), Character views generated (M), 3D model created (M), Retopology completed (O), Textures / materials created (M), Rigging completed (O), Approved (M) |
| Landscape (`landscape`) | Landscape | References collected (M), Concept images created (M), Terrain created (M), Materials created (M), Vegetation and details added (O), Approved (M) |
| Object (`object`) | Building, Vehicle, Prop | References collected (M), Concept images created (M), 3D model created (M), Textures / materials created (M), Approved (M) |
| Material (`material`) | Material | References collected (M), Texture set created (M), Material assembled (M), Approved (M) |
| Basic (`basic`) | Other | References collected (O), Work completed (M), Approved (M) |

**Synchronisation on open.** After the built-in asset types are ensured: for every built-in template, insert the template row if its `key` is missing and the version with its steps if (`key`, `version`) is missing; then set `default_workflow_template_id` on the listed asset types where it is still null.

**Instances.** `startWorkflow(assetId, templateId?)` takes the template given, or the default of the asset's type; uses the template's highest version; creates the instance and its step rows (`not_started`) in one transaction. It fails with `invalid_operation` if the asset already has a workflow or no template can be determined. `createAsset` (2a) calls it when the type has a default. `updateWorkflowStep(stepId, { state?, notes? })` sets `completed_at` when the state becomes `done` and clears it otherwise; skipping a mandatory step fails with `invalid_operation`. `removeWorkflow(assetId)` deletes the instance and its steps.

**Progress.** `{ done, total }` over mandatory steps; `null` when the asset has no workflow. Part of the workflow view and of each asset list item.

**IPC.** `workflowTemplates:list`, `workflows:get`, `workflows:start`, `workflows:updateStep`, `workflows:remove`. Removal asks through a native dialog owned by the main process, like workspace removal.

**UI.** Asset detail gets a *Workflow* section: template name and version, progress (`3 / 5`), and one row per step with its name, a marker for optional steps, a state selector and a notes field. Without a workflow the section shows a template selector (the type's default preselected) and "Start workflow". The asset list gets a progress column.

## Calls made by the builder (not user decisions)

- Templates are built in, without an editor (same reasoning as asset types in 2a).
- The step lists above. Character and Landscape follow the examples in ReadMe §5 (without "Asset created", which is true for every asset); the other three are the builder's.
- The four step states, and that mandatory steps cannot be skipped.
- One workflow per asset; changing the asset type keeps the existing workflow.
- No result files on steps yet.
- Removing a workflow is possible (with confirmation); upgrading it to a newer version is not.

## Left to the implementation plan

Task breakdown, file layout, exact signatures and schemas, test cases, and the model used for each implementation subagent.
