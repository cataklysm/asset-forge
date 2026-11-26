import { RefreshCw } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import {
  JOB_ERROR_MESSAGES,
  MAX_PROVIDERS,
  PROVIDER_NAME_MAX,
  VISION_TIMEOUT_DEFAULT_SECONDS,
  VISION_TIMEOUT_MAX_SECONDS,
  VISION_TIMEOUT_MIN_SECONDS,
  type ProviderList,
  type ProviderView,
  type SaveProvider,
} from '@assetforge/contracts';
import { ApiError, describeError } from '../api';
import {
  API_KEY_LABEL,
  API_KEY_TITLE,
  BASE_URL_LABEL,
  BASE_URL_TITLE,
  DELETE_LABEL,
  DELETE_PROVIDER_TITLE,
  ENTER_BASE_URL,
  ENTER_NAME,
  FROM_ENVIRONMENT,
  FROM_ENVIRONMENT_TITLE,
  KEY_STORED,
  MODEL_PURPOSE_LABELS,
  NEW_PROVIDER_LABEL,
  NEW_PROVIDER_TITLE,
  NO_KEY_STORE_TITLE,
  PROMPT_MODEL_TITLE,
  PROVIDER_LIMIT_TITLE,
  PROVIDER_NAME_LABEL,
  PROVIDER_NAME_TITLE,
  PROVIDER_STATE_LABEL,
  PROVIDER_STATE_LABELS,
  PROVIDERS_LIST_LABEL,
  PROVIDERS_TITLE,
  REMOVE_KEY_LABEL,
  REMOVE_KEY_TITLE,
  RETRY_LABEL,
  SAVE_LABEL,
  SETTINGS_LOAD_FAILED,
  TAGGING_MODEL_TITLE,
  TIMEOUT_INVALID,
  TIMEOUT_LABEL,
  TIMEOUT_TITLE,
  deleteProviderTitle,
} from '../labels';
import { providerStatus, useProviders } from '../provider-context';
import { ALERT, BUTTON, BUTTON_INLINE, ICON_BUTTON, INPUT, LABEL, MUTED, SECTION_TITLE } from '../ui';
import { ConfirmDialog } from './ConfirmDialog';
import { ModelSelect } from './ModelSelect';

/** The selection of the editor for an entry that is not saved yet; never a provider id. */
const NEW = 'new';

/** The fields of one entry, as typed. */
interface Draft {
  name: string;
  baseUrl: string;
  /** Write-only: never filled from the stored entry, cleared after a successful save. */
  apiKey: string;
  /** The stored key is deleted on save. */
  clearKey: boolean;
  timeout: string;
  taggingModel: string | null;
  promptModel: string | null;
}

const draftOf = (view: ProviderView | null): Draft => ({
  name: view?.name ?? '',
  baseUrl: view?.baseUrl ?? '',
  apiKey: '',
  clearKey: false,
  timeout: String(view?.timeoutSeconds ?? VISION_TIMEOUT_DEFAULT_SECONDS),
  taggingModel: view?.taggingModel ?? null,
  promptModel: view?.promptModel ?? null,
});

/** The timeout in seconds, or null when it is not a whole number in range. */
function timeoutOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= VISION_TIMEOUT_MIN_SECONDS && value <= VISION_TIMEOUT_MAX_SECONDS ? value : null;
}

/** Why the draft cannot be saved, or null when it can. */
function invalidReason(draft: Draft): string | null {
  if (draft.name.trim() === '') return ENTER_NAME;
  if (draft.baseUrl.trim() === '') return ENTER_BASE_URL;
  if (timeoutOf(draft.timeout) === null) return TIMEOUT_INVALID;
  return null;
}

/** The host's fixed message of a refusal; other failures as `describeError` puts them. */
function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : describeError(error);
}

/**
 * The provider section of the settings: the entries in store order and an in-place editor of the
 * selected one. Read-only when the environment sets the entry.
 */
export function ProviderSettings() {
  const { list, loading, failed, reload, save, remove } = useProviders();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  /** Runs one action at a time; a refusal shows its message. */
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const select = (id: string) => {
    setError(null);
    setSelectedId(id);
  };

  let body;
  if (list === null) {
    body =
      failed && !loading ? (
        <div className="flex items-start gap-2">
          <p role="alert" className={`flex-1 ${ALERT}`}>
            {SETTINGS_LOAD_FAILED}
          </p>
          <button
            type="button"
            className={ICON_BUTTON}
            title={RETRY_LABEL}
            aria-label={RETRY_LABEL}
            onClick={() => void reload().catch(() => {})}
          >
            <RefreshCw size={16} aria-hidden />
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3" aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} data-skeleton="" className="h-9 animate-pulse rounded-control bg-raised" />
          ))}
        </div>
      );
  } else {
    const locked = list.fromEnvironment;
    const providers = list.providers;
    const selected = selectedId === NEW ? null : (providers.find((p) => p.id === selectedId) ?? providers[0] ?? null);
    const editingNew = selected === null && (selectedId === NEW || (providers.length === 0 && !locked));
    const atLimit = providers.length >= MAX_PROVIDERS;

    body = (
      <div className="flex flex-col gap-4">
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <div className="flex items-start gap-6">
          <div className="flex w-64 shrink-0 flex-col gap-2">
            <ul className="flex flex-col gap-1" aria-label={PROVIDERS_LIST_LABEL}>
              {providers.map((p) => (
                <li key={p.id} className="flex flex-col">
                  <button
                    type="button"
                    className={BUTTON_INLINE}
                    aria-pressed={!editingNew && p.id === selected?.id}
                    disabled={locked || busy}
                    onClick={() => select(p.id)}
                  >
                    <span className="min-w-0 flex-1 truncate text-left">{p.name}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div>
              <button
                type="button"
                className={BUTTON}
                title={atLimit ? PROVIDER_LIMIT_TITLE : NEW_PROVIDER_TITLE}
                disabled={busy || locked || atLimit}
                onClick={() => select(NEW)}
              >
                {NEW_PROVIDER_LABEL}
              </button>
            </div>
          </div>
          {(selected !== null || editingNew) && (
            <Editor
              key={editingNew ? NEW : selected!.id}
              entry={editingNew ? null : selected}
              list={list}
              busy={busy}
              onSave={(input, done) =>
                run(async () => {
                  const view = await save(input);
                  done(view);
                  if (input.id === undefined) setSelectedId(view.id);
                })
              }
              onDelete={() => setConfirming(true)}
            />
          )}
        </div>
        <ConfirmDialog
          open={confirming && selected !== null && !editingNew}
          title={selected === null ? '' : deleteProviderTitle(selected.name)}
          confirmLabel={DELETE_LABEL}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            if (selected === null) return;
            const target = selected;
            void run(async () => {
              try {
                await remove(target.id);
              } finally {
                setConfirming(false);
              }
              setSelectedId(null);
            });
          }}
        />
      </div>
    );
  }

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <div className="flex items-center gap-3">
        <h3 className={SECTION_TITLE}>{PROVIDERS_TITLE}</h3>
        {list?.fromEnvironment === true && (
          <span className={`text-sm ${MUTED}`} title={FROM_ENVIRONMENT_TITLE}>
            {FROM_ENVIRONMENT}
          </span>
        )}
      </div>
      {body}
    </section>
  );
}

interface EditorProps {
  /** Null for an entry that is not saved yet. */
  entry: ProviderView | null;
  list: ProviderList;
  busy: boolean;
  /** Saves `input`; `done` gets the saved entry so the editor can take it. */
  onSave(input: SaveProvider, done: (view: ProviderView) => void): void;
  onDelete(): void;
}

function Editor({ entry, list, busy, onSave, onDelete }: EditorProps) {
  const providers = useProviders();
  const [draft, setDraft] = useState<Draft>(() => draftOf(entry));
  const locked = list.fromEnvironment;
  const reason = invalidReason(draft);
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const keyTitle = list.canStoreKey ? API_KEY_TITLE : NO_KEY_STORE_TITLE;
  const status = entry === null ? null : providerStatus(providers, entry.id);
  const answer = entry === null ? undefined : providers.models[entry.id];
  const failure = answer !== undefined && !answer.ok ? JOB_ERROR_MESSAGES[answer.code] : undefined;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (locked || busy || reason !== null) return;
    const sent = draft;
    const input: SaveProvider = {
      name: sent.name.trim(),
      baseUrl: sent.baseUrl.trim(),
      timeoutSeconds: timeoutOf(sent.timeout)!,
      taggingModel: sent.taggingModel,
      promptModel: sent.promptModel,
    };
    if (entry !== null) input.id = entry.id;
    if (sent.apiKey !== '') input.apiKey = sent.apiKey;
    else if (sent.clearKey) input.apiKey = null;
    onSave(input, (view) =>
      // Edits made while the save ran stay; only the key that was sent leaves the field.
      setDraft((d) => (d === sent ? draftOf(view) : { ...d, apiKey: d.apiKey === sent.apiKey ? '' : d.apiKey, clearKey: false })),
    );
  }

  return (
    <form className="flex min-w-0 flex-1 flex-col gap-4" onSubmit={onSubmit} aria-busy={busy || undefined}>
      <label className="flex flex-col gap-1" title={PROVIDER_NAME_TITLE}>
        <span className={LABEL}>{PROVIDER_NAME_LABEL}</span>
        <input
          type="text"
          className={INPUT}
          value={draft.name}
          maxLength={PROVIDER_NAME_MAX}
          disabled={locked}
          autoComplete="off"
          onChange={(e) => update({ name: e.target.value })}
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
          onChange={(e) => update({ baseUrl: e.target.value })}
        />
      </label>

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
            onChange={(e) => update({ apiKey: e.target.value })}
          />
        </label>
        {entry !== null && entry.hasApiKey && !draft.clearKey && (
          <div className="flex items-center gap-2">
            <span className={`text-sm ${MUTED}`}>{KEY_STORED}</span>
            <button
              type="button"
              className={BUTTON_INLINE}
              title={REMOVE_KEY_TITLE}
              disabled={locked || busy}
              onClick={() => update({ clearKey: true, apiKey: '' })}
            >
              {REMOVE_KEY_LABEL}
            </button>
          </div>
        )}
      </div>

      <label className="flex flex-col gap-1" title={TIMEOUT_TITLE}>
        <span className={LABEL}>{TIMEOUT_LABEL}</span>
        <input
          type="number"
          className={`w-32 ${INPUT}`}
          min={VISION_TIMEOUT_MIN_SECONDS}
          max={VISION_TIMEOUT_MAX_SECONDS}
          step={1}
          value={draft.timeout}
          disabled={locked}
          aria-invalid={timeoutOf(draft.timeout) === null || undefined}
          onChange={(e) => update({ timeout: e.target.value })}
        />
      </label>

      <div className="flex flex-col gap-1" title={TAGGING_MODEL_TITLE}>
        <span className={LABEL}>{MODEL_PURPOSE_LABELS.tagging}</span>
        <ModelSelect
          providerId={entry?.id ?? null}
          purpose="tagging"
          value={draft.taggingModel}
          disabled={locked}
          onChange={(taggingModel) => update({ taggingModel })}
        />
      </div>

      <div className="flex flex-col gap-1" title={PROMPT_MODEL_TITLE}>
        <span className={LABEL}>{MODEL_PURPOSE_LABELS.prompt}</span>
        <ModelSelect
          providerId={entry?.id ?? null}
          purpose="prompt"
          value={draft.promptModel}
          disabled={locked}
          onChange={(promptModel) => update({ promptModel })}
        />
      </div>

      {status !== null && (
        <div className="flex items-center gap-2 text-sm">
          <span className={LABEL}>{PROVIDER_STATE_LABEL}</span>
          <span className="text-text" title={failure}>
            {PROVIDER_STATE_LABELS[status]}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button type="submit" className={BUTTON} disabled={locked || busy || reason !== null} title={reason ?? undefined}>
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
