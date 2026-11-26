# Rename and merge tags — design

Status: draft for the owner's approval, 2026-11-26.

## Intent

Tags come from two sources that do not agree on names: the owner's own tagging (`front`) and the vision analysis (`front view`). The owner wants one uniform tag across the whole workspace and wants to fix a name at the moment it catches their eye, without a detour.

## Goals

- **Rename a tag** workspace-wide: every asset and file that carries it shows the new name afterwards.
- **Merge two tags**: renaming a tag to a name that already exists folds it into that tag. Rename and merge are one action.
- The action sits **on the editable tag chips**, where tags are already added and removed: the asset tags on the asset screen, the image tags in the file detail dialog, the shared tags of the inbox selection.
- Before a merge the owner sees that it is a merge and how much it touches.

## Non-goals

- A tags page listing all tags (see "Room for a tags page").
- Mapping future analysis results onto the kept tag, an alias table, or a tag vocabulary appended to prompts (owner decision, 2026-11-26). After a new analysis the owner renames again.
- Undo of a rename or merge, or a history of tag names.
- Renaming from read-only chips (gallery tiles, tables) or from the tag filter.
- Deleting a tag workspace-wide, and cleaning up unused tag rows other than the one a merge empties.

## Anti-goals

- A merge that turns a manual tag into an AI tag, so that a later re-analysis removes what the owner set by hand.
- A rename after which the search still finds the old name, or does not find the new one.
- The old name coming back by itself: through a waiting proposal that is accepted later, or through a file restored from the trash.
- A merge that happens without the owner having seen that the target name already exists.
- A half-applied rename (some owners renamed, others not) after a crash or an error.

## Constraints

- `CLAUDE.md` architecture rules: use case in `core`, repository in `persistence`, validated IPC, fixed error messages, short transactions.
- A tag is one row with a unique normalised `name` and a `displayName`; `asset_tag` and `file_tag` link owners to it with an `origin` (`manual` | `ai`). An owner carries a tag at most once and manual wins (`linkAssetTag`, `linkFileTags` in `packages/persistence/src/tag-repository.ts`).
- The search index (`asset_search`) holds tag names per asset and is kept in step by `reindexAsset` inside the transaction that changes searchable data.
- A waiting proposal (`file_analysis_proposal.tags`) stores tag names as JSON text, not as references.
- UI rules: no explanatory text in the layout (tooltips through `title`), buttons from `ui.ts`, tokens only, labels in `labels.ts`.

## Approaches

1. **On the editable tag chips (chosen by the owner).** A chip that has the remove button also gets a rename button. Small surface, and it is where a wrong tag is noticed while looking through assets and images.
2. **Additionally on every displayed chip and in the tag filter**, through a context menu. Reachable from everywhere, but hidden, and tiles and table rows already have their own click and menu logic. More surface and more to break for little gain; the filter can be added later at low cost.
3. **A tags page now.** The complete overview, but not what the owner asked for first; they want the action where the tag is noticed.

Whatever the entry point, the backend is the same: one use case and one dialog. That keeps approach 3 open (see below).

## Design

### The operation

`renameTag(from, to)`: `from` is the normalised name of an existing tag, `to` is the text the owner typed. `to` is validated and normalised like a new tag (`normalizeTagName`, `cleanTagText`; a letter or digit, at most `MAX_TAG_LENGTH`).

Three cases, decided inside one transaction:

- **Same normalised name** (`Front` → `front` only differs in how it is written): the tag's `displayName` becomes the typed text. Nothing else changes. When the display name is also identical, nothing is written.
- **New name, no tag carries it**: the tag row gets the new `name` and `displayName`. Links are untouched.
- **New name, another tag carries it — merge**: every link of the source tag moves to the target tag; the source tag row is deleted; the target's `displayName` becomes the typed text (the owner wrote how they want it; author's call).

Merge rule per owner (asset or file), following "an owner carries a tag once, manual wins":

- The owner carries only the source: the link moves to the target and keeps its origin and `createdAt`.
- The owner carries both: one link to the target remains. Its origin is `manual` when either was manual, otherwise `ai`; its `createdAt` is the earlier of the two.

All of it — tag rows, `asset_tag`, `file_tag`, proposals, search index — is one database transaction. No file system work is involved.

### Proposals

In the same transaction, every waiting proposal whose tag list contains the source name is rewritten: the entry gets the target's name and display name; when the list then holds the name twice, one entry remains (first position wins). A proposal is otherwise untouched (model, prompt name, checksum, creation time).

### Files in the trash

Their links are renamed and merged like all others (the links stay on a trashed file by design), so a restored file is uniform. They do not count in the numbers shown to the owner, as they do not count in tag suggestions.

### Search index

Every asset affected is reindexed in the transaction: assets carrying the source tag themselves, and assets with a file that carries it. The index stores normalised names, not display names (`packages/persistence/src/search-index.ts`), so a display-name-only change and the target's assets in a merge need no reindex. Trashed files have no asset and need none either.

### Usage numbers

`tagUsage(name)` answers, for one normalised name: whether a tag with that name exists, its display name, and how many assets and how many files (not in the trash) carry it. An asset counts only when it carries the tag itself; a tag on one of its files counts under files (author's call: the two numbers stay separate and add up to what is touched). The dialog uses it for the tag being renamed and, while the owner types, for the name typed.

### IPC (`packages/contracts`)

- `tags:usage` `{ name }` → `{ exists, name, displayName, assets, files }`. `name` is free text; the main process normalises it. A text that is not a valid tag name answers `{ exists: false, … }` with zero counts, not an error, so typing never raises an error.
- `tags:rename` `{ from, to, merge }` → `{ name, displayName, merged }`.
  - `from`: normalised name. Unknown → `not_found`.
  - `to`: invalid → `validation_failed` with the existing fixed message.
  - `merge: boolean` is the owner's confirmation. When the target name exists as another tag and `merge` is `false`, the call is refused with `invalid_operation` and the fixed message `A tag with this name already exists`; nothing is written. This closes the gap between what the dialog showed and what the database holds at the moment of the call. With `merge: true` and no existing target the call is a plain rename.

Both need an open workspace and go through the workspace write path like the other tag channels.

### Renderer

**Chip.** `TagChip` gets an optional `onRename`; when given, a pencil button sits before the remove button (same size and look, `aria-label` `Rename <name>`, tooltip `Rename`). `TagRow` passes it for its chips unless disabled. AI and manual chips both get it: the action is on the tag, not on the assignment. This covers every editable `TagRow`, so the batch "Add tags" dialog of the asset files has it too (author's call: one rule, no exception). The pencil must not change the row's keyboard behaviour: Delete or Backspace removes a tag only while the chip or its remove button has focus, not while the pencil has it.

**Dialog.** One shared `RenameTagDialog` (built on the shared dialog component), opened with a tag name:

```
Rename tag
  Name  [ front                      ]
  front view · 42 images · 3 assets
  Merges with front · 118 images · 5 assets
                          [ Cancel ] [ Merge ]
```

- The name field starts with the tag's display name, selected.
- The first line below it is the tag being renamed with its usage.
- The second line appears only when the typed name belongs to another tag; the confirm button then reads `Merge` instead of `Rename`. The lookup is debounced and superseded like the search (a stale answer is dropped); while the answer for the current text is outstanding the confirm button is disabled.
- The confirm button is disabled for an empty or invalid name and for an unchanged one.
- No second confirmation. The merge line and the button label are the confirmation (owner decision).
- A refusal shows its message in the dialog. `invalid_operation` from a target that appeared meanwhile makes the dialog look the usage up again, so the merge line appears and the owner can confirm.
- `not_found` (the tag vanished meanwhile) shows the message; the dialog can only be closed.

**After the rename.** Everything showing tags must show the new state: the screen the dialog was opened from, lists kept alive behind it (gallery, inbox, projects), the tag filter (a filter on the old name is switched to the new one), and tag suggestions. The builder uses one workspace-wide "tags changed" signal that the tag-showing lists reload on, rather than patching each record in place.

Record copies no list reload reaches — the inbox selection (up to 1000 files, some outside the loaded pages), the open file detail dialog, an open batch tag dialog — are rewritten locally on the same signal with the merge rule: the old name becomes the new name and display name; when the record then carries the tag twice, one remains, manual when either was manual (author's call: deterministic, and no change to the IPC contract). One shared function does this.

### Room for a tags page

Nothing here depends on where the dialog is opened from: the use case takes names, the dialog takes a name. A later page needs one new list query (all tags with usage, sorted and searchable) and opens the same dialog. `tags:usage` deliberately answers for one name only; the list query is the page's own.

### Error handling

Fixed messages only. `not_found` for an unknown source, `validation_failed` for an invalid target, `invalid_operation` for an unconfirmed merge. A failed transaction leaves everything as it was.

### Documentation

ReadMe: the tags section (rename, merge rule, proposals, trash) and the IPC list. `docs/backlog.md`: remove the request and the line "there is no tag rename or merge"; keep "unused tag rows are never deleted" (a merge removes only its own source row). `CLAUDE.md` project state.

## Testing

- Core and persistence: rename to a free name; display-name-only change; merge with owners carrying only the source, only the target, and both, for assets and files, in all four origin combinations (the result is manual when either was); the earlier `createdAt` is kept; the source row is gone after a merge; unknown source; invalid target; target exists with `merge: false` writes nothing; `merge: true` without a target is a rename.
- Search: after a rename and after a merge the old name finds nothing and the new name finds every affected asset, including assets tagged only through a file.
- Proposals: a waiting proposal containing the source is rewritten; one containing both ends with one entry; accepting it afterwards applies the new name; other proposals are untouched.
- Trash: a trashed file's link is renamed; after restore it carries the new name; trashed files are not counted in `tagUsage`.
- Usage: counts for assets and files; an invalid or unknown text answers `exists: false`.
- IPC: both channels validated; no workspace → `no_workspace_open`.
- Renderer (jsdom): the pencil appears only on editable chips; the dialog shows the usage line, shows the merge line and the `Merge` label only for an existing other tag, disables confirm while the lookup is outstanding and for unchanged or invalid names, sends `merge` accordingly; a stale lookup answer is dropped; after success the opening screen and the tag filter show the new name; the inbox selection and an open file detail dialog show the new name, with one chip when the record carried both; Delete on a focused pencil removes nothing; the refusals.

## Left to the builder

- How the "tags changed" signal is carried (a context with a counter, or reuse of an existing reload mechanism).
- How proposals containing a name are found (a `LIKE` prefilter and a JSON parse, or a scan); the number of waiting proposals is small.
- Whether the merge moves links with set-based SQL or per owner; the transaction must stay short for some thousand links.
- The icon and the exact labels, following `labels.ts`.
