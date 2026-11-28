import type { PromptDetail, PromptSummary, PromptVariable, PromptVersion } from '@assetforge/contracts';

/** A prompt version as core writes it; `variables` are the items core derived from the content. */
export interface NewPromptVersion {
  id: string;
  content: string;
  variables: PromptVariable[];
}

/**
 * The prompt library of a workspace. Titles are unique by `titleKey` (the lower-cased title); versions are numbered
 * 1, 2, 3 … per prompt and never changed. Prompt tags are always manual.
 */
export interface PromptRepository {
  /** One transaction: the prompt and version 1. False, writing nothing, when `titleKey` is taken. */
  create(r: { id: string; title: string; titleKey: string; description: string; version: NewPromptVersion; now: string }): Promise<boolean>;
  /** Sets title, description and updated_at. */
  update(r: { id: string; title: string; titleKey: string; description: string; now: string }): Promise<'ok' | 'missing' | 'title_taken'>;
  get(id: string): Promise<PromptDetail | null>;
  /** A version with the id and current title of its prompt. */
  getVersion(versionId: string): Promise<{ promptId: string; title: string; version: PromptVersion } | null>;
  /** One transaction guarded on `baseVersionId` being the highest number: inserts number + 1, sets updated_at. */
  addVersion(r: { promptId: string; baseVersionId: string; version: NewPromptVersion; now: string }): Promise<'ok' | 'missing' | 'stale'>;
  /** Deletes the prompt with versions and tag links; generations keep their copies and lose the version id. */
  remove(id: string): Promise<boolean>;
  /**
   * `words` are already folded with `foldSearchWord`, `tagNames` already normalised. Every word is a literal substring of
   * the folded title, description, current content or a tag's display name; every tag name is on the prompt. Order
   * updated_at desc, then id asc.
   */
  list(q: { words: readonly string[]; tagNames: readonly string[]; offset: number; limit: number }): Promise<{ items: PromptSummary[]; total: number }>;
  /**
   * One transaction: inserts the tag row if its name is missing, then the link; sets updated_at. A link that exists is a
   * no-op ('ok'); 'limit' and nothing written when the prompt already carries `max` tags.
   */
  addTag(r: { promptId: string; name: string; displayName: string; newId: string; now: string; max: number }): Promise<'ok' | 'missing' | 'limit'>;
  /** Deletes the link and sets updated_at; a tag the prompt does not carry is a no-op ('ok'). */
  removeTag(r: { promptId: string; name: string; now: string }): Promise<'ok' | 'missing'>;
}
