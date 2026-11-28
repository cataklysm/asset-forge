import type { AnalysisPromptPurpose } from '@assetforge/contracts';
import { useAnalysisPrompts } from '../analysis-prompts-context';
import { NO_PROMPT_LABEL, PROMPT_SELECT_LABEL, tagLimitTitle } from '../labels';
import { SELECT } from '../ui';

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
 * cannot be chosen.
 *
 * @param props the purpose, the selected prompt and its setter
 */
export function PromptSelect({ purpose, value, onChange, disabled = false }: Props) {
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
