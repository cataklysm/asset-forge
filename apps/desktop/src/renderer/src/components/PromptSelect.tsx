import { RefreshCw } from 'lucide-react';
import type { AnalysisPromptPurpose } from '@assetforge/contracts';
import { useAnalysisPrompts } from '../analysis-prompts-context';
import { NO_PROMPT_LABEL, PROMPT_SELECT_LABEL, RELOAD_PROMPTS_LABEL, tagLimitTitle } from '../labels';
import { ICON_BUTTON, SELECT } from '../ui';

/** The props of `PromptSelect`. */
interface Props {
  purpose: AnalysisPromptPurpose;
  value: string | null;
  onChange(id: string): void;
  disabled?: boolean;
}

/**
 * The analysis prompts of one purpose as a select, names only; a tagging prompt's tooltip is its tag
 * limit. It preselects nothing itself. A `value` that is not listed shows as "No prompt", which
 * cannot be chosen. After a failed load a retry sits beside it, so a dialog need not send the owner
 * to the settings.
 *
 * @param props the purpose, the selected prompt and its setter
 * @returns the select, with the retry after a failed load
 */
export function PromptSelect({ purpose, value, onChange, disabled = false }: Props) {
  const { prompts, loading, failed, reload } = useAnalysisPrompts();
  const select = <PromptOptions purpose={purpose} value={value} onChange={onChange} disabled={disabled} />;
  if (!failed) return select;
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      {select}
      <button
        type="button"
        className={ICON_BUTTON}
        title={RELOAD_PROMPTS_LABEL}
        aria-label={RELOAD_PROMPTS_LABEL}
        disabled={disabled || loading}
        onClick={() => void reload().catch(() => {})}
      >
        <RefreshCw size={16} aria-hidden />
      </button>
    </div>
  );
}

/**
 * The select itself.
 *
 * @param props the purpose, the selected prompt and its setter
 * @returns the select
 */
function PromptOptions({ purpose, value, onChange, disabled = false }: Props) {
  const { prompts, loading } = useAnalysisPrompts();
  const own = (prompts ?? []).filter((prompt) => prompt.purpose === purpose);
  const listed = value !== null && own.some((prompt) => prompt.id === value);

  return (
    <select
      className={`w-full min-w-0 ${SELECT}`}
      aria-label={PROMPT_SELECT_LABEL}
      value={listed ? value : ''}
      disabled={disabled || own.length === 0}
      aria-busy={loading || undefined}
      onChange={(event) => {
        if (event.target.value !== '') onChange(event.target.value);
      }}
    >
      {!listed && (
        <option value="" disabled>
          {NO_PROMPT_LABEL}
        </option>
      )}
      {own.map((prompt) => (
        <option
          key={prompt.id}
          value={prompt.id}
          title={prompt.purpose === 'tagging' ? tagLimitTitle(prompt.maxTags) : undefined}
        >
          {prompt.name}
        </option>
      ))}
    </select>
  );
}
