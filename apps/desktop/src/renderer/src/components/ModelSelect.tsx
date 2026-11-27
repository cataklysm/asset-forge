import { RefreshCw } from 'lucide-react';
import { JOB_ERROR_MESSAGES, type VisionModel } from '@assetforge/contracts';
import { EDIT_MODEL_LABEL, MODEL_PURPOSE_LABELS, NO_MODEL_LABEL, REFRESH_MODELS_LABEL } from '../labels';
import { useProviders } from '../provider-context';
import { ICON_BUTTON, SELECT } from '../ui';

interface Props {
  /** The entry whose models are listed; null lists nothing. */
  providerId: string | null;
  purpose: 'tagging' | 'prompt';
  value: string | null;
  onChange(model: string | null): void;
  disabled?: boolean;
}

/** One option of a model select. */
interface ModelOption {
  name: string;
  /** The option cannot be chosen. */
  disabled?: boolean;
  /** The option's tooltip. */
  title?: string;
}

interface ModelListSelectProps {
  label: string;
  /** The entry whose list is refreshed; null offers no refresh. */
  providerId: string | null;
  options: readonly ModelOption[];
  /** The list of `providerId` is still being asked. */
  loading: boolean;
  /** Why the list could not be loaded, shown below the select; null when it loaded. */
  message: string | null;
  value: string | null;
  onChange(model: string | null): void;
  disabled: boolean;
}

/**
 * The markup both model selects share: a select with no model, `value` even when it is not (or not
 * yet) listed, the options, and a refresh of the entry's list.
 */
function ModelListSelect({ label, providerId, options, loading, message, value, onChange, disabled }: ModelListSelectProps) {
  const { loadModels } = useProviders();
  const listed = value !== null && options.some((m) => m.name === value);
  const canRefresh = !disabled && !loading && providerId !== null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <select
          className={`min-w-0 flex-1 ${SELECT}`}
          aria-label={label}
          value={value ?? ''}
          disabled={disabled}
          aria-busy={loading || undefined}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">{NO_MODEL_LABEL}</option>
          {value !== null && !listed && <option value={value}>{value}</option>}
          {options.map((model) => (
            <option key={model.name} value={model.name} disabled={model.disabled} title={model.title}>
              {model.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={ICON_BUTTON}
          title={REFRESH_MODELS_LABEL}
          aria-label={REFRESH_MODELS_LABEL}
          disabled={!canRefresh}
          onClick={() => providerId !== null && void loadModels(providerId, true)}
        >
          <RefreshCw size={16} aria-hidden />
        </button>
      </div>
      {message !== null && <p className="text-sm text-danger">{message}</p>}
    </div>
  );
}

const RANK = (model: VisionModel) => (model.vision === true ? 0 : model.vision === null ? 1 : 2);

/** Vision models first, then the ones without reported capabilities, then the rest; each by name. */
function ordered(models: readonly VisionModel[]): VisionModel[] {
  return [...models].sort((a, b) => RANK(a) - RANK(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The models of vision entry `providerId` (`ollama` or `openai`) as a select: models without vision cannot be chosen, and
 * `value` stays shown and selected even when it is not (or not yet) in the list. It preselects nothing itself.
 */
export function ModelSelect({ providerId, purpose, value, onChange, disabled = false }: Props) {
  const { models } = useProviders();
  const answer = providerId === null ? undefined : models[providerId];
  const list = answer !== undefined && answer.ok ? ordered(answer.models) : [];
  return (
    <ModelListSelect
      label={MODEL_PURPOSE_LABELS[purpose]}
      providerId={providerId}
      options={list.map((m) => ({ name: m.name, disabled: m.vision === false }))}
      loading={providerId !== null && answer === undefined}
      message={answer !== undefined && !answer.ok ? JOB_ERROR_MESSAGES[answer.code] : null}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

interface EditModelSelectProps {
  /** The `venice` entry whose edit models are listed; null lists nothing. */
  providerId: string | null;
  value: string | null;
  onChange(model: string | null): void;
  disabled?: boolean;
}

/**
 * The edit models of `venice` entry `providerId` as a select, each with its price as tooltip when
 * known; `value` stays shown and selected even when it is not (or not yet) in the list.
 */
export function EditModelSelect({ providerId, value, onChange, disabled = false }: EditModelSelectProps) {
  const { imageModels } = useProviders();
  const answer = providerId === null ? undefined : imageModels[providerId];
  const list = answer !== undefined && answer !== 'checking' && answer.ok ? answer.models : [];
  return (
    <ModelListSelect
      label={EDIT_MODEL_LABEL}
      providerId={providerId}
      options={list.map((m) => ({ name: m.name, title: m.price ?? undefined }))}
      loading={providerId !== null && (answer === undefined || answer === 'checking')}
      // The settings show a failed list through the entry's state.
      message={null}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  );
}
