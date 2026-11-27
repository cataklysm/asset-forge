/** Template rules of the prompt library: `{{name}}` placeholders. Pure functions shared by core and renderer. */

export interface PromptVariable {
  name: string;
  defaultValue: string;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/gu;
const VARIABLE_NAME = /^[\p{L}\p{N} _-]{1,40}$/u;
const VALUE_MAX = 2000;

/** Variables are matched regardless of case. */
export const variableKey = (name: string): string => name.toLowerCase();

/** The variable name inside a placeholder, or `null` when the placeholder is not a variable. */
function nameOf(inside: string): string | null {
  const name = inside.trim();
  return VARIABLE_NAME.test(name) ? name : null;
}

/** Distinct variable names in order of first occurrence, each in its first spelling. */
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

/** The items core stores: one per parsed name; a default is matched regardless of case, others are dropped; missing becomes ''. */
export function buildPromptVariables(content: string, defaults: Readonly<Record<string, string>>): PromptVariable[] {
  const byKey = new Map<string, string>();
  for (const [name, value] of Object.entries(defaults)) {
    const key = variableKey(name);
    if (!byKey.has(key)) byKey.set(key, value);
  }
  return parsePromptVariables(content).map((name) => ({ name, defaultValue: byKey.get(variableKey(name)) ?? '' }));
}

export type ResolveResult =
  | { ok: true; text: string; values: Record<string, string> }
  | { ok: false; reason: 'missing' | 'unknown' | 'value_too_long' };

/** One pass over the original content; defaults are not applied. `values` is keyed by the version's spelling, trimmed. */
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
  const resolved: Record<string, string> = {};
  for (const [lower, name] of known) {
    const value = given.get(lower);
    if (value === undefined || value === '') return { ok: false, reason: 'missing' };
    if (value.length > VALUE_MAX) return { ok: false, reason: 'value_too_long' };
    resolved[name] = value;
  }
  const text = content.replace(PLACEHOLDER, (whole, inside: string) => {
    const name = nameOf(inside);
    const value = name === null ? undefined : given.get(variableKey(name));
    return value ?? whole;
  });
  return { ok: true, text, values: resolved };
}
