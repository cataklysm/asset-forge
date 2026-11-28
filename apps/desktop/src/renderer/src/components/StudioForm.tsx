import { useId, type RefObject } from 'react';
import { GENERATION_PROMPT_MAX, PROMPT_VARIABLE_VALUE_MAX, type ImageModel } from '@assetforge/contracts';
import {
  ASPECT_LABEL,
  attachedPromptLabel,
  EDIT_PROMPT_TEXT_LABEL,
  EDIT_PROMPT_TEXT_TITLE,
  GENERATE_BUTTON,
  LIBRARY_PROMPT_LABEL,
  LIBRARY_PROMPT_TITLE,
  MODEL_DEFAULT_OPTION,
  NEWER_VERSION_TITLE,
  PROMPT_LABEL,
  RECENT_PROMPTS_LABEL,
  RESOLUTION_LABEL,
  SAFE_MODE_LABEL,
  SAVE_TO_LIBRARY_LABEL,
} from '../labels';
import { preview } from '../studio-prompt';
import type { StudioForm as Form } from '../studio-state';
import { BUTTON, BUTTON_INLINE, FOCUS, INPUT, LABEL, SELECT, TEXTAREA } from '../ui';
import { EditModelSelect } from './ModelSelect';
import { ProviderSelect } from './ProviderSelect';

/** The attached library prompt of the form. */
type AttachedPrompt = NonNullable<Form['attached']>;

/** The fields of the form a change may patch. */
type FormPatch = Partial<Pick<Form, 'prompt' | 'aspectRatio' | 'resolution' | 'safeMode'>>;

/** The props of {@link StudioForm}. */
interface Props {
  /** The form as shown, already constrained to `model`. */
  form: Form;
  /** The selected edit model as listed; null while it is not (or not yet) listed. */
  model: ImageModel | null;
  recentPrompts: readonly string[];
  onProvider(id: string | null): void;
  onModel(model: string | null): void;
  onChange(patch: FormPatch): void;
  /** A recent prompt was chosen as the free text. */
  onRecent(prompt: string): void;
  /** Opens the library picker. */
  onLibrary(): void;
  /** A value typed for a variable of the attached prompt, by the version's spelling. */
  onVariable(name: string, value: string): void;
  /** Detaches the attached prompt; its preview becomes the free text. */
  onEditText(): void;
  /** Attaches the prompt's current version in place of the older one in use. */
  onLoadCurrent(): void;
  /** Saves the free text to the library. */
  onSaveToLibrary(): void;
  /** Why Generate cannot start, as its tooltip; null when it can. */
  blocked: string | null;
  /** Why the last start failed, as the tooltip of Generate; null after a start that went through. */
  startError: string | null;
  /** A start is in flight: only Generate waits for it. */
  busy: boolean;
  onGenerate(): void;
  /** The prompt textarea, focused when the studio opens. */
  promptRef?: RefObject<HTMLTextAreaElement | null>;
}

/** The props of {@link ValueSelect}. */
interface ValueSelectProps {
  label: string;
  values: readonly string[];
  value: string | null;
  /** Adds the option that leaves the model's default. */
  withDefault: boolean;
  onChange(value: string | null): void;
}

/**
 * A select of the values a model states; `withDefault` adds the option that leaves the model's default.
 *
 * @param props the label, the values and the selection
 * @returns the select
 */
function ValueSelect({ label, values, value, withDefault, onChange }: ValueSelectProps) {
  return (
    <select
      className={`min-w-0 flex-1 ${SELECT}`}
      aria-label={label}
      title={label}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
    >
      {withDefault && <option value="">{MODEL_DEFAULT_OPTION}</option>}
      {values.map((listed) => (
        <option key={listed} value={listed}>
          {listed}
        </option>
      ))}
    </select>
  );
}

/** The props of {@link PromptHeading}. */
interface PromptHeadingProps {
  /** The id of the prompt textarea. */
  promptId: string;
  recentPrompts: readonly string[];
  onLibrary(): void;
  onRecent(prompt: string): void;
}

/**
 * The label of the prompt with the library button and the select of recent prompts.
 *
 * @param props the textarea id, the recent prompts and the callbacks
 * @returns the heading row
 */
function PromptHeading({ promptId, recentPrompts, onLibrary, onRecent }: PromptHeadingProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label htmlFor={promptId} className={LABEL}>
        {PROMPT_LABEL}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" className={BUTTON_INLINE} title={LIBRARY_PROMPT_TITLE} onClick={onLibrary}>
          {LIBRARY_PROMPT_LABEL}
        </button>
        {recentPrompts.length > 0 && (
          <select
            className={`min-w-0 max-w-48 ${SELECT}`}
            aria-label={RECENT_PROMPTS_LABEL}
            value=""
            onChange={(event) => {
              if (event.target.value !== '') onRecent(event.target.value);
            }}
          >
            <option value="">{RECENT_PROMPTS_LABEL}</option>
            {recentPrompts.map((prompt) => (
              <option key={prompt} value={prompt} title={prompt}>
                {prompt}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

/** The props of {@link AttachedPromptFields}. */
interface AttachedPromptFieldsProps {
  attached: AttachedPrompt;
  /** The id prefix of the variable inputs. */
  variablesId: string;
  onVariable(name: string, value: string): void;
  onEditText(): void;
  onLoadCurrent(): void;
}

/**
 * The attached library prompt: its title and version (a button to the current version while an
 * older one is in use), Edit text and one input per variable.
 *
 * @param props the attached prompt, the id prefix and the callbacks
 * @returns the fields
 */
function AttachedPromptFields({
  attached,
  variablesId,
  onVariable,
  onEditText,
  onLoadCurrent,
}: AttachedPromptFieldsProps) {
  const label = attachedPromptLabel(attached.title, attached.version.number);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        {attached.version.id === attached.currentVersionId ? (
          <span className="min-w-0 truncate text-sm font-medium text-text" title={attached.title}>
            {label}
          </span>
        ) : (
          <button
            type="button"
            className={`min-w-0 ${BUTTON_INLINE}`}
            title={NEWER_VERSION_TITLE}
            onClick={onLoadCurrent}
          >
            <span className="truncate">{label}</span>
          </button>
        )}
        <button type="button" className={BUTTON_INLINE} title={EDIT_PROMPT_TEXT_TITLE} onClick={onEditText}>
          {EDIT_PROMPT_TEXT_LABEL}
        </button>
      </div>
      {attached.version.variables.map((variable, index) => (
        <div key={variable.name} className="flex flex-col gap-1">
          <label htmlFor={`${variablesId}-${index}`} className={LABEL}>
            {variable.name}
          </label>
          <input
            id={`${variablesId}-${index}`}
            className={INPUT}
            value={attached.values[variable.name] ?? ''}
            maxLength={PROMPT_VARIABLE_VALUE_MAX}
            onChange={(event) => onVariable(variable.name, event.target.value)}
          />
        </div>
      ))}
    </div>
  );
}

/** The props of {@link SizeSelects}. */
interface SizeSelectsProps {
  form: Form;
  model: ImageModel | null;
  onChange(patch: FormPatch): void;
}

/**
 * The aspect ratio and resolution selects of the values the model states; nothing when it states none.
 *
 * @param props the form, the model and the change callback
 * @returns the selects, or null
 */
function SizeSelects({ form, model, onChange }: SizeSelectsProps) {
  const ratios = model?.aspectRatios ?? null;
  const resolutions = model?.resolutions ?? null;
  // A listed default resolution is filled in by `constrain`; without one the model may choose.
  const resolutionDefault =
    model?.defaultResolution == null || resolutions === null || !resolutions.includes(model.defaultResolution);
  if (ratios === null && resolutions === null) return null;
  return (
    <div className="flex gap-2">
      {ratios !== null && (
        <ValueSelect
          label={ASPECT_LABEL}
          values={ratios}
          value={form.aspectRatio}
          withDefault
          onChange={(aspectRatio) => onChange({ aspectRatio })}
        />
      )}
      {resolutions !== null && (
        <ValueSelect
          label={RESOLUTION_LABEL}
          values={resolutions}
          value={form.resolution}
          withDefault={resolutionDefault}
          onChange={(resolution) => onChange({ resolution })}
        />
      )}
    </div>
  );
}

/**
 * The edit form of the studio: provider, model, prompt, the model's aspect and resolution, safe mode, Generate.
 *
 * @param props the form, the model and the callbacks
 * @returns the form
 */
export function StudioForm(props: Props) {
  const { form, model, onChange, blocked, startError, busy, promptRef } = props;
  const promptId = useId();
  const variablesId = useId();
  const { attached } = form;
  const text = attached === null ? form.prompt : preview(attached).text;
  const limit = Math.min(model?.promptCharacterLimit ?? GENERATION_PROMPT_MAX, GENERATION_PROMPT_MAX);

  return (
    <div className="flex flex-col gap-3">
      <ProviderSelect purpose="image" value={form.providerId} onChange={props.onProvider} />
      <EditModelSelect
        providerId={form.providerId}
        value={form.model}
        onChange={props.onModel}
        disabled={form.providerId === null}
      />
      <PromptHeading
        promptId={promptId}
        recentPrompts={props.recentPrompts}
        onLibrary={props.onLibrary}
        onRecent={props.onRecent}
      />
      {attached !== null && (
        <AttachedPromptFields
          attached={attached}
          variablesId={variablesId}
          onVariable={props.onVariable}
          onEditText={props.onEditText}
          onLoadCurrent={props.onLoadCurrent}
        />
      )}
      <textarea
        id={promptId}
        ref={promptRef}
        className={TEXTAREA}
        value={text}
        readOnly={attached !== null}
        maxLength={attached === null ? GENERATION_PROMPT_MAX : undefined}
        title={`${text.length} / ${limit}`}
        onChange={(event) => onChange({ prompt: event.target.value })}
      />
      {attached === null && form.prompt.trim() !== '' && (
        <div>
          <button type="button" className={BUTTON_INLINE} onClick={props.onSaveToLibrary}>
            {SAVE_TO_LIBRARY_LABEL}
          </button>
        </div>
      )}
      <SizeSelects form={form} model={model} onChange={onChange} />
      <label className="inline-flex items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          className={`accent-accent ${FOCUS}`}
          checked={form.safeMode}
          onChange={(event) => onChange({ safeMode: event.target.checked })}
        />
        {SAFE_MODE_LABEL}
      </label>
      <div>
        <button
          type="button"
          className={BUTTON}
          disabled={blocked !== null || busy}
          title={blocked ?? startError ?? undefined}
          onClick={props.onGenerate}
        >
          {GENERATE_BUTTON}
        </button>
      </div>
    </div>
  );
}
