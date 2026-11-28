import {
  buildPromptVariables,
  variableKey,
  type PromptDetail,
  type PromptVariable,
  type PromptVersion,
} from '@assetforge/contracts';

/** What the prompt editor holds while it is edited; `defaults` may keep values of variables no longer in the text. */
export interface EditorDraft {
  title: string;
  description: string;
  content: string;
  defaults: Record<string, string>;
}

/** The draft of a new prompt. */
export const EMPTY_DRAFT: EditorDraft = { title: '', description: '', content: '', defaults: {} };

/**
 * The draft of a loaded prompt: its title and description with the text and defaults of `version`.
 *
 * @param detail the loaded prompt
 * @param version the version shown; the current one by default
 * @returns the draft
 */
export function draftOf(detail: PromptDetail, version: PromptVersion = detail.currentVersion): EditorDraft {
  return {
    title: detail.title,
    description: detail.description,
    content: version.content,
    defaults: Object.fromEntries(version.variables.map((variable) => [variable.name, variable.defaultValue])),
  };
}

/**
 * The variables of the text as typed, each with the default typed for it under any spelling.
 *
 * @param draft the draft
 * @returns the variables in text order
 */
export function variablesOf(draft: EditorDraft): PromptVariable[] {
  return buildPromptVariables(draft.content, draft.defaults);
}

/**
 * The defaults of the variables in the text only, keyed by their spelling in the text.
 *
 * @param draft the draft
 * @returns the defaults
 */
export function defaultsOf(draft: EditorDraft): Record<string, string> {
  return Object.fromEntries(variablesOf(draft).map((variable) => [variable.name, variable.defaultValue]));
}

/**
 * `defaults` with the value of `name` set, replacing an entry of another spelling.
 *
 * @param defaults the defaults as typed
 * @param name the variable name
 * @param value its new default
 * @returns the new defaults
 */
export function withDefault(defaults: Readonly<Record<string, string>>, name: string, value: string): Record<string, string> {
  const kept = Object.entries(defaults).filter(([key]) => variableKey(key) !== variableKey(name));
  return Object.fromEntries([...kept, [name, value]]);
}

/**
 * Whether title or description differ from the loaded prompt, ignoring surrounding whitespace.
 *
 * @param draft the draft
 * @param detail the loaded prompt
 * @returns true when they differ
 */
export function metaDirty(draft: EditorDraft, detail: PromptDetail): boolean {
  return draft.title.trim() !== detail.title.trim() || draft.description.trim() !== detail.description.trim();
}

/**
 * Whether the trimmed text or its variables with their defaults differ from the current version.
 *
 * @param draft the draft
 * @param detail the loaded prompt
 * @returns true when saving would write a new version
 */
export function versionDirty(draft: EditorDraft, detail: PromptDetail): boolean {
  const current = detail.currentVersion;
  if (draft.content.trim() !== current.content.trim()) return true;
  const variables = buildPromptVariables(draft.content.trim(), draft.defaults);
  return (
    variables.length !== current.variables.length ||
    variables.some(
      (variable, index) =>
        variable.name !== current.variables[index]?.name || variable.defaultValue !== current.variables[index]?.defaultValue,
    )
  );
}

/**
 * Whether a new draft counts as changed: once anything was typed.
 *
 * @param draft the draft of a new prompt
 * @returns true when something was typed
 */
export function newDraftDirty(draft: EditorDraft): boolean {
  return draft.title.trim() !== '' || draft.description.trim() !== '' || draft.content.trim() !== '';
}
