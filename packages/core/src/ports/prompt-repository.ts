import type { PromptDetail, PromptSummary, PromptVariable, PromptVersion } from '@assetforge/contracts';

/** A prompt version as core writes it; `variables` are the items core derived from the content. */
export interface NewPromptVersion {
  /** The id of the version. */
  id: string;
  /** The template text. */
  content: string;
  /** The variables of the content with their default values. */
  variables: PromptVariable[];
}

/**
 * The prompt library of a workspace. Titles are unique by `titleKey` (the lower-cased title); versions are numbered
 * 1, 2, 3 … per prompt and never changed. Prompt tags are always manual.
 */
export interface PromptRepository {
  /**
   * One transaction: the prompt and version 1.
   *
   * @param prompt the id, title, title key, description, first version and time
   * @returns false, writing nothing, when `titleKey` is taken
   */
  create(prompt: {
    id: string;
    title: string;
    titleKey: string;
    description: string;
    version: NewPromptVersion;
    now: string;
  }): Promise<boolean>;
  /**
   * Sets title, description and updated_at.
   *
   * @param change the prompt, the new title, title key and description, and the time
   * @returns `ok`, `missing` for an unknown prompt, or `title_taken` when another prompt has the title key
   */
  update(change: {
    id: string;
    title: string;
    titleKey: string;
    description: string;
    now: string;
  }): Promise<'ok' | 'missing' | 'title_taken'>;
  /**
   * One prompt with its versions and tags.
   *
   * @param id the prompt
   * @returns the prompt; null for an unknown id
   */
  get(id: string): Promise<PromptDetail | null>;
  /**
   * A version with the id and current title of its prompt.
   *
   * @param versionId the version
   * @returns the version with its prompt's id and title; null for an unknown id
   */
  getVersion(versionId: string): Promise<{ promptId: string; title: string; version: PromptVersion } | null>;
  /**
   * One transaction guarded on `baseVersionId` being the highest number: inserts number + 1, sets updated_at.
   *
   * @param addition the prompt, the version the edit started from, the new version and the time
   * @returns `ok`, `missing` for an unknown prompt, or `stale` when the base is no longer the current version
   */
  addVersion(addition: {
    promptId: string;
    baseVersionId: string;
    version: NewPromptVersion;
    now: string;
  }): Promise<'ok' | 'missing' | 'stale'>;
  /**
   * Deletes the prompt with versions and tag links; generations keep their copies and lose the version id.
   *
   * @param id the prompt
   * @returns false for an unknown id
   */
  remove(id: string): Promise<boolean>;
  /**
   * `words` are already folded with `foldSearchWord`, `tagNames` already normalised. Every word is a literal substring of
   * the folded title, description, current content or a tag's display name; every tag name is on the prompt. Order
   * updated_at desc, then id asc.
   *
   * @param filter the folded words, the normalised tag names and the page
   * @returns the page and the total
   */
  list(filter: {
    words: readonly string[];
    tagNames: readonly string[];
    offset: number;
    limit: number;
  }): Promise<{ items: PromptSummary[]; total: number }>;
  /**
   * One transaction: inserts the tag row if its name is missing, then the link; sets updated_at. A link that exists is a
   * no-op ('ok'); 'limit' and nothing written when the prompt already carries `max` tags.
   *
   * @param assignment the prompt, the normalised name, the display name, the id for a new tag row, the time and the
   *   most tags a prompt may carry
   * @returns `ok`, `missing` for an unknown prompt, or `limit`
   */
  addTag(assignment: {
    promptId: string;
    name: string;
    displayName: string;
    newId: string;
    now: string;
    max: number;
  }): Promise<'ok' | 'missing' | 'limit'>;
  /**
   * Deletes the link and sets updated_at; a tag the prompt does not carry is a no-op ('ok').
   *
   * @param removal the prompt, the normalised name and the time
   * @returns `ok`, or `missing` for an unknown prompt
   */
  removeTag(removal: { promptId: string; name: string; now: string }): Promise<'ok' | 'missing'>;
}
