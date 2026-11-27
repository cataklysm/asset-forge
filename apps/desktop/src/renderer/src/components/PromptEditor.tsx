import { useEffect, useId, useState } from 'react';
import { PROMPT_DESCRIPTION_MAX, PROMPT_TITLE_MAX, type PromptDetail, type PromptVersion } from '@assetforge/contracts';
import { ApiError, call, describeError } from '../api';
import {
  DELETE_LABEL,
  DELETE_PROMPT_TITLE,
  PROMPT_DESCRIPTION_LABEL,
  PROMPT_TAGS_LABEL,
  PROMPT_TEXT_LABEL,
  PROMPT_TEXT_TITLE,
  PROMPT_TITLE_LABEL,
  PROMPT_VERSION_LABEL,
  promptVersionLabel,
  SAVE_LABEL,
  USE_VERSION_LABEL,
} from '../labels';
import {
  defaultsOf,
  draftOf,
  EMPTY_DRAFT,
  metaDirty,
  newDraftDirty,
  variablesOf,
  versionDirty,
  withDefault,
  type EditorDraft,
} from '../prompt-editor-state';
import { renameInTags } from '../tag-rename';
import { useRenamed } from '../tags-context';
import { ALERT, BUTTON, INPUT, LABEL, SELECT, TEXTAREA } from '../ui';
import { ConfirmDialog } from './ConfirmDialog';
import { TagRow } from './TagRow';

interface Props {
  /** The prompt to edit; null for a new draft that Save creates. */
  promptId: string | null;
  /** An import runs: Save, Delete and tag editing are disabled. */
  busy: boolean;
  /** Reports whether the draft holds changes that are not saved. */
  onDirtyChange(dirty: boolean): void;
  /** After a successful save; `created` when it was a new prompt. */
  onSaved(detail: PromptDetail, created: boolean): void;
  onTagsChanged(): void;
  onDeleted(): void;
}

/** The library's fixed messages reach the user as they are; only unexpected errors become the generic text. */
function messageOf(error: unknown): string {
  return error instanceof ApiError && error.code !== 'internal_error' ? error.message : describeError(error);
}

/**
 * The editor of one library prompt: title, description, tags, the text with one default per
 * variable, the versions and Delete. One Save writes the title and description and, when the text
 * or a default changed, a new version against the version that was loaded.
 */
export function PromptEditor({ promptId, busy, onDirtyChange, onSaved, onTagsChanged, onDeleted }: Props) {
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditorDraft>(EMPTY_DRAFT);
  // An older version shown read-only instead of the draft; null shows the draft.
  const [viewing, setViewing] = useState<PromptVersion | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const textId = useId();

  useEffect(() => {
    if (promptId === null) return;
    let live = true;
    call('prompts:get', { promptId }).then(
      (loaded) => {
        if (!live) return;
        setDetail(loaded);
        setDraft(draftOf(loaded));
      },
      (e: unknown) => {
        if (live) setLoadError(messageOf(e));
      },
    );
    return () => {
      live = false;
    };
  }, [promptId]);

  useRenamed((change) =>
    setDetail((current) => {
      if (current === null) return current;
      const tags = renameInTags(current.tags, change);
      return tags === current.tags ? current : { ...current, tags: [...tags] };
    }),
  );

  const loading = promptId !== null && detail === null;
  const dirty = loading ? false : detail === null ? newDraftDirty(draft) : metaDirty(draft, detail) || versionDirty(draft, detail);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  if (loadError !== null) {
    return (
      <section aria-label="Prompt" className="flex flex-col gap-4">
        <p role="alert" className={ALERT}>
          {loadError}
        </p>
      </section>
    );
  }
  if (loading) return <section aria-label="Prompt" aria-busy="true" className="flex flex-col gap-4" />;

  async function save() {
    setSaving(true);
    setError(null);
    const content = draft.content.trim();
    const defaults = defaultsOf({ ...draft, content });
    // The detail answered by a stored title or description update, kept for the case that the new version then fails.
    let updated: PromptDetail | null = null;
    try {
      if (detail === null) {
        const created = await call('prompts:create', {
          title: draft.title.trim(),
          description: draft.description.trim(),
          content,
          defaults,
        });
        onSaved(created, true);
        return;
      }
      const base = detail.currentVersion.id;
      let next = detail;
      if (metaDirty(draft, next)) {
        next = await call('prompts:update', { promptId: next.id, title: draft.title.trim(), description: draft.description.trim() });
        setDetail(next);
        updated = next;
      }
      if (versionDirty(draft, next)) {
        next = await call('prompts:saveVersion', { promptId: next.id, baseVersionId: base, content, defaults });
        setDetail(next);
      }
      setDraft(draftOf(next));
      onSaved(next, false);
    } catch (e) {
      // The title is stored already: the list learns it, the text draft stays.
      if (updated !== null) onSaved(updated, false);
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }

  async function changeTags(channel: 'prompts:addTag' | 'prompts:removeTag', name: string) {
    if (detail === null) return;
    const next = await call(channel, { promptId: detail.id, name });
    setDetail(next);
    onTagsChanged();
  }

  async function remove() {
    if (detail === null) return;
    setSaving(true);
    setError(null);
    try {
      await call('prompts:delete', { promptId: detail.id });
      setConfirmingDelete(false);
      onDeleted();
    } catch (e) {
      setConfirmingDelete(false);
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }

  function adoptVersion(version: PromptVersion) {
    setDraft((current) => ({
      ...current,
      content: version.content,
      defaults: Object.fromEntries(version.variables.map((variable) => [variable.name, variable.defaultValue])),
    }));
    setViewing(null);
  }

  // While a save runs the fields take no typing: its answer replaces the draft it was sent with.
  const readOnly = viewing !== null || saving;
  const content = viewing?.content ?? draft.content;
  const variables = viewing?.variables ?? variablesOf(draft);

  return (
    <section aria-label="Prompt" className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className={LABEL}>{PROMPT_TITLE_LABEL}</span>
        <input
          className={INPUT}
          maxLength={PROMPT_TITLE_MAX}
          readOnly={saving}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={LABEL}>{PROMPT_DESCRIPTION_LABEL}</span>
        <textarea
          rows={2}
          className={`h-auto py-1.5 ${INPUT}`}
          maxLength={PROMPT_DESCRIPTION_MAX}
          readOnly={saving}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>
      {detail !== null && (
        <TagRow
          label={PROMPT_TAGS_LABEL}
          kind="prompt"
          tags={detail.tags}
          disabled={busy}
          onAdd={(name) => changeTags('prompts:addTag', name)}
          onRemove={(name) => changeTags('prompts:removeTag', name)}
        />
      )}
      <div className="flex flex-col gap-1">
        <div className="flex items-end justify-between gap-3">
          <label htmlFor={textId} className={LABEL} title={PROMPT_TEXT_TITLE}>
            {PROMPT_TEXT_LABEL}
          </label>
          {detail !== null && (
            <select
              aria-label={PROMPT_VERSION_LABEL}
              className={SELECT}
              disabled={saving}
              value={viewing?.id ?? detail.currentVersion.id}
              onChange={(e) => {
                // A running save or delete answers with the draft it was sent with; no version is shown meanwhile.
                if (saving) return;
                const chosen = detail.versions.find((version) => version.id === e.target.value);
                setViewing(chosen === undefined || chosen.id === detail.currentVersion.id ? null : chosen);
              }}
            >
              {detail.versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {promptVersionLabel(version.number, version.createdAt)}
                </option>
              ))}
            </select>
          )}
        </div>
        <textarea
          id={textId}
          className={TEXTAREA}
          title={PROMPT_TEXT_TITLE}
          readOnly={readOnly}
          value={content}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
        />
      </div>
      {variables.length > 0 && (
        <div className="grid grid-cols-[minmax(6rem,auto)_1fr] items-center gap-x-3 gap-y-2">
          {variables.map((variable) => (
            <label key={variable.name} className="contents">
              <span className={`${LABEL} truncate`}>{variable.name}</span>
              <input
                className={INPUT}
                readOnly={readOnly}
                value={variable.defaultValue}
                onChange={(e) => setDraft({ ...draft, defaults: withDefault(draft.defaults, variable.name, e.target.value) })}
              />
            </label>
          ))}
        </div>
      )}
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {viewing !== null ? (
          <button type="button" className={BUTTON} disabled={saving} onClick={() => adoptVersion(viewing)}>
            {USE_VERSION_LABEL}
          </button>
        ) : (
          <button type="button" className={BUTTON} disabled={!dirty || saving || busy} onClick={() => void save()}>
            {SAVE_LABEL}
          </button>
        )}
        {detail !== null && (
          <button type="button" className={BUTTON} disabled={saving || busy} onClick={() => setConfirmingDelete(true)}>
            {DELETE_LABEL}
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirmingDelete}
        title={DELETE_PROMPT_TITLE}
        confirmLabel={DELETE_LABEL}
        busy={saving}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmingDelete(false)}
      />
    </section>
  );
}
