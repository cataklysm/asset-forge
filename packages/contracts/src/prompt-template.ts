/** Template rules of the prompt library: `{{name}}` placeholders. Pure functions shared by core and renderer. */

/** A variable of a prompt version with the value used when none is given. */
export interface PromptVariable {
  name: string;
  defaultValue: string;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/gu;
/** Longest variable name. */
export const PROMPT_VARIABLE_NAME_MAX = 40;
/** Longest variable value, default or given. */
export const PROMPT_VARIABLE_VALUE_MAX = 2000;

const VARIABLE_NAME = new RegExp(`^[\\p{L}\\p{N} _-]{1,${PROMPT_VARIABLE_NAME_MAX}}$`, 'u');

/**
 * Variables are matched regardless of case.
 *
 * @param name a variable name in any spelling
 * @returns the key two spellings of the same variable share
 */
export const variableKey = (name: string): string => name.toLowerCase();

/**
 * The variable name inside a placeholder.
 *
 * @param inside the text between `{{` and `}}`
 * @returns the trimmed name, or `null` when the placeholder is not a variable
 */
function nameOf(inside: string): string | null {
  const name = inside.trim();
  return VARIABLE_NAME.test(name) ? name : null;
}

/**
 * The variables of a prompt text.
 *
 * @param content the prompt text
 * @returns distinct variable names in order of first occurrence, each in its first spelling
 */
export function parsePromptVariables(content: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of content.matchAll(PLACEHOLDER)) {
    const name = nameOf(match[1] ?? '');
    if (name === null || seen.has(variableKey(name))) continue;
    seen.add(variableKey(name));
    names.push(name);
  }
  return names;
}

/**
 * The items core stores: one per parsed name; a default is matched regardless of case, others are dropped; missing becomes ''.
 *
 * @param content the prompt text
 * @param defaults default values by variable name in any spelling
 * @returns one variable per parsed name with its default value
 */
export function buildPromptVariables(content: string, defaults: Readonly<Record<string, string>>): PromptVariable[] {
  const byKey = new Map<string, string>();
  for (const [name, value] of Object.entries(defaults)) {
    const key = variableKey(name);
    if (!byKey.has(key)) byKey.set(key, value);
  }
  return parsePromptVariables(content).map((name) => ({ name, defaultValue: byKey.get(variableKey(name)) ?? '' }));
}

/** The resolved text with the values used, or why the values were refused. */
export type ResolveResult =
  | { ok: true; text: string; values: Record<string, string> }
  | { ok: false; reason: 'missing' | 'unknown' | 'value_too_long' };

/**
 * One pass over the original content; defaults are not applied. `values` is keyed by the version's spelling, trimmed.
 *
 * @param content the text of the version
 * @param variables the variables of the version
 * @param values the given value per variable, by any spelling of its name
 * @returns the text with every variable replaced, or `missing` for a variable without a value, `unknown` for a name
 *   the version does not hold or one given twice, `value_too_long` for a value over the limit
 */
export function resolvePromptText(
  content: string,
  variables: readonly PromptVariable[],
  values: Readonly<Record<string, string>>,
): ResolveResult {
  const known = new Map(variables.map((variable) => [variableKey(variable.name), variable.name]));
  const given = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    const lower = variableKey(key);
    if (!known.has(lower) || given.has(lower)) return { ok: false, reason: 'unknown' };
    given.set(lower, value.trim());
  }
  const resolved: [string, string][] = [];
  for (const [lower, name] of known) {
    const value = given.get(lower);
    if (value === undefined || value === '') return { ok: false, reason: 'missing' };
    if (value.length > PROMPT_VARIABLE_VALUE_MAX) return { ok: false, reason: 'value_too_long' };
    resolved.push([name, value]);
  }
  const text = content.replace(PLACEHOLDER, (whole, inside: string) => {
    const name = nameOf(inside);
    const value = name === null ? undefined : given.get(variableKey(name));
    return value ?? whole;
  });
  return { ok: true, text, values: Object.fromEntries(resolved) };
}
