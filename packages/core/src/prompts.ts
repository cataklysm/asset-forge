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

/** The refusal of a title, description, text or default value over its limit. */
const TOO_LONG = 'This text is too long';
/** The refusal of an unknown prompt. */
const PROMPT_MISSING = 'This prompt does not exist';
/** The refusal of a version saved on top of one that is no longer current. */
const PROMPT_CHANGED = 'This prompt was changed in the meantime';

/** The cleaned title and description of a prompt. */
interface PromptHead {
  /** The trimmed title. */
  title: string;
  /** The title in the form that is unique. */
  titleKey: string;
  /** The trimmed description. */
  description: string;
}

/** The cleaned text of a prompt version. */
interface PromptVersionText {
  /** The trimmed content. */
  content: string;
  /** The variables of the content with their defaults. */
  variables: PromptVariable[];
}

/**
 * Titles are unique regardless of case.
 *
 * @param title the title
 * @returns the form that is compared
 */
export const promptTitleKey = (title: string) => title.trim().toLowerCase();

/**
 * The trimmed title and description.
 *
 * @param request the title and the description as typed
 * @returns them cleaned, with the title key
 * @throws `ValidationFailedError` for an empty title or a text over its limit
 */
function cleanHead(request: { title: string; description: string }): PromptHead {
  const title = request.title.trim();
  if (title === '') throw new ValidationFailedError('A prompt needs a title');
  if (title.length > PROMPT_TITLE_MAX) throw new ValidationFailedError(TOO_LONG);
  const description = request.description.trim();
  if (description.length > PROMPT_DESCRIPTION_MAX) throw new ValidationFailedError(TOO_LONG);
  return { title, titleKey: promptTitleKey(title), description };
}

/**
 * The trimmed content and the variables core stores for it.
 *
 * @param request the content and the default values as typed
 * @returns them cleaned
 * @throws `ValidationFailedError` for an empty text, a text or default over its limit or too many variables
 */
function cleanVersion(request: { content: string; defaults: PromptDefaults }): PromptVersionText {
  const content = request.content.trim();
  if (content === '') throw new ValidationFailedError('A prompt needs a text');
  if (content.length > GENERATION_PROMPT_MAX) throw new ValidationFailedError(TOO_LONG);
  if (parsePromptVariables(content).length > MAX_PROMPT_VARIABLES) {
    throw new ValidationFailedError(`A prompt can have at most ${MAX_PROMPT_VARIABLES} variables`);
  }
  const variables = buildPromptVariables(content, request.defaults);
  if (variables.some((variable) => variable.defaultValue.length > PROMPT_VARIABLE_VALUE_MAX)) {
    throw new ValidationFailedError(TOO_LONG);
  }
  return { content, variables };
}

/**
 * Whether two variable lists have the same names and defaults in the same order.
 *
 * @param left one list
 * @param right the other list
 * @returns true when they are equal
 */
function sameVariables(left: readonly PromptVariable[], right: readonly PromptVariable[]): boolean {
  return (
    left.length === right.length &&
    left.every((variable, i) => variable.name === right[i]!.name && variable.defaultValue === right[i]!.defaultValue)
  );
}

/**
 * A prompt that must exist.
 *
 * @param session the open workspace
 * @param promptId the prompt
 * @returns its detail
 * @throws `NotFoundError` otherwise
 */
export async function getPrompt(session: WorkspaceSession, promptId: string): Promise<PromptDetail> {
  const prompt = await session.database.prompts.get(promptId);
  if (prompt === null) throw new NotFoundError(PROMPT_MISSING);
  return prompt;
}

/**
 * At most this many query words reach the repository, each one search term per searched column. Words beyond the
 * cap (the shortest ones) are ignored.
 */
export const MAX_PROMPT_QUERY_WORDS = 20;

/**
 * The distinct query words, split on whitespace and folded. A word contained in another word is left out, since
 * a column that contains the longer word contains it too; of the rest the `MAX_PROMPT_QUERY_WORDS` longest are kept.
 *
 * @param query the query as typed
 * @returns the words, longest first
 */
function queryWords(query: string): string[] {
  const words = [
    ...new Set(
      query
        .split(/\s+/u)
        .filter((word) => word !== '')
        .map(foldSearchWord),
    ),
  ].sort((left, right) => right.length - left.length);
  const kept: string[] = [];
  for (const word of words) {
    if (!kept.some((longer) => longer.includes(word))) kept.push(word);
  }
  return kept.slice(0, MAX_PROMPT_QUERY_WORDS);
}

/**
 * The distinct normalised tag names of a filter.
 *
 * @param typed the tag names as typed
 * @returns them; null when one is no valid tag
 */
function filterTagNames(typed: readonly string[]): string[] | null {
  const tagNames: string[] = [];
  for (const entry of typed) {
    const name = normalizeTagName(entry);
    if (name === null) return null;
    if (!tagNames.includes(name)) tagNames.push(name);
  }
  return tagNames;
}

/**
 * One page of prompts. Query words are split on whitespace and folded; a tag name that is no valid tag answers an
 * empty page.
 *
 * @param session the open workspace
 * @param request the filter and the page
 * @returns the page
 */
export async function listPrompts(session: WorkspaceSession, request: ListPrompts): Promise<PromptPage> {
  const words = queryWords(request.query ?? '');
  const tagNames = filterTagNames(request.tagNames ?? []);
  if (tagNames === null) return { items: [], total: 0 };
  return session.database.prompts.list({ words, tagNames, offset: request.offset, limit: request.limit });
}

/**
 * Creates a prompt with its first version.
 *
 * @param session the open workspace
 * @param request the title, description, content and defaults
 * @returns the new prompt
 * @throws `ValidationFailedError` for a field that fails its rule or a title already used
 */
export async function createPrompt(session: WorkspaceSession, request: CreatePrompt): Promise<PromptDetail> {
  const head = cleanHead(request);
  const version = cleanVersion(request);
  const id = session.newId();
  const created = await session.database.prompts.create({
    id,
    ...head,
    version: { id: session.newId(), ...version },
    now: session.now().toISOString(),
  });
  if (!created) throw new ValidationFailedError('This title is already used');
  return getPrompt(session, id);
}

/**
 * Changes the title and description only; the text changes through `savePromptVersion`.
 *
 * @param session the open workspace
 * @param request the prompt, the title and the description
 * @returns the changed prompt
 * @throws `ValidationFailedError` for a field that fails its rule or a title already used, `NotFoundError` for an
 *   unknown prompt
 */
export async function updatePrompt(session: WorkspaceSession, request: UpdatePrompt): Promise<PromptDetail> {
  const head = cleanHead(request);
  const outcome = await session.database.prompts.update({
    id: request.promptId,
    ...head,
    now: session.now().toISOString(),
  });
  if (outcome === 'missing') throw new NotFoundError(PROMPT_MISSING);
  if (outcome === 'title_taken') throw new ValidationFailedError('This title is already used');
  return getPrompt(session, request.promptId);
}

/**
 * A new version on top of `baseVersionId`, which must be the current one. Content and variables equal to the
 * current version's write nothing and answer the unchanged prompt.
 *
 * @param session the open workspace
 * @param request the prompt, the base version, the content and the defaults
 * @returns the prompt
 * @throws `NotFoundError` for an unknown prompt, `InvalidOperationError` for a base that is not current,
 *   `ValidationFailedError` for a text that fails its rule
 */
export async function savePromptVersion(session: WorkspaceSession, request: SavePromptVersion): Promise<PromptDetail> {
  const prompt = await getPrompt(session, request.promptId);
  if (prompt.currentVersion.id !== request.baseVersionId) throw new InvalidOperationError(PROMPT_CHANGED);
  const version = cleanVersion(request);
  const current = prompt.currentVersion;
  if (version.content === current.content && sameVariables(version.variables, current.variables)) return prompt;
  const outcome = await session.database.prompts.addVersion({
    promptId: request.promptId,
    baseVersionId: request.baseVersionId,
    version: { id: session.newId(), ...version },
    now: session.now().toISOString(),
  });
  if (outcome === 'missing') throw new NotFoundError(PROMPT_MISSING);
  if (outcome === 'stale') throw new InvalidOperationError(PROMPT_CHANGED);
  return getPrompt(session, request.promptId);
}

/**
 * Deletes a prompt with its versions and tag links.
 *
 * @param session the open workspace
 * @param promptId the prompt
 * @returns resolves once it is gone
 * @throws `NotFoundError` for an unknown prompt
 */
export async function deletePrompt(session: WorkspaceSession, promptId: string): Promise<void> {
  if (!(await session.database.prompts.remove(promptId))) throw new NotFoundError(PROMPT_MISSING);
}

/**
 * Adds a manual tag to a prompt.
 *
 * @param session the open workspace
 * @param request the prompt and the tag as typed
 * @returns the prompt
 * @throws `ValidationFailedError` for an invalid tag or a full tag list, `NotFoundError` for an unknown prompt
 */
export async function addPromptTag(
  session: WorkspaceSession,
  request: { promptId: string; name: string },
): Promise<PromptDetail> {
  const tag = tagName(request.name);
  const outcome = await session.database.prompts.addTag({
    promptId: request.promptId,
    ...tag,
    newId: session.newId(),
    now: session.now().toISOString(),
    max: MAX_PROMPT_TAGS,
  });
  if (outcome === 'missing') throw new NotFoundError(PROMPT_MISSING);
  if (outcome === 'limit') throw new ValidationFailedError('This prompt cannot take more tags');
  return getPrompt(session, request.promptId);
}

/**
 * Removes a tag from a prompt; a tag the prompt does not carry is a no-op.
 *
 * @param session the open workspace
 * @param request the prompt and the tag as typed
 * @returns the prompt
 * @throws `ValidationFailedError` for an invalid tag, `NotFoundError` for an unknown prompt
 */
export async function removePromptTag(
  session: WorkspaceSession,
  request: { promptId: string; name: string },
): Promise<PromptDetail> {
  const tag = tagName(request.name);
  const outcome = await session.database.prompts.removeTag({
    promptId: request.promptId,
    name: tag.name,
    now: session.now().toISOString(),
  });
  if (outcome === 'missing') throw new NotFoundError(PROMPT_MISSING);
  return getPrompt(session, request.promptId);
}
