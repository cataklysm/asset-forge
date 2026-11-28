import { INPUT, LABEL } from '../ui';

/** The props of `NumberField`. */
interface Props {
  /** The tooltip of the field. */
  title: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** The text as typed. */
  value: string;
  disabled?: boolean;
  /** The typed text is not valid. */
  invalid: boolean;
  onChange(value: string): void;
}

/**
 * A labelled narrow number input of a settings form.
 *
 * @param props the label, the bounds, the typed text and its handler
 */
export function NumberField({ title, label, min, max, step, value, disabled, invalid, onChange }: Props) {
  return (
    <label className="flex flex-col gap-1" title={title}>
      <span className={LABEL}>{label}</span>
      <input
        type="number"
        className={`w-32 ${INPUT}`}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
