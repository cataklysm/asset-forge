import { useId } from 'react';
import { GENERATION_PROMPT_MAX, type ImageModel } from '@assetforge/contracts';
import {
  ASPECT_LABEL,
  GENERATE_BUTTON,
  MODEL_DEFAULT_OPTION,
  PROMPT_LABEL,
  RECENT_PROMPTS_LABEL,
  RESOLUTION_LABEL,
  SAFE_MODE_LABEL,
} from '../labels';
import type { StudioForm as Form } from '../studio-state';
import { BUTTON, FOCUS, LABEL, SELECT, TEXTAREA } from '../ui';
import { EditModelSelect } from './ModelSelect';
import { ProviderSelect } from './ProviderSelect';

interface Props {
  /** The form as shown, already constrained to `model`. */
  form: Form;
  /** The selected edit model as listed; null while it is not (or not yet) listed. */
  model: ImageModel | null;
  recentPrompts: readonly string[];
  onProvider(id: string | null): void;
  onModel(model: string | null): void;
  onChange(patch: Partial<Pick<Form, 'prompt' | 'aspectRatio' | 'resolution' | 'safeMode'>>): void;
  /** Why Generate cannot start, as its tooltip; null when it can. */
  blocked: string | null;
  /** Why the last start failed, as the tooltip of Generate; null after a start that went through. */
  startError: string | null;
  busy: boolean;
  onGenerate(): void;
}

/** A select of the values a model states; `withDefault` adds the option that leaves the model's default. */
function ValueSelect({
  label,
  values,
  value,
  withDefault,
  onChange,
  disabled,
}: {
  label: string;
  values: readonly string[];
  value: string | null;
  withDefault: boolean;
  onChange(value: string | null): void;
  disabled: boolean;
}) {
  return (
    <select
      className={`min-w-0 flex-1 ${SELECT}`}
      aria-label={label}
      title={label}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    >
      {withDefault && <option value="">{MODEL_DEFAULT_OPTION}</option>}
      {values.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  );
}

/** The edit form of the studio: provider, model, prompt, the model's aspect and resolution, safe mode, Generate. */
export function StudioForm({
  form,
  model,
  recentPrompts,
  onProvider,
  onModel,
  onChange,
  blocked,
  startError,
  busy,
  onGenerate,
}: Props) {
  const promptId = useId();
  const limit = Math.min(model?.promptCharacterLimit ?? GENERATION_PROMPT_MAX, GENERATION_PROMPT_MAX);
  const ratios = model?.aspectRatios ?? null;
  const resolutions = model?.resolutions ?? null;

  return (
    <div className="flex flex-col gap-3">
      <ProviderSelect kind="venice" value={form.providerId} onChange={onProvider} disabled={busy} />
      <EditModelSelect providerId={form.providerId} value={form.model} onChange={onModel} disabled={busy || form.providerId === null} />
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={promptId} className={LABEL}>
          {PROMPT_LABEL}
        </label>
        {recentPrompts.length > 0 && (
          <select
            className={`min-w-0 max-w-48 ${SELECT}`}
            aria-label={RECENT_PROMPTS_LABEL}
            value=""
            disabled={busy}
            onChange={(e) => {
              if (e.target.value !== '') onChange({ prompt: e.target.value });
            }}
          >
            <option value="">{RECENT_PROMPTS_LABEL}</option>
            {recentPrompts.map((p) => (
              <option key={p} value={p} title={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </div>
      <textarea
        id={promptId}
        className={TEXTAREA}
        value={form.prompt}
        maxLength={GENERATION_PROMPT_MAX}
        title={`${form.prompt.length} / ${limit}`}
        disabled={busy}
        onChange={(e) => onChange({ prompt: e.target.value })}
      />
      {(ratios !== null || resolutions !== null) && (
        <div className="flex gap-2">
          {ratios !== null && (
            <ValueSelect
              label={ASPECT_LABEL}
              values={ratios}
              value={form.aspectRatio}
              withDefault
              onChange={(aspectRatio) => onChange({ aspectRatio })}
              disabled={busy}
            />
          )}
          {resolutions !== null && (
            <ValueSelect
              label={RESOLUTION_LABEL}
              values={resolutions}
              value={form.resolution}
              withDefault={form.resolution === null}
              onChange={(resolution) => onChange({ resolution })}
              disabled={busy}
            />
          )}
        </div>
      )}
      <label className="inline-flex items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          className={`accent-accent ${FOCUS}`}
          checked={form.safeMode}
          disabled={busy}
          onChange={(e) => onChange({ safeMode: e.target.checked })}
        />
        {SAFE_MODE_LABEL}
      </label>
      <div>
        <button
          type="button"
          className={BUTTON}
          disabled={blocked !== null || busy}
          title={blocked ?? startError ?? undefined}
          onClick={onGenerate}
        >
          {GENERATE_BUTTON}
        </button>
      </div>
    </div>
  );
}
