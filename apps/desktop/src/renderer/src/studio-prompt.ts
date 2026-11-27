import {
  PROMPT_VARIABLE_VALUE_MAX,
  resolvePromptText,
  variableKey,
  type PromptDetail,
  type PromptVersion,
} from '@assetforge/contracts';

/** A library prompt version in use in the studio form, with the values typed for its variables. */
export interface AttachedPrompt {
  promptId: string;
  title: string;
  version: PromptVersion;
  /** The id of the prompt's current version when this one was loaded. */
  currentVersionId: string;
  /** Keyed by the version's spelling. */
  values: Record<string, string>;
}

/** `version` of `detail` in use; a variable's value is `given` (case-insensitive), else recalled, else its default. */
export function attach(
  detail: PromptDetail,
  version: PromptVersion,
  recall: (name: string) => string | undefined,
  given: Readonly<Record<string, string>> = {},
): AttachedPrompt {
  const byKey = new Map<string, string>();
  for (const [name, value] of Object.entries(given)) if (!byKey.has(variableKey(name))) byKey.set(variableKey(name), value);
  const values: Record<string, string> = {};
  for (const variable of version.variables)
    values[variable.name] = byKey.get(variableKey(variable.name)) ?? recall(variable.name) ?? variable.defaultValue;
  return { promptId: detail.id, title: detail.title, version, currentVersionId: detail.currentVersion.id, values };
}

/** The text the form shows: variables with a usable value replaced, the others left as written; why it cannot start. */
export function preview(a: AttachedPrompt): { text: string; blocked: 'missing' | 'value_too_long' | null } {
  const { content, variables } = a.version;
  const full = resolvePromptText(content, variables, a.values);
  if (full.ok) return { text: full.text, blocked: null };
  // Resolving only the usable values replaces exactly those placeholders.
  const usable = variables.filter((variable) => {
    const value = (a.values[variable.name] ?? '').trim();
    return value !== '' && value.length <= PROMPT_VARIABLE_VALUE_MAX;
  });
  const partial = resolvePromptText(
    content,
    usable,
    Object.fromEntries(usable.map((variable) => [variable.name, a.values[variable.name] ?? ''])),
  );
  return { text: partial.ok ? partial.text : content, blocked: full.reason === 'value_too_long' ? 'value_too_long' : 'missing' };
}
