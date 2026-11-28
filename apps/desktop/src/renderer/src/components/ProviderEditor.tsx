import { useState, type FormEvent } from 'react';
import {
  JOB_ERROR_MESSAGES,
  PROVIDER_NAME_MAX,
  VISION_TIMEOUT_MAX_SECONDS,
  VISION_TIMEOUT_MIN_SECONDS,
  type ProviderList,
  type ProviderView,
  type SaveProvider,
} from '@assetforge/contracts';
import {
  BASE_URL_LABEL,
  BASE_URL_TITLE,
  DELETE_LABEL,
  DELETE_PROVIDER_TITLE,
  EDIT_MODEL_LABEL,
  EDIT_MODEL_TITLE,
  OPENAI_BASE_URL_PLACEHOLDER,
  PROVIDER_NAME_LABEL,
  PROVIDER_NAME_TITLE,
  PROVIDER_STATE_LABEL,
  PROVIDER_STATE_LABELS,
  SAVE_LABEL,
  TIMEOUT_LABEL,
  TIMEOUT_TITLE,
} from '../labels';
import { providerStatus, useProviders, type ProvidersState } from '../provider-context';
import {
  draftAfterSave,
  draftOf,
  draftWithKind,
  extraMessageOf,
  invalidReason,
  saveInputOf,
  timeoutOf,
  type ProviderDraft,
} from '../provider-draft';
import { BUTTON, INPUT, LABEL } from '../ui';
import { ApiKeyField, KindField, VisionFields } from './ProviderFields';
import { EditModelSelect } from './ModelSelect';
import { NumberField } from './NumberField';

/** The props of `ProviderEditor`. */
interface Props {
  /** Null for an entry that is not saved yet. */
  entry: ProviderView | null;
  list: ProviderList;
  busy: boolean;
  /** Saves `input`; `done` gets the saved entry so the editor can take it. */
  onSave(input: SaveProvider, done: (view: ProviderView) => void): void;
  onDelete(): void;
}

/**
 * Why the model list of the entry could not be read, as the tooltip of its state.
 *
 * @param providers the provider state
 * @param entry the entry; null for one not saved yet
 * @param draft the draft, whose kind says which list applies
 * @returns the message, undefined when the list was read or is not asked
 */
function modelsFailure(
  providers: ProvidersState,
  entry: ProviderView | null,
  draft: ProviderDraft,
): string | undefined {
  if (entry === null) return undefined;
  const answer = draft.kind === 'venice' ? providers.imageModels[entry.id] : providers.models[entry.id];
  if (answer === undefined || answer === 'checking' || answer.ok) return undefined;
  return JOB_ERROR_MESSAGES[answer.code];
}

/**
 * The in-place editor of one provider entry; mounted anew for every entry.
 *
 * @param props the entry, the list, the busy state and the save and delete handlers
 */
export function ProviderEditor({ entry, list, busy, onSave, onDelete }: Props) {
  const providers = useProviders();
  const [draft, setDraft] = useState<ProviderDraft>(() => draftOf(entry));
  const locked = list.fromEnvironment;
  const reason = invalidReason(draft);
  const update = (patch: Partial<ProviderDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const status = entry === null ? null : providerStatus(providers, entry.id);
  const failure = modelsFailure(providers, entry, draft);

  /**
   * Sends the draft unless it is locked, busy or invalid.
   *
   * @param event the submit event
   */
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (locked || busy || reason !== null) return;
    const sent = draft;
    onSave(saveInputOf(sent, entry), (view) => setDraft((current) => draftAfterSave(current, sent, view)));
  }

  return (
    <form className="flex min-w-0 flex-1 flex-col gap-4" onSubmit={onSubmit} aria-busy={busy || undefined}>
      <KindField
        entry={entry}
        kind={draft.kind}
        locked={locked}
        onChange={(kind) => setDraft((current) => draftWithKind(current, kind))}
      />

      <label className="flex flex-col gap-1" title={PROVIDER_NAME_TITLE}>
        <span className={LABEL}>{PROVIDER_NAME_LABEL}</span>
        <input
          type="text"
          className={INPUT}
          value={draft.name}
          maxLength={PROVIDER_NAME_MAX}
          disabled={locked}
          autoComplete="off"
          onChange={(event) => update({ name: event.target.value })}
        />
      </label>

      <label className="flex flex-col gap-1" title={BASE_URL_TITLE}>
        <span className={LABEL}>{BASE_URL_LABEL}</span>
        <input
          type="text"
          className={INPUT}
          value={draft.baseUrl}
          disabled={locked}
          spellCheck={false}
          autoComplete="off"
          placeholder={draft.kind === 'openai' ? OPENAI_BASE_URL_PLACEHOLDER : undefined}
          onChange={(event) => update({ baseUrl: event.target.value })}
        />
      </label>

      <ApiKeyField entry={entry} list={list} draft={draft} locked={locked} busy={busy} update={update} />

      <NumberField
        title={TIMEOUT_TITLE}
        label={TIMEOUT_LABEL}
        min={VISION_TIMEOUT_MIN_SECONDS}
        max={VISION_TIMEOUT_MAX_SECONDS}
        step={1}
        value={draft.timeout}
        disabled={locked}
        invalid={timeoutOf(draft.timeout) === null}
        onChange={(timeout) => update({ timeout })}
      />

      {draft.kind === 'venice' ? (
        <div className="flex flex-col gap-1" title={EDIT_MODEL_TITLE}>
          <span className={LABEL}>{EDIT_MODEL_LABEL}</span>
          <EditModelSelect
            providerId={entry?.id ?? null}
            value={draft.editModel}
            disabled={locked}
            onChange={(editModel) => update({ editModel })}
          />
        </div>
      ) : (
        <VisionFields
          entryId={entry?.id ?? null}
          draft={draft}
          locked={locked}
          extraMessage={extraMessageOf(draft)}
          update={update}
        />
      )}

      {status !== null && (
        <div className="flex items-center gap-2 text-sm">
          <span className={LABEL}>{PROVIDER_STATE_LABEL}</span>
          <span className="text-text" title={failure}>
            {PROVIDER_STATE_LABELS[status]}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          className={BUTTON}
          disabled={locked || busy || reason !== null}
          title={reason ?? undefined}
        >
          {SAVE_LABEL}
        </button>
        <button
          type="button"
          className={BUTTON}
          title={DELETE_PROVIDER_TITLE}
          disabled={locked || busy || entry === null}
          onClick={onDelete}
        >
          {DELETE_LABEL}
        </button>
      </div>
    </form>
  );
}
