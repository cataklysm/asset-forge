import {
  buildPromptVariables,
  GENERATION_PROMPT_MAX,
  MAX_PROMPT_TAGS,
  MAX_PROMPT_VARIABLES,
  normalizeTagName,
  parsePromptVariables,
  PROMPT_DESCRIPTION_MAX,
  PROMPT_TITLE_MAX,
  PROMPT_VARIABLE_VALUE_MAX,
  type CreatePrompt,
  type ListPrompts,
  type PromptDefaults,
  type PromptDetail,
  type PromptPage,
  type PromptVariable,
  type SavePromptVersion,
  type UpdatePrompt,
} from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError, ValidationFailedError } from './errors.js';
import { foldSearchWord } from './search.js';
import type { WorkspaceSession } from './session.js';
import { tagName } from './tags.js';

const TOO_LONG = 'This text is too long';
const PROMPT_MISSING = 'This prompt does not exist';
const PROMPT_CHANGED = 'This prompt was changed in the meantime';

/** Titles are unique regardless of case. */
export const promptTitleKey = (title: string) => title.trim().toLowerCase();

function cleanHead(r: { title: string; description: string }): { title: string; titleKey: string; description: string } {
  const title = r.title.trim();
  if (title === '') throw new ValidationFailedError('A prompt needs a title');
  if (title.length > PROMPT_TITLE_MAX) throw new ValidationFailedError(TOO_LONG);
  const description = r.description.trim();
  if (description.length > PROMPT_DESCRIPTION_MAX) throw new ValidationFailedError(TOO_LONG);
  return { title, titleKey: promptTitleKey(title), description };
}

/** The trimmed content and the variables core stores for it. */
function cleanVersion(r: { content: string; defaults: PromptDefaults }): { content: string; variables: PromptVariable[] } {
  const content = r.content.trim();
  if (content === '') throw new ValidationFailedError('A prompt needs a text');
  if (content.length > GENERATION_PROMPT_MAX) throw new ValidationFailedError(TOO_LONG);
  if (parsePromptVariables(content).length > MAX_PROMPT_VARIABLES) {
    throw new ValidationFailedError(`A prompt can have at most ${MAX_PROMPT_VARIABLES} variables`);
  }
  const variables = buildPromptVariables(content, r.defaults);
  if (variables.some((v) => v.defaultValue.length > PROMPT_VARIABLE_VALUE_MAX)) throw new ValidationFailedError(TOO_LONG);
  return { content, variables };
}

const sameVariables = (a: readonly PromptVariable[], b: readonly PromptVariable[]) =>
  a.length === b.length && a.every((v, i) => v.name === b[i]!.name && v.defaultValue === b[i]!.defaultValue);

export async function getPrompt(s: WorkspaceSession, promptId: string): Promise<PromptDetail> {
  const prompt = await s.database.prompts.get(promptId);
  if (prompt === null) throw new NotFoundError(PROMPT_MISSING);
  return prompt;
}

/** Query words split on whitespace and folded; a tag name that is no valid tag answers an empty page. */
export async function listPrompts(s: WorkspaceSession, r: ListPrompts): Promise<PromptPage> {
  const words = [...new Set((r.query ?? '').split(/\s+/u).filter((w) => w !== '').map(foldSearchWord))];
  const tagNames: string[] = [];
  for (const typed of r.tagNames ?? []) {
    const name = normalizeTagName(typed);
    if (name === null) return { items: [], total: 0 };
    if (!tagNames.includes(name)) tagNames.push(name);
  }
  return s.database.prompts.list({ words, tagNames, offset: r.offset, limit: r.limit });
}

export async function createPrompt(s: WorkspaceSession, r: CreatePrompt): Promise<PromptDetail> {
  const head = cleanHead(r);
  const version = cleanVersion(r);
  const id = s.newId();
  const created = await s.database.prompts.create({
    id,
    ...head,
    version: { id: s.newId(), ...version },
    now: s.now().toISOString(),
  });
  if (!created) throw new ValidationFailedError('This title is already used');
  return getPrompt(s, id);
}

/** Title and description only; the text changes through `savePromptVersion`. */
export async function updatePrompt(s: WorkspaceSession, r: UpdatePrompt): Promise<PromptDetail> {
  const head = cleanHead(r);
  const outcome = await s.database.prompts.update({ id: r.promptId, ...head, now: s.now().toISOString() });
  if (outcome === 'missing') throw new NotFoundError(PROMPT_MISSING);
  if (outcome === 'title_taken') throw new ValidationFailedError('This title is already used');
  return getPrompt(s, r.promptId);
}

/**
 * A new version on top of `baseVersionId`, which must be the current one. Content and variables equal to the
 * current version's write nothing and answer the unchanged prompt.
 */
export async function savePromptVersion(s: WorkspaceSession, r: SavePromptVersion): Promise<PromptDetail> {
  const prompt = await getPrompt(s, r.promptId);
  if (prompt.currentVersion.id !== r.baseVersionId) throw new InvalidOperationError(PROMPT_CHANGED);
  const version = cleanVersion(r);
  const current = prompt.currentVersion;
  if (version.content === current.content && sameVariables(version.variables, current.variables)) return prompt;
  const outcome = await s.database.prompts.addVersion({
    promptId: r.promptId,
    baseVersionId: r.baseVersionId,
    version: { id: s.newId(), ...version },
    now: s.now().toISOString(),
  });
  if (outcome === 'missing') throw new NotFoundError(PROMPT_MISSING);
  if (outcome === 'stale') throw new InvalidOperationError(PROMPT_CHANGED);
  return getPrompt(s, r.promptId);
}

export async function deletePrompt(s: WorkspaceSession, promptId: string): Promise<void> {
  if (!(await s.database.prompts.remove(promptId))) throw new NotFoundError(PROMPT_MISSING);
}

export async function addPromptTag(s: WorkspaceSession, r: { promptId: string; name: string }): Promise<PromptDetail> {
  const tag = tagName(r.name);
  const outcome = await s.database.prompts.addTag({
    promptId: r.promptId,
    ...tag,
    newId: s.newId(),
    now: s.now().toISOString(),
    max: MAX_PROMPT_TAGS,
  });
  if (outcome === 'missing') throw new NotFoundError(PROMPT_MISSING);
  if (outcome === 'limit') throw new ValidationFailedError('This prompt cannot take more tags');
  return getPrompt(s, r.promptId);
}

/** A tag the prompt does not carry is a no-op. */
export async function removePromptTag(s: WorkspaceSession, r: { promptId: string; name: string }): Promise<PromptDetail> {
  const tag = tagName(r.name);
  const outcome = await s.database.prompts.removeTag({ promptId: r.promptId, name: tag.name, now: s.now().toISOString() });
  if (outcome === 'missing') throw new NotFoundError(PROMPT_MISSING);
  return getPrompt(s, r.promptId);
}
