# Prompt library (phase 5b) — design

Status: draft for the owner's approval, 2026-11-27. The owner asked for a draft straight from `ReadMe.md` §7.1, so every decision below that the ReadMe does not make is the author's call and is marked as such.

## Intent

The owner runs series in the generation studio: one source image, many edits, most of them kept. The prompts of such a series are mostly the same text with a few changing parts (the character, the view, the pose). Today a prompt lives only in the studio's text field and in the list of the 20 prompts used last. The prompt library makes a prompt a thing of its own in the workspace: it has a title, can be found again, has changing parts as variables, and every change of its text is kept as a version, so that a result can say which prompt and which version produced it.

## Goals

- Prompts are workspace entities with title, description, tags and a text with variables (`{{name}}`).
- Every change of the text is a new, immutable version; older versions stay readable and can be brought back.
- The studio can use a library prompt: choose it, fill its variables, generate.
- A generation records the prompt version used, the values of the variables and (as today) the fully resolved text, and the record survives the deletion of the prompt.
- A prompt typed freely in the studio can be saved to the library from there.

## Non-goals

- Negative prompts. The only image provider (Venice edit) takes none, so the field would have no consumer; the version row is the seam for it (author's call).
- Parameters stored with a prompt (model, aspect ratio, resolution). They stay in the studio form and on the generation.
- Variables with a type, a list of allowed values, or nesting; conditionals or any logic in a template.
- Sharing prompts between workspaces, import and export.
- Saving the text of "Image to prompt" to the library directly (it can be copied into a new prompt by hand).
- Using library prompts for the analysis. The analysis prompts of §6.1 stay a separate, app-level thing, and the UI keeps calling them "analysis prompts".
- A link from a prompt to assets or projects, and a list of the generations that used a prompt.
- Text-to-image without a source image (the studio still needs a source).

## Anti-goals

- A generation record that names a version whose text is not what was sent. The resolved text is always computed in the main process from the stored version and the given values, never taken from the renderer together with a version reference.
- A version that changes after it was written.
- Deleting a prompt changing or hiding what an existing result says about its origin.

## Constraints

- `CLAUDE.md`: use cases in `core`, adapters behind ports, validated IPC, fixed error messages, no persistence logic in the renderer, short transactions.
- UI rules: no explanatory text in the layout (tooltips through `title`), buttons from `ui.ts`, tokens only, labels in `labels.ts`.
- Phase 5a stays valid: `generation.prompt` is the fully resolved text, 1 to 8000 characters after trim and at most the model's own limit; a retry reuses the stored text and never resolves again.
- Tags keep one namespace: a prompt uses the existing `tag` table, so rename and merge must cover prompts.

## Approaches

1. **Versioned prompts in the workspace database, resolved in the main process (chosen).** Tables `prompt` and `prompt_version`; the studio sends a version id and variable values, core resolves, validates and stores. This is what §7.1 and the domain invariant ("a generation stores both the prompt version and the fully resolved prompt") ask for. It costs a migration, a screen and a second way to start an edit.
2. **Named prompts at app level, like the analysis prompts** (`userData`, no versions). Much smaller, but it contradicts §7.1 (workspace entity, versions), and a result could not name the text version that produced it. Rejected.
3. **Templates resolved in the renderer; the generation stores only the resolved text plus a prompt title.** No second start path, but the record's link to a version would be a claim of the renderer, not a fact. Rejected (anti-goal).

## Design

### Data (migration `0014`)

`prompt`: `id`, `title`, `title_key` (unique), `description`, `created_at`, `updated_at`.

`prompt_version`: `id`, `prompt_id` (references `prompt`, cascade), `number` (1, 2, 3 … per prompt, unique with `prompt_id`), `content`, `variables` (JSON, see below), `created_at`. Rows are never updated. The current version of a prompt is the one with the highest number.

`prompt_tag`: `prompt_id` (cascade), `tag_id`, `created_at`; primary key on both. Prompt tags are always manual, so there is no origin column.

`generation` gets four nullable columns: `prompt_version_id` (references `prompt_version`, `set null`), `prompt_title`, `prompt_version_number` and `prompt_variables` (JSON `{ v: 1, values: { <name>: <value> } }`). Title and number are copies taken at start, so the record still names its origin after the prompt was renamed or deleted. All four are null for an upscale and for an edit with a free prompt.

### Rules (in `packages/core/src/prompts.ts`, author's calls)

- Title: trimmed, 1 to 120 characters, unique per workspace regardless of case. A column `title_key` (the lower-cased title) with a unique index enforces it; core checks first and answers the fixed message, and a save that keeps a prompt's own title is allowed.
- Description: trimmed, 0 to 2000 characters.
- Content: 1 to 8000 characters after trim (`GENERATION_PROMPT_MAX`), stored trimmed.
- A variable is `{{name}}` where the name, after trimming the inside of the braces, is 1 to 40 characters of letters, digits, spaces, `-` and `_`. Names compare regardless of case; the spelling of the first occurrence is the one shown. Braces that do not form a variable are plain text; there is no escape.
- A version holds at most 20 distinct variables. `variables` is `{ v: 1, items: [{ name, defaultValue }] }` in order of first occurrence, written by core from the content; `defaultValue` (0 to 2000 characters) is what the studio prefills. A default for a name that does not occur in the content is dropped; a default given under another spelling of an occurring name is matched to it regardless of case.
- Resolving (`resolvePrompt(version, values)`): every variable needs a value that is not empty after trim, 1 to 2000 characters; a value for an unknown name is refused; each occurrence is replaced by the trimmed value, in one pass (a value containing `{{x}}` is not resolved again). The result must satisfy the phase 5a prompt rule.
- At most 50 tags per prompt (the asset rule).
- No limit on the number of prompts or versions.

### Versions

- `prompts:create` writes the prompt and version 1.
- Saving text or defaults (`prompts:saveVersion`) writes a new version when content or defaults differ from the current version, and nothing when they are equal (compared after the rules above: trimmed content, and the `variables` items as core would write them). The call carries the id of the version the editor started from; when that is not the current one any more the save answers `invalid_operation` (`This prompt was changed in the meantime`).
- Title, description and tags are not versioned; changing them sets `updated_at` only.
- Bringing an old version back is saving its content and defaults as a new version; history is never rewritten and a single version cannot be deleted.
- Deleting a prompt (`prompts:delete`) deletes the prompt, its versions and its tag links in one transaction; generations keep `prompt_title`, `prompt_version_number`, `prompt_variables` and the resolved text, and their `prompt_version_id` becomes null. Deleting is confirmed through `ConfirmDialog`. There is no trash for prompts (author's call: the text of every used version survives in the generations).

### Tags and search

- `prompts:addTag` / `prompts:removeTag` work like the asset channels, origin always manual. `tags:suggest` today joins only `asset_tag` and `file_tag`; its query also takes tags carried by a prompt, so a tag that only prompts carry is suggested everywhere.
- `tags:rename` moves and merges `prompt_tag` links in the same transaction. The existing merge helpers are built around the `origin` column, so `prompt_tag` gets its own simple path: links move to the kept tag, a prompt carrying both keeps one link with the earlier `created_at`. Prompts are not part of the affected assets (no reindex), but a prompt whose links changed gets no new `updated_at`. `tags:usage` gets a third count, `prompts` (`TagUsageSchema`), and the usage line of `RenameTagDialog` names it like the other two.
- `prompts:list` takes `query` and `tagNames`. The query matches, regardless of case, every word as a substring of the title, the description, the current version's content or a tag's display name (plain `LIKE`, no FTS table: the library holds hundreds of rows, not hundreds of thousands — author's call). All given tags must be on the prompt. Order: `updated_at` descending, then `id`; paged like the other lists with a cursor of both values. A row edited while the list is being paged may move; the list reloads after every save of the screen itself, so this is accepted.
- The asset search index and `DERIVED_DATA_VERSION` are untouched. Prompts do not appear in the asset gallery search.

### Channels (all need an open workspace)

- `prompts:list` `{ query?, tagNames?, cursor?, limit }` → `{ items: PromptSummary[], nextCursor }`; a summary is `{ id, title, description, tags, currentVersion: { id, number, content, variables, createdAt }, updatedAt }`.
- `prompts:get` `{ promptId }` → `PromptDetail`: the summary plus `versions` (all, newest first, each with content and variables) and `createdAt`.
- `prompts:create` `{ title, description, content, defaults }` → the detail. `defaults` is `{ <name>: <defaultValue> }`.
- `prompts:update` `{ promptId, title, description }` → the detail.
- `prompts:saveVersion` `{ promptId, baseVersionId, content, defaults }` → the detail.
- `prompts:delete` `{ promptId }` → nothing.
- `prompts:addTag` / `prompts:removeTag` `{ promptId, name }` → the detail.
- Errors: unknown prompt or version `not_found`; a broken rule `validation_failed` with one fixed message per rule (`A prompt needs a title`, `A prompt needs a text`, `This title is already used`, `A prompt can have at most 20 variables`, `This text is too long`); never a cause or a value in the message.

`generations:start` for an edit takes either `prompt` (as today, with its transport bound) or `promptVersionId` plus `variables` (`{ <name>: <value> }`, required with a version and `{}` for a version without variables; names match regardless of case). Exactly one of the two forms must be present, expressed as a refinement of the edit request schema, so both or neither answers `invalid_request`. With a version, the main process reads it (`not_found` when it is gone), resolves it (`validation_failed`: `Every variable needs a value`, or the existing prompt messages for the resolved text) and stores the resolved text together with the four new columns. The position of the prompt checks in the order of checks stays where the prompt check is today. `Generation` gets `promptVersionId`, `promptTitle`, `promptVersionNumber` and `promptVariables` (all nullable). `generations:retry` reuses the stored text, resolves nothing again and leaves the four columns as they are (also a version id that became null). No further channel is needed for `Use settings`: a non-null `promptVersionId` on the record always names an existing version, because deleting a prompt sets it to null; the studio then loads the prompt through `prompts:get` (the record's version may be an older one of that prompt). `generations:recentPrompts` is unchanged (resolved texts).

### Renderer

**Prompts screen** (navigation entry `Prompts`, between Projects and Jobs — author's call):

- Left: search field, tag filter, `New`, and the list (title, the first line of the text, tags), endless through `usePagedList`.
- Right, for the selected prompt: title and description (saved through `prompts:update` with Save), tags (`TagRow`, with the rename pencil), the text in a textarea, below it one line per variable found in the text with an input for its default, and Save, which is enabled when text or defaults differ from the current version and writes a new version. A version select beside the text (`v3 · <date>`, newest first) shows an older version read-only with `Use this version` (loads its text and defaults into the editor as unsaved changes). `Delete` with confirmation. Leaving a prompt with unsaved changes asks through `ConfirmDialog`.
- No explanatory text; the variable syntax is the tooltip of the text label.

**Studio form:**

- Above the prompt field a `Prompt` select replaces nothing and sits beside the recent prompts select: it opens a small picker (search field and list, the same query as the screen) to choose a library prompt.
- With a library prompt chosen the form shows its title with the version number, one input per variable (prefilled with the default, then with the value typed last for that variable name in this studio session), and the resolved text read-only in the prompt field. Generate is blocked, with the reason as tooltip, while a variable is empty or the resolved text breaks the limit. Generate sends `promptVersionId` and `variables`.
- `Edit text` detaches: the resolved text becomes a free prompt in the field and nothing of the link is sent any more; the form remembers which prompt the text came from until another prompt is chosen. Choosing a recent prompt replaces the text and forgets that origin.
- Values typed for a variable are remembered per name regardless of case, in memory for as long as the studio provider lives.
- With a free prompt the form offers `Save to library`: a small dialog asking for a title (and, when the form remembers the prompt the text was detached from and that prompt still exists, the choice `New version of <title>` instead of a new prompt). After saving, the form is attached to the new version.
- `Use settings` on a result restores the library prompt and its values when the version still exists, otherwise the resolved text as a free prompt.
- The studio always uses the version it has loaded; when a newer one exists the title line says so in its tooltip and a click on it loads the current version.

**Generation details** (file detail dialog, `Generated from`): beside the prompt text the title and version (`<title> v<n>`), as a link to the Prompts screen when the prompt still exists, as plain text otherwise; the variable values in the tooltip of that line. The studio's result tile tooltips are unchanged.

### Documentation

`ReadMe.md` §7.1 ("Implemented so far"), §7.2 (start request, record), §10 and §17; `docs/backlog.md` with the leftovers; the project state in `CLAUDE.md`.

## Left to the builder

- Component and file split in the renderer, the exact layout of the Prompts screen and of the picker.
- The repository port shape (`PromptRepository` as `database.prompts`) and query details.
- Whether the picker is a `Menu`-like popover or a small `Dialog`.

## Testing

- Core: variable parsing (case, spaces, broken braces, 20-variable limit), resolving (missing, empty, unknown value, one pass only, limit of the resolved text), version rules (equal content writes nothing, stale base refused).
- Persistence: migration `0014` on a phase 5a database; cascade on prompt delete with `set null` on generations and the copies kept; tag rename and merge over `prompt_tag`; list query and tags filter.
- Desktop IPC: every channel with its error codes; `generations:start` with a version (record columns, resolved text sent to the mock provider), with both or neither prompt form, with a deleted version.
- Renderer: the screen (create, save a version, old version back, delete, unsaved-changes guard), the studio (choose, fill, blocked states, detach, save to library, use settings), the details line with and without an existing prompt.

## Amendments from planning

Settled while writing the plan (`docs/superpowers/plans/2026-11-27-prompt-library.md`); where they differ from the text above, these win.

1. **Paging.** `prompts:list` takes `{ query?, tagNames?, offset, limit }` and answers `{ items, total }`, like `projects:list`. The renderer's `usePagedList` pages by offset and total; a cursor would need a second list hook for no gain at this size.
2. **Prompt id on the generation.** `Generation` carries `promptId` beside the four stored fields. It is read through the version row (no column) and is null as soon as the version is gone; the details link and `Use settings` need it.
3. **Navigation position.** The `Prompts` entry sits directly after `Projects`, before Inbox.
4. **Further messages.** A value for a name the version does not hold, or two keys for one variable, answers `This prompt has no such variable`; a title, description, default or value over its limit answers `This text is too long`; the 51st tag answers `This prompt cannot take more tags`; an unknown version at `generations:start` answers `not_found`.
5. **Template rules live in `packages/contracts`.** Finding variables and resolving are pure functions there, so the studio preview and the main process share one implementation; core turns their outcomes into errors. In DTOs `variables` is a plain array and `promptVariables` a plain record; the `{ v: 1, … }` wrappers exist only in the database columns.
6. **Unsaved changes.** The guard covers choosing another prompt, `New` and the main navigation. Closing the window is not guarded (backlog).
