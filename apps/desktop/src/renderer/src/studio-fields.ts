import type { StudioForm } from './studio-state';

/** The form fields the studio holds itself; provider and model come from the provider choice. */
export type StudioFields = Pick<StudioForm, 'prompt' | 'attached' | 'origin' | 'aspectRatio' | 'resolution' | 'safeMode'>;

/** An entry and model still to be chosen once the entry is selected ("Use settings", a restored form). */
export interface PendingModel {
  providerId: string;
  model: string | null;
}

/**
 * The fields of a fresh form.
 *
 * @param safeMode the remembered safe mode
 * @returns the fields
 */
export const freshFields = (safeMode: boolean): StudioFields => ({
  prompt: '',
  attached: null,
  origin: null,
  aspectRatio: null,
  resolution: null,
  safeMode,
});

/**
 * The fields of a whole form.
 *
 * @param form the form
 * @returns its fields without provider and model
 */
export const fieldsOf = (form: StudioForm): StudioFields => ({
  prompt: form.prompt,
  attached: form.attached,
  origin: form.origin,
  aspectRatio: form.aspectRatio,
  resolution: form.resolution,
  safeMode: form.safeMode,
});

/**
 * The fields with one variable of the attached prompt set.
 *
 * @param current the fields
 * @param name the variable
 * @param value its value
 * @returns the new fields, or `current` when no prompt is attached
 */
export function withVariable(current: StudioFields, name: string, value: string): StudioFields {
  if (current.attached === null) return current;
  return { ...current, attached: { ...current.attached, values: { ...current.attached.values, [name]: value } } };
}
