import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  VISION_TIMEOUT_MAX_SECONDS,
  VISION_TIMEOUT_MIN_SECONDS,
  type SetVisionSettings,
  type VisionSettingsView,
} from '@assetforge/contracts';
import { describeError } from '../api';
import { ModelSelect } from '../components/ModelSelect';
import { Page } from '../components/Page';
import { MODEL_PURPOSE_LABELS } from '../labels';
import { useProvider } from '../provider-context';
import { ALERT, BUTTON, BUTTON_INLINE, INPUT, LABEL, MUTED, SECTION_TITLE } from '../ui';

interface Form {
  baseUrl: string;
  /** Write-only: never filled from the stored settings, cleared after a successful save. */
  apiKey: string;
  timeout: string;
  taggingModel: string | null;
  promptModel: string | null;
}

const formOf = (view: VisionSettingsView): Form => ({
  baseUrl: view.baseUrl ?? '',
  apiKey: '',
  timeout: String(view.timeoutSeconds),
  taggingModel: view.taggingModel,
  promptModel: view.promptModel,
});

/** The timeout in seconds, or null when it is not a whole number in range. */
function timeoutOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= VISION_TIMEOUT_MIN_SECONDS && value <= VISION_TIMEOUT_MAX_SECONDS ? value : null;
}

const TITLES = {
  baseUrl: 'Address of the Ollama-compatible vision server (http or https)',
  apiKey: 'Sent as a bearer token to this server only; a stored key is never shown again',
  noKeyStore: 'The system credential store is not available, so no key can be saved',
  timeout: `Seconds to wait for one answer (${VISION_TIMEOUT_MIN_SECONDS}–${VISION_TIMEOUT_MAX_SECONDS})`,
  tagging: 'Model that tags images',
  prompt: 'Model that writes a prompt from an image',
  environment: 'The settings come from the environment and cannot be changed here',
  test: 'Saves, then asks the server for its models',
};

/** App-level settings of the vision provider. */
export function SettingsScreen() {
  const { settings, models, loading, reload, refreshModels, save } = useProvider();
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  // The form starts from the first settings that arrive; later reloads keep the edits.
  useEffect(() => {
    if (form === null && settings !== null) setForm(formOf(settings));
  }, [form, settings]);

  if (settings === null || form === null) {
    return (
      <Page title="Settings">
        {loading || settings !== null ? (
          <div className="flex max-w-xl flex-col gap-3" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} data-skeleton="" className="h-9 animate-pulse rounded-control bg-raised" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3">
            {error !== null && (
              <p role="alert" className={ALERT}>
                {error}
              </p>
            )}
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                setError(null);
                reload().catch((e: unknown) => setError(describeError(e)));
              }}
            >
              Retry
            </button>
          </div>
        )}
      </Page>
    );
  }

  const current = form;
  const locked = settings.fromEnvironment;
  const timeoutSeconds = timeoutOf(current.timeout);
  const blocked = locked || busy;
  const update = (patch: Partial<Form>) => setForm({ ...current, ...patch });

  /** `apiKey` undefined: keep the stored key (or send the typed one); null: delete it. */
  async function submit(apiKey: string | null | undefined, test: boolean) {
    if (busyRef.current || timeoutSeconds === null) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const typed = current.apiKey;
    const input: SetVisionSettings = {
      baseUrl: current.baseUrl.trim() === '' ? null : current.baseUrl.trim(),
      timeoutSeconds,
      taggingModel: current.taggingModel,
      promptModel: current.promptModel,
    };
    if (apiKey === null) input.apiKey = null;
    else if (typed !== '') input.apiKey = typed;
    try {
      const view = await save(input);
      setForm(formOf(view));
      if (test) {
        await refreshModels();
        setTested(true);
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!blocked) void submit(undefined, false);
  }

  const modelCount = tested && models !== null && models.ok ? models.models.length : null;

  return (
    <Page title="Settings">
      <form className="flex max-w-xl flex-col gap-4" onSubmit={onSubmit} aria-busy={busy || undefined}>
        <div className="flex items-center gap-3">
          <h3 className={SECTION_TITLE}>Vision provider</h3>
          {locked && (
            <span className={`text-sm ${MUTED}`} title={TITLES.environment}>
              From environment
            </span>
          )}
        </div>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}

        <label className="flex flex-col gap-1" title={TITLES.baseUrl}>
          <span className={LABEL}>Base URL</span>
          <input
            type="text"
            className={INPUT}
            value={current.baseUrl}
            disabled={locked}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => update({ baseUrl: e.target.value })}
          />
        </label>

        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1" title={settings.canStoreKey ? TITLES.apiKey : TITLES.noKeyStore}>
            <span className={LABEL}>API key</span>
            <input
              type="password"
              className={INPUT}
              value={current.apiKey}
              disabled={locked || !settings.canStoreKey}
              title={settings.canStoreKey ? undefined : TITLES.noKeyStore}
              autoComplete="off"
              onChange={(e) => update({ apiKey: e.target.value })}
            />
          </label>
          {settings.hasApiKey && (
            <div className="flex items-center gap-2">
              <span className={`text-sm ${MUTED}`}>Stored</span>
              <button
                type="button"
                className={BUTTON_INLINE}
                aria-label="Remove key"
                disabled={blocked || timeoutSeconds === null}
                onClick={() => void submit(null, false)}
              >
                Remove
              </button>
            </div>
          )}
        </div>

        <label className="flex flex-col gap-1" title={TITLES.timeout}>
          <span className={LABEL}>Timeout (s)</span>
          <input
            type="number"
            className={`w-32 ${INPUT}`}
            min={VISION_TIMEOUT_MIN_SECONDS}
            max={VISION_TIMEOUT_MAX_SECONDS}
            step={1}
            value={current.timeout}
            disabled={locked}
            aria-invalid={timeoutSeconds === null || undefined}
            onChange={(e) => update({ timeout: e.target.value })}
          />
        </label>

        <div className="flex flex-col gap-1" title={TITLES.tagging}>
          <span className={LABEL}>{MODEL_PURPOSE_LABELS.tagging}</span>
          <ModelSelect
            purpose="tagging"
            value={current.taggingModel}
            disabled={locked}
            onChange={(taggingModel) => update({ taggingModel })}
          />
        </div>

        <div className="flex flex-col gap-1" title={TITLES.prompt}>
          <span className={LABEL}>{MODEL_PURPOSE_LABELS.prompt}</span>
          <ModelSelect
            purpose="prompt"
            value={current.promptModel}
            disabled={locked}
            onChange={(promptModel) => update({ promptModel })}
          />
        </div>

        <div className="flex items-center gap-2">
          <button type="submit" className={BUTTON} disabled={blocked || timeoutSeconds === null}>
            Save
          </button>
          <button
            type="button"
            className={BUTTON}
            title={TITLES.test}
            disabled={blocked || timeoutSeconds === null || current.baseUrl.trim() === ''}
            onClick={() => void submit(undefined, true)}
          >
            Test connection
          </button>
          {modelCount !== null && (
            <span className={`text-sm tabular-nums ${MUTED}`}>{`${modelCount} ${modelCount === 1 ? 'model' : 'models'}`}</span>
          )}
        </div>
      </form>
    </Page>
  );
}
