# Asset sources — design

Status: draft for the owner's approval, 2026-11-26.

## Intent

The owner collects material for an asset from web pages. They want to note on the asset where it came from, so that they can find the page again later and look by hand whether it offers new material that helps with the design. A source is, as of today, a URL and nothing else; an asset has none, one or several (owner decision, 2026-11-26).

## Goals

- An asset carries a list of source URLs that the owner adds and removes on the asset screen.
- A source is always visible in the asset header and opens in the system browser with one click.

## Non-goals

- Further fields on a source (title, author, licence, note, retrieval date, "last visited").
- Sources on a single file or on a project.
- Sources in the full-text search or as a gallery filter.
- Fetching anything from a source: no download, no page title, no favicon, no reachability or "new material" check. The app never contacts a source.
- Editing a source in place (remove and add again), reordering, and adding several URLs at once.

## Anti-goals

- The renderer being able to make the main process open an arbitrary address or a local program: only a stored source of the open workspace is ever opened, and only `http` or `https`.
- A source URL that carries credentials ending up in the database.

## Constraints

- `CLAUDE.md`: use case in `core`, adapters behind ports, validated IPC, fixed error messages, no persistence logic in the renderer.
- UI rules: no explanatory text in the layout (tooltips through `title`), buttons from `ui.ts`, tokens only, labels in `labels.ts`.
- Removing an asset does not exist, so sources need no deletion rule beyond their own removal.

## Approaches

1. **A "Sources" tab** beside Files, Workflow, Projects and Relations. Fits the screen's structure and stays tidy with many sources, but costs a click before a source can be opened.
2. **Sources in the asset header, under the description (chosen by the owner).** Always visible and one click away. The header grows with the number of sources; a height limit with scrolling bounds that.
3. **Clickable URLs inside the description.** No schema change, but a source would not be a thing of its own: no list, nothing to build on later. Rejected.

## Design

### Data

A new table `asset_source` (migration `0011`): `id`, `asset_id` (references `asset`), `url`, `created_at`; the unique index on (`asset_id`, `url`) also serves lookups by asset. The asset detail record (`assets:get` and every channel that answers the asset) gets `sources: { id, url, createdAt }[]`, ordered by `created_at`, then `id`. The asset list (`assets:list`) does not carry sources. The search index is untouched, so `DERIVED_DATA_VERSION` stays.

### URL rule

Decided in one function in `core`, applied to the trimmed input:

- at most 2000 characters, parseable as a URL, protocol `http:` or `https:`, a non-empty host;
- no user name or password in it;
- stored in the normalised form of the URL parser (`href`), which is also what the uniqueness rule compares.

An asset holds at most 50 sources (author's call).

### Channels

- `assets:addSource` `{ assetId, url }` → the asset. An unusable URL answers `validation_failed` (`This is not a web address`), a URL the asset already has or a full list answers `invalid_operation` (`This source already exists`, `This asset cannot take more sources`), an unknown asset `not_found`.
- `assets:removeSource` `{ assetId, sourceId }` → the asset; an unknown source `not_found`.
- `assets:openSource` `{ assetId, sourceId }` → nothing. The main process reads the stored URL, checks the protocol again and hands it to the system browser (`shell.openExternal` behind a new host action). The renderer never passes a URL to be opened. A failure answers a fixed message (`This source could not be opened`).

Adding and removing a source set the asset's `updated_at`, like every other change to the asset.

### Renderer

A `Sources` block in the asset header, in the row of the description and the asset tags:

```text
Description                 Asset tags                  Sources
A weathered oak door …      [door] [wood] [+ tag]       https://example.org/doors/oak-12        [copy] [x]
                                                        https://textures.example.com/wood…      [copy] [x]
                                                        [ Add URL                             ]
```

- Each source is a link showing the URL, cut with an ellipsis when it is too long, the full URL in the tooltip. A click opens it in the browser.
- Per source two icon buttons: copy the URL to the clipboard, remove (without confirmation, like removing a tag).
- An input `Add URL` below the list; Enter adds. An error shows in the header's alert line, as for the other header fields.
- More than five sources scroll inside the block, so the header's height stays bounded.
- The input and the remove buttons are disabled while an import runs; opening and copying stay possible.
- A failed copy shows `The URL could not be copied` in the block.

### Documentation

ReadMe (asset section and IPC list), `docs/backlog.md` (remove the request, add what is deferred), `CLAUDE.md` project state.

## Testing

- Core: the URL rule (accepted forms; refused: other protocols such as `file:`, `javascript:` and `mailto:`, no host, credentials, over-long, blank); add, duplicate by normalised form, the limit of 50, remove, unknown asset or source; order; `updated_at`.
- Persistence: migration `0011` on an existing database; the unique constraint.
- IPC: argument validation; `assets:openSource` opens exactly the stored URL through the host action, refuses a source of another asset, and reports a host failure with the fixed message; no workspace → `no_workspace_open`.
- Renderer (jsdom): the block lists sources; add, remove, copy and open send the matching request; an error is shown; controls are disabled during an import.

## Left to the builder

- The exact layout of the block within the header row and the icons, following the existing header fields and `ui.ts`.
- How copying reaches the clipboard (the way the app already copies text, if it does).
- Whether the host failure of `shell.openExternal` maps to an existing error code or a new one.
