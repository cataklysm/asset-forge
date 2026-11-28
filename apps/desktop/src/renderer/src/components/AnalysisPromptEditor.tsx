import {
  ANALYSIS_PROMPT_NAME_MAX,
  ANALYSIS_PROMPT_TEXT_MAX,
  ANALYSIS_TAG_LIMIT_MAX,
  ANALYSIS_TAG_LIMIT_MIN,
  type AnalysisPrompt,
} from '@assetforge/contracts';
import { invalidReason, tagLimitOf, type AnalysisPromptDraft } from '../analysis-prompt-draft';
import {
  ANALYSIS_DELETE_PROMPT_TITLE,
  ANALYSIS_PROMPT_TEXT_LABEL,
  ANALYSIS_PROMPT_TEXT_TITLE,
  DELETE_LABEL,
  LAST_PROMPT_TITLE,
  NO_CHANGES,
  PROMPT_NAME_LABEL,
  PROMPT_NAME_TITLE,
  PROMPT_TAG_LIMIT_LABEL,
  PROMPT_TAG_LIMIT_TITLE,
  RESET_LABEL,
  RESET_PROMPT_TITLE,
  SAVE_LABEL,
} from '../labels';
import { BUTTON, INPUT, LABEL, TEXTAREA } from '../ui';
import { NumberField } from './NumberField';

/** The props of `AnalysisPromptEditor`. */
interface Props {
  prompt: AnalysisPrompt;
  draft: AnalysisPromptDraft;
  dirty: boolean;
  /** The only prompt of its purpose: it cannot be deleted. */
  only: boolean;
  /** An action of the section runs: the fields are read-only and the actions disabled. */
  busy: boolean;
  onChange(patch: Partial<AnalysisPromptDraft>): void;
  onSave(draft: AnalysisPromptDraft): void;
  onReset(): void;
  onDelete(): void;
}

/**
 * The in-place editor of one analysis prompt; the draft is kept by the settings section.
 *
 * @param props the prompt, its draft and the handlers
 */
export function AnalysisPromptEditor({ prompt, draft, dirty, only, busy, onChange, onSave, onReset, onDelete }: Props) {
  const reason = invalidReason(prompt, draft) ?? (dirty ? null : NO_CHANGES);
  return (
    <form
      className="flex min-w-0 flex-1 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (reason === null && !busy) onSave(draft);
      }}
    >
      <label className="flex flex-col gap-1" title={PROMPT_NAME_TITLE}>
        <span className={LABEL}>{PROMPT_NAME_LABEL}</span>
        <input
          type="text"
          className={INPUT}
          value={draft.name}
          maxLength={ANALYSIS_PROMPT_NAME_MAX}
          autoComplete="off"
          readOnly={busy}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      {prompt.purpose === 'tagging' && (
        <NumberField
          title={PROMPT_TAG_LIMIT_TITLE}
          label={PROMPT_TAG_LIMIT_LABEL}
          min={ANALYSIS_TAG_LIMIT_MIN}
          max={ANALYSIS_TAG_LIMIT_MAX}
          step={1}
          value={draft.maxTags}
          readOnly={busy}
          invalid={tagLimitOf(draft.maxTags) === null}
          onChange={(maxTags) => onChange({ maxTags })}
        />
      )}
      <label className="flex flex-col gap-1" title={ANALYSIS_PROMPT_TEXT_TITLE}>
        <span className={LABEL}>{ANALYSIS_PROMPT_TEXT_LABEL}</span>
        <textarea
          className={TEXTAREA}
          value={draft.text}
          maxLength={ANALYSIS_PROMPT_TEXT_MAX}
          rows={8}
          spellCheck={false}
          readOnly={busy}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      </label>
      <div className="flex items-center gap-2">
        <button type="submit" className={BUTTON} disabled={busy || reason !== null} title={reason ?? undefined}>
          {SAVE_LABEL}
        </button>
        <button type="button" className={BUTTON} title={RESET_PROMPT_TITLE} disabled={busy} onClick={onReset}>
          {RESET_LABEL}
        </button>
        <button
          type="button"
          className={BUTTON}
          title={only ? LAST_PROMPT_TITLE : ANALYSIS_DELETE_PROMPT_TITLE}
          disabled={busy || only}
          onClick={onDelete}
        >
          {DELETE_LABEL}
        </button>
      </div>
    </form>
  );
}
