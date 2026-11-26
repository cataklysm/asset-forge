import { RefreshCw } from 'lucide-react';
import { JOB_ERROR_MESSAGES, type VisionModel } from '@assetforge/contracts';
import { MODEL_PURPOSE_LABELS, NO_MODEL_LABEL, REFRESH_MODELS_LABEL } from '../labels';
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

const RANK = (model: VisionModel) => (model.vision === true ? 0 : model.vision === null ? 1 : 2);

/** Vision models first, then the ones without reported capabilities, then the rest; each by name. */
function ordered(models: readonly VisionModel[]): VisionModel[] {
  return [...models].sort((a, b) => RANK(a) - RANK(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The models of entry `providerId` as a select: models without vision cannot be chosen, and `value` stays
 * shown and selected even when it is not (or not yet) in the list. It preselects nothing itself.
 */
export function ModelSelect({ providerId, purpose, value, onChange, disabled = false }: Props) {
  const { models, loadModels } = useProviders();
  const answer = providerId === null ? undefined : models[providerId];
  const loading = providerId !== null && answer === undefined;
  const label = MODEL_PURPOSE_LABELS[purpose];
  const list = answer !== undefined && answer.ok ? ordered(answer.models) : [];
  const listed = value !== null && list.some((m) => m.name === value);
  const message = answer !== undefined && !answer.ok ? JOB_ERROR_MESSAGES[answer.code] : null;
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
          {list.map((model) => (
            <option key={model.name} value={model.name} disabled={model.vision === false}>
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
