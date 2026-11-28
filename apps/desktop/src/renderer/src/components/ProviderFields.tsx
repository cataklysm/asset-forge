import {
  MAX_TOKENS_MAX,
  MAX_TOKENS_MIN,
  PROVIDER_EXTRA_MAX,
  PARALLEL_REQUESTS_MAX,
  PARALLEL_REQUESTS_MIN,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  type ProviderKind,
  type ProviderList,
  type ProviderView,
  type Thinking,
} from '@assetforge/contracts';
import {
  API_KEY_LABEL,
  API_KEY_TITLE,
  EXTRA_PARAMETERS_LABEL,
  EXTRA_PARAMETERS_TITLE,
  KEY_REMOVAL_PENDING,
  KEY_STORED,
  MAX_TOKENS_LABEL,
  MAX_TOKENS_TITLE,
  MODEL_PURPOSE_LABELS,
  NO_KEY_STORE_TITLE,
  PARALLEL_REQUESTS_LABEL,
  PARALLEL_REQUESTS_TITLE,
  PROMPT_MODEL_TITLE,
  PROVIDER_KIND_LABEL,
  PROVIDER_KIND_LABELS,
  PROVIDER_KIND_TITLE,
  REMOVE_KEY_LABEL,
  REMOVE_KEY_TITLE,
  STRUCTURED_OUTPUT_LABEL,
  STRUCTURED_OUTPUT_TITLE,
  TAGGING_MODEL_TITLE,
  TEMPERATURE_LABEL,
  TEMPERATURE_TITLE,
  THINKING_LABEL,
  THINKING_LABELS,
  THINKING_TITLE,
  UNDO_REMOVE_KEY_LABEL,
  UNDO_REMOVE_KEY_TITLE,
} from '../labels';
import { KINDS, THINKING, maxTokensOf, parallelRequestsOf, temperatureOf, type ProviderDraft } from '../provider-draft';
import { ALERT, BUTTON_INLINE, FOCUS, INPUT, LABEL, MUTED, SELECT } from '../ui';
import { ModelSelect } from './ModelSelect';
import { NumberField } from './NumberField';

/** Changes some fields of the draft. */
type Update = (patch: Partial<ProviderDraft>) => void;

/** The props of `KindField`. */
interface KindFieldProps {
  /** Null for an entry that is not saved yet. */
  entry: ProviderView | null;
  kind: ProviderKind;
  locked: boolean;
  onChange(kind: ProviderKind): void;
}

/**
 * The kind of the entry: a select for a new entry, plain text for a saved one (a kind never changes).
 *
 * @param props the entry, the typed kind and its handler
 */
export function KindField({ entry, kind, locked, onChange }: KindFieldProps) {
  if (entry !== null) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className={LABEL}>{PROVIDER_KIND_LABEL}</span>
        <span className="text-text" data-kind="">
          {PROVIDER_KIND_LABELS[entry.kind]}
        </span>
      </div>
    );
  }
  return (
    <label className="flex flex-col gap-1" title={PROVIDER_KIND_TITLE}>
      <span className={LABEL}>{PROVIDER_KIND_LABEL}</span>
      <select
        className={`w-48 ${SELECT}`}
        value={kind}
        disabled={locked}
        onChange={(event) => onChange(event.target.value as ProviderKind)}
      >
        {KINDS.map((option) => (
          <option key={option} value={option}>
            {PROVIDER_KIND_LABELS[option]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The props of `StoredKeyRow`. */
interface StoredKeyRowProps {
  /** The text beside the action. */
  text: string;
  /** The action's label. */
  label: string;
  /** The action's tooltip. */
  title: string;
  disabled: boolean;
  onClick(): void;
}

/**
 * The state of the stored key with its one action: remove it on save, or withdraw that removal.
 *
 * @param props the text, the action and its handler
 * @returns the row
 */
function StoredKeyRow({ text, label, title, disabled, onClick }: StoredKeyRowProps) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-sm ${MUTED}`}>{text}</span>
      <button type="button" className={BUTTON_INLINE} title={title} disabled={disabled} onClick={onClick}>
        {label}
      </button>
    </div>
  );
}

/** The props of `ApiKeyField`. */
interface ApiKeyFieldProps {
  entry: ProviderView | null;
  list: ProviderList;
  draft: ProviderDraft;
  locked: boolean;
  busy: boolean;
  update: Update;
}

/**
 * The write-only key field and, while a key is stored, the action that removes it on save or withdraws that removal.
 *
 * @param props the entry, the list, the draft and its handler
 */
export function ApiKeyField({ entry, list, draft, locked, busy, update }: ApiKeyFieldProps) {
  const keyTitle = list.canStoreKey ? API_KEY_TITLE : NO_KEY_STORE_TITLE;
  const stored = entry !== null && entry.hasApiKey;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1" title={keyTitle}>
        <span className={LABEL}>{API_KEY_LABEL}</span>
        <input
          type="password"
          className={INPUT}
          value={draft.apiKey}
          disabled={locked || !list.canStoreKey}
          title={list.canStoreKey ? undefined : NO_KEY_STORE_TITLE}
          autoComplete="off"
          onChange={(event) => update({ apiKey: event.target.value })}
        />
      </label>
      {stored && !draft.clearKey && (
        <StoredKeyRow
          text={KEY_STORED}
          label={REMOVE_KEY_LABEL}
          title={REMOVE_KEY_TITLE}
          disabled={locked || busy}
          onClick={() => update({ clearKey: true, apiKey: '' })}
        />
      )}
      {/* A typed key replaces the stored one, so the removal shows only while the field is empty. */}
      {stored && draft.clearKey && draft.apiKey === '' && (
        <StoredKeyRow
          text={KEY_REMOVAL_PENDING}
          label={UNDO_REMOVE_KEY_LABEL}
          title={UNDO_REMOVE_KEY_TITLE}
          disabled={locked || busy}
          onClick={() => update({ clearKey: false })}
        />
      )}
    </div>
  );
}

/** The props of `VisionFields`. */
interface VisionFieldsProps {
  /** Null for an entry that is not saved yet. */
  entryId: string | null;
  draft: ProviderDraft;
  locked: boolean;
  /** Why the extra parameters cannot be sent; null when they can. */
  extraMessage: string | null;
  update: Update;
}

/**
 * The fields of a vision entry: the two default models and the request options.
 *
 * @param props the entry, the draft and its handler
 */
export function VisionFields({ entryId, draft, locked, extraMessage, update }: VisionFieldsProps) {
  return (
    <>
      <div className="flex flex-col gap-1" title={TAGGING_MODEL_TITLE}>
        <span className={LABEL}>{MODEL_PURPOSE_LABELS.tagging}</span>
        <ModelSelect
          providerId={entryId}
          purpose="tagging"
          value={draft.taggingModel}
          disabled={locked}
          onChange={(taggingModel) => update({ taggingModel })}
        />
      </div>

      <div className="flex flex-col gap-1" title={PROMPT_MODEL_TITLE}>
        <span className={LABEL}>{MODEL_PURPOSE_LABELS.prompt}</span>
        <ModelSelect
          providerId={entryId}
          purpose="prompt"
          value={draft.promptModel}
          disabled={locked}
          // Both selects read the same list: its failure is shown once, below the tagging model.
          showFailure={false}
          onChange={(promptModel) => update({ promptModel })}
        />
      </div>

      <NumberField
        title={TEMPERATURE_TITLE}
        label={TEMPERATURE_LABEL}
        min={TEMPERATURE_MIN}
        max={TEMPERATURE_MAX}
        step={0.1}
        value={draft.temperature}
        disabled={locked}
        invalid={temperatureOf(draft.temperature) === null}
        onChange={(temperature) => update({ temperature })}
      />

      <label className="flex flex-col gap-1" title={THINKING_TITLE}>
        <span className={LABEL}>{THINKING_LABEL}</span>
        <select
          className={`w-48 ${SELECT}`}
          value={draft.thinking}
          disabled={locked}
          onChange={(event) => update({ thinking: event.target.value as Thinking })}
        >
          {THINKING.map((thinking) => (
            <option key={thinking} value={thinking}>
              {THINKING_LABELS[thinking]}
            </option>
          ))}
        </select>
      </label>

      <NumberField
        title={MAX_TOKENS_TITLE}
        label={MAX_TOKENS_LABEL}
        min={MAX_TOKENS_MIN}
        max={MAX_TOKENS_MAX}
        step={1}
        value={draft.maxTokens}
        disabled={locked}
        invalid={maxTokensOf(draft.maxTokens) === undefined}
        onChange={(maxTokens) => update({ maxTokens })}
      />

      <NumberField
        title={PARALLEL_REQUESTS_TITLE}
        label={PARALLEL_REQUESTS_LABEL}
        min={PARALLEL_REQUESTS_MIN}
        max={PARALLEL_REQUESTS_MAX}
        step={1}
        value={draft.parallelRequests}
        disabled={locked}
        invalid={parallelRequestsOf(draft.parallelRequests) === null}
        onChange={(parallelRequests) => update({ parallelRequests })}
      />

      {draft.kind === 'openai' && (
        <label className="flex items-center gap-2 text-sm text-text" title={STRUCTURED_OUTPUT_TITLE}>
          <input
            type="checkbox"
            className={`accent-accent ${FOCUS}`}
            checked={draft.structuredOutput}
            disabled={locked}
            onChange={(event) => update({ structuredOutput: event.target.checked })}
          />
          <span>{STRUCTURED_OUTPUT_LABEL}</span>
        </label>
      )}

      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1" title={EXTRA_PARAMETERS_TITLE}>
          <span className={LABEL}>{EXTRA_PARAMETERS_LABEL}</span>
          <textarea
            className={`font-mono ${INPUT}`}
            rows={4}
            maxLength={PROVIDER_EXTRA_MAX}
            spellCheck={false}
            value={draft.extra}
            disabled={locked}
            aria-invalid={extraMessage !== null || undefined}
            onChange={(event) => update({ extra: event.target.value })}
          />
        </label>
        {extraMessage !== null && (
          <p role="alert" className={ALERT}>
            {extraMessage}
          </p>
        )}
      </div>
    </>
  );
}
