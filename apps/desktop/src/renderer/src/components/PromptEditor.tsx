import { useEffect, useId, useState } from 'react';
import { PROMPT_DESCRIPTION_MAX, PROMPT_TITLE_MAX, type PromptDetail, type PromptVersion } from '@assetforge/contracts';
import { ApiError, call, describeError } from '../api';
import {
  DELETE_LABEL,
  DELETE_PROMPT_TITLE,
  PROMPT_DESCRIPTION_LABEL,
  PROMPT_SECTION_LABEL,
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

/** The props of {@link PromptEditor}. */
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

/** A setter of React state. */
type Setter<T> = (value: T | ((current: T) => T)) => void;

/**
 * The library's fixed messages reach the user as they are; only unexpected errors become the generic text.
 *
 * @param error what the call threw
 * @returns the message to show
 */
function messageOf(error: unknown): string {
  return error instanceof ApiError && error.code !== 'internal_error' ? error.message : describeError(error);
}

/**
 * Whether the editor holds changes that are not saved: never while the prompt loads.
 *
 * @param loading whether the prompt still loads
 * @param detail the loaded prompt; null for a new draft
 * @param draft the draft
 * @returns whether it is dirty
 */
function isDirty(loading: boolean, detail: PromptDetail | null, draft: EditorDraft): boolean {
  if (loading) return false;
  if (detail === null) return newDraftDirty(draft);
  return metaDirty(draft, detail) || versionDirty(draft, detail);
}

/**
 * The loaded prompt, its load error and the draft: loads the prompt when the id is set and follows tag renames.
 *
 * @param promptId the prompt to load; null for a new draft
 * @returns the detail, the load error and the draft with their setters
 */
function usePromptDetail(promptId: string | null) {
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditorDraft>(EMPTY_DRAFT);

  useEffect(() => {
    if (promptId === null) return;
    let live = true;
    call('prompts:get', { promptId }).then(
      (loaded) => {
        if (!live) return;
        setDetail(loaded);
        setDraft(draftOf(loaded));
      },
      (caught: unknown) => {
        if (live) setLoadError(messageOf(caught));
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
  return { detail, setDetail, loadError, draft, setDraft };
}

/** What {@link savePrompt} and {@link removePrompt} work with. */
interface SaveContext {
  detail: PromptDetail | null;
  draft: EditorDraft;
  setDetail: Setter<PromptDetail | null>;
  setDraft: Setter<EditorDraft>;
  setSaving: Setter<boolean>;
  setError: Setter<string | null>;
  onSaved: Props['onSaved'];
}

/**
 * Saves the draft: creates a new prompt, or updates the title and description and, when the text
 * or a default changed, writes a new version against the version that was loaded.
 *
 * @param context the prompt, the draft, the setters and the save callback
 * @returns when the save ended
 */
async function savePrompt({
  detail,
  draft,
  setDetail,
  setDraft,
  setSaving,
  setError,
  onSaved,
}: SaveContext): Promise<void> {
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
      next = await call('prompts:update', {
        promptId: next.id,
        title: draft.title.trim(),
        description: draft.description.trim(),
      });
      setDetail(next);
      updated = next;
    }
    if (versionDirty(draft, next)) {
      next = await call('prompts:saveVersion', { promptId: next.id, baseVersionId: base, content, defaults });
      setDetail(next);
    }
    setDraft(draftOf(next));
    onSaved(next, false);
  } catch (caught) {
    // The title is stored already: the list learns it, the text draft stays.
    if (updated !== null) onSaved(updated, false);
    setError(messageOf(caught));
  } finally {
    setSaving(false);
  }
}

/** What {@link removePrompt} works with. */
interface RemoveContext {
  detail: PromptDetail | null;
  setSaving: Setter<boolean>;
  setError: Setter<string | null>;
  setConfirmingDelete: Setter<boolean>;
  onDeleted: Props['onDeleted'];
}

/**
 * Deletes the prompt and closes the confirmation.
 *
 * @param context the prompt, the setters and the delete callback
 * @returns when the delete ended
 */
async function removePrompt({
  detail,
  setSaving,
  setError,
  setConfirmingDelete,
  onDeleted,
}: RemoveContext): Promise<void> {
  if (detail === null) return;
  setSaving(true);
  setError(null);
  try {
    await call('prompts:delete', { promptId: detail.id });
    setConfirmingDelete(false);
    onDeleted();
  } catch (caught) {
    setConfirmingDelete(false);
    setError(messageOf(caught));
  } finally {
    setSaving(false);
  }
}

/**
 * The editor of one library prompt: title, description, tags, the text with one default per
 * variable, the versions and Delete. One Save writes the title and description and, when the text
 * or a default changed, a new version against the version that was loaded.
 *
 * @param props the prompt, the busy flag and the callbacks
 * @returns the editor
 */
export function PromptEditor({ promptId, busy, onDirtyChange, onSaved, onTagsChanged, onDeleted }: Props) {
  const { detail, setDetail, loadError, draft, setDraft } = usePromptDetail(promptId);
  // An older version shown read-only instead of the draft; null shows the draft.
  const [viewing, setViewing] = useState<PromptVersion | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const textId = useId();

  const loading = promptId !== null && detail === null;
  const dirty = isDirty(loading, detail, draft);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  if (loadError !== null) {
    return (
      <section aria-label={PROMPT_SECTION_LABEL} className="flex flex-col gap-4">
        <p role="alert" className={ALERT}>
          {loadError}
        </p>
      </section>
    );
  }
  if (loading) return <section aria-label={PROMPT_SECTION_LABEL} aria-busy="true" className="flex flex-col gap-4" />;

  async function changeTags(channel: 'prompts:addTag' | 'prompts:removeTag', name: string) {
    if (detail === null) return;
    const next = await call(channel, { promptId: detail.id, name });
    setDetail(next);
    onTagsChanged();
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
    <section aria-label={PROMPT_SECTION_LABEL} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className={LABEL}>{PROMPT_TITLE_LABEL}</span>
        <input
          className={INPUT}
          maxLength={PROMPT_TITLE_MAX}
          readOnly={saving}
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
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
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
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
          {detail !== null && <VersionSelect detail={detail} viewing={viewing} saving={saving} onView={setViewing} />}
        </div>
        <textarea
          id={textId}
          className={TEXTAREA}
          title={PROMPT_TEXT_TITLE}
          readOnly={readOnly}
          value={content}
          onChange={(event) => setDraft({ ...draft, content: event.target.value })}
        />
      </div>
      {variables.length > 0 && (
        <DefaultInputs
          variables={variables}
          readOnly={readOnly}
          onChange={(name, value) => setDraft({ ...draft, defaults: withDefault(draft.defaults, name, value) })}
        />
      )}
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      <EditorButtons
        viewing={viewing}
        canDelete={detail !== null}
        dirty={dirty}
        saving={saving}
        busy={busy}
        onAdopt={adoptVersion}
        onSave={() => void savePrompt({ detail, draft, setDetail, setDraft, setSaving, setError, onSaved })}
        onDelete={() => setConfirmingDelete(true)}
      />
      <ConfirmDialog
        open={confirmingDelete}
        title={DELETE_PROMPT_TITLE}
        confirmLabel={DELETE_LABEL}
        busy={saving}
        onConfirm={() => void removePrompt({ detail, setSaving, setError, setConfirmingDelete, onDeleted })}
        onCancel={() => setConfirmingDelete(false)}
      />
    </section>
  );
}

/** The props of {@link VersionSelect}. */
interface VersionSelectProps {
  detail: PromptDetail;
  /** The older version shown; null while the draft is shown. */
  viewing: PromptVersion | null;
  saving: boolean;
  /** Shows an older version, or the draft with null. */
  onView(version: PromptVersion | null): void;
}

/**
 * The select of the prompt's versions; choosing the current one shows the draft again.
 *
 * @param props the prompt, the version shown, the saving flag and the callback
 * @returns the select
 */
function VersionSelect({ detail, viewing, saving, onView }: VersionSelectProps) {
  return (
    <select
      aria-label={PROMPT_VERSION_LABEL}
      className={SELECT}
      disabled={saving}
      value={viewing?.id ?? detail.currentVersion.id}
      onChange={(event) => {
        // A running save or delete answers with the draft it was sent with; no version is shown meanwhile.
        if (saving) return;
        const chosen = detail.versions.find((version) => version.id === event.target.value);
        onView(chosen === undefined || chosen.id === detail.currentVersion.id ? null : chosen);
      }}
    >
      {detail.versions.map((version) => (
        <option key={version.id} value={version.id}>
          {promptVersionLabel(version.number, version.createdAt)}
        </option>
      ))}
    </select>
  );
}

/** The props of {@link DefaultInputs}. */
interface DefaultInputsProps {
  variables: readonly { name: string; defaultValue: string }[];
  readOnly: boolean;
  /** Sets the default of a variable. */
  onChange(name: string, value: string): void;
}

/**
 * One default input per variable of the text.
 *
 * @param props the variables, the read-only flag and the callback
 * @returns the grid of inputs
 */
function DefaultInputs({ variables, readOnly, onChange }: DefaultInputsProps) {
  return (
    <div className="grid grid-cols-[minmax(6rem,auto)_1fr] items-center gap-x-3 gap-y-2">
      {variables.map((variable) => (
        <label key={variable.name} className="contents">
          <span className={`${LABEL} truncate`}>{variable.name}</span>
          <input
            className={INPUT}
            readOnly={readOnly}
            value={variable.defaultValue}
            onChange={(event) => onChange(variable.name, event.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

/** The props of {@link EditorButtons}. */
interface EditorButtonsProps {
  /** The older version shown; null while the draft is shown. */
  viewing: PromptVersion | null;
  /** Whether the prompt exists, so it can be deleted. */
  canDelete: boolean;
  dirty: boolean;
  saving: boolean;
  busy: boolean;
  onAdopt(version: PromptVersion): void;
  onSave(): void;
  onDelete(): void;
}

/**
 * Save, or `Use this version` while an older version is shown, and Delete for a stored prompt.
 *
 * @param props the state flags and the callbacks
 * @returns the button row
 */
function EditorButtons({ viewing, canDelete, dirty, saving, busy, onAdopt, onSave, onDelete }: EditorButtonsProps) {
  return (
    <div className="flex justify-end gap-2">
      {viewing !== null ? (
        <button type="button" className={BUTTON} disabled={saving} onClick={() => onAdopt(viewing)}>
          {USE_VERSION_LABEL}
        </button>
      ) : (
        <button type="button" className={BUTTON} disabled={!dirty || saving || busy} onClick={onSave}>
          {SAVE_LABEL}
        </button>
      )}
      {canDelete && (
        <button type="button" className={BUTTON} disabled={saving || busy} onClick={onDelete}>
          {DELETE_LABEL}
        </button>
      )}
    </div>
  );
}
