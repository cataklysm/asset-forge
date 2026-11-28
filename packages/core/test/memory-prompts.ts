import type { PromptDetail, PromptSummary, PromptVersion, TagAssignment } from '@assetforge/contracts';
import type { NewPromptVersion, PromptRepository } from '../src/ports/prompt-repository.js';
import { foldSearchWord } from '../src/search.js';

/** A prompt tag link; the tag fake renames and merges these with its other links. */
export interface PromptTagLink {
  promptId: string;
  name: string;
  createdAt: string;
}

/** The part of the tag fake the prompts use: tag rows by normalised name and the prompt links. */
export interface PromptTagStore {
  readonly tags: Map<string, { id: string; displayName: string }>;
  readonly promptAssignments: PromptTagLink[];
  ensureTag(r: { name: string; displayName: string; newId: string }): void;
}

interface StoredPrompt {
  id: string;
  title: string;
  titleKey: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  /** Oldest first. */
  versions: PromptVersion[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The prompts over a map, following the contract of the SQLite repository. Tag links live in `tags`. */
export class InMemoryPromptRepository implements PromptRepository {
  /** Stored rows by id; callers may inspect them. Every method returns copies. */
  readonly rows = new Map<string, StoredPrompt>();

  constructor(private readonly tags: PromptTagStore) {}

  /** The id of the prompt owning this version; null once that prompt is gone. */
  promptOfVersion(versionId: string): string | null {
    for (const p of this.rows.values()) if (p.versions.some((v) => v.id === versionId)) return p.id;
    return null;
  }

  private titleHolder(titleKey: string): StoredPrompt | undefined {
    return [...this.rows.values()].find((p) => p.titleKey === titleKey);
  }

  private tagsOf(promptId: string): TagAssignment[] {
    return this.tags.promptAssignments
      .filter((l) => l.promptId === promptId)
      .map((l) => ({ name: l.name, displayName: this.tags.tags.get(l.name)!.displayName, origin: 'manual' as const }))
      .sort((a, b) => cmp(a.name, b.name));
  }

  private summary(p: StoredPrompt): PromptSummary {
    return structuredClone({
      id: p.id,
      title: p.title,
      description: p.description,
      tags: this.tagsOf(p.id),
      currentVersion: p.versions.at(-1)!,
      updatedAt: p.updatedAt,
    });
  }

  private static version(v: NewPromptVersion, number: number, now: string): PromptVersion {
    return { id: v.id, number, content: v.content, variables: structuredClone(v.variables), createdAt: now };
  }

  async create(r: { id: string; title: string; titleKey: string; description: string; version: NewPromptVersion; now: string }): Promise<boolean> {
    if (this.rows.has(r.id)) throw new Error('UNIQUE constraint failed: prompt.id');
    if (this.titleHolder(r.titleKey)) return false;
    this.rows.set(r.id, {
      id: r.id,
      title: r.title,
      titleKey: r.titleKey,
      description: r.description,
      createdAt: r.now,
      updatedAt: r.now,
      versions: [InMemoryPromptRepository.version(r.version, 1, r.now)],
    });
    return true;
  }

  async update(r: { id: string; title: string; titleKey: string; description: string; now: string }): Promise<'ok' | 'missing' | 'title_taken'> {
    const p = this.rows.get(r.id);
    if (!p) return 'missing';
    const holder = this.titleHolder(r.titleKey);
    if (holder && holder.id !== r.id) return 'title_taken';
    Object.assign(p, { title: r.title, titleKey: r.titleKey, description: r.description, updatedAt: r.now });
    return 'ok';
  }

  async get(id: string): Promise<PromptDetail | null> {
    const p = this.rows.get(id);
    if (!p) return null;
    return { ...this.summary(p), versions: structuredClone([...p.versions].reverse()), createdAt: p.createdAt };
  }

  async getVersion(versionId: string): Promise<{ promptId: string; title: string; version: PromptVersion } | null> {
    for (const p of this.rows.values()) {
      const v = p.versions.find((x) => x.id === versionId);
      if (v) return { promptId: p.id, title: p.title, version: structuredClone(v) };
    }
    return null;
  }

  async addVersion(r: { promptId: string; baseVersionId: string; version: NewPromptVersion; now: string }): Promise<'ok' | 'missing' | 'stale'> {
    const p = this.rows.get(r.promptId);
    if (!p) return 'missing';
    const current = p.versions.at(-1)!;
    if (current.id !== r.baseVersionId) return 'stale';
    p.versions.push(InMemoryPromptRepository.version(r.version, current.number + 1, r.now));
    p.updatedAt = r.now;
    return 'ok';
  }

  async remove(id: string): Promise<boolean> {
    if (!this.rows.delete(id)) return false;
    const links = this.tags.promptAssignments;
    links.splice(0, links.length, ...links.filter((l) => l.promptId !== id));
    return true;
  }

  /** The word arrives folded; the fields are folded like the database's `af_fold`. */
  private matches(p: StoredPrompt, word: string): boolean {
    const fields = [p.title, p.description, p.versions.at(-1)!.content, ...this.tagsOf(p.id).map((t) => t.displayName)];
    return fields.some((f) => foldSearchWord(f).includes(word));
  }

  async list(q: { words: readonly string[]; tagNames: readonly string[]; offset: number; limit: number }): Promise<{ items: PromptSummary[]; total: number }> {
    const hits = [...this.rows.values()]
      .filter((p) => q.words.every((w) => this.matches(p, w)))
      .filter((p) => q.tagNames.every((n) => this.tags.promptAssignments.some((l) => l.promptId === p.id && l.name === n)))
      .sort((a, b) => cmp(b.updatedAt, a.updatedAt) || cmp(a.id, b.id));
    return { items: hits.slice(q.offset, q.offset + q.limit).map((p) => this.summary(p)), total: hits.length };
  }

  async addTag(r: { promptId: string; name: string; displayName: string; newId: string; now: string; max: number }): Promise<'ok' | 'missing' | 'limit'> {
    const p = this.rows.get(r.promptId);
    if (!p) return 'missing';
    const links = this.tags.promptAssignments.filter((l) => l.promptId === r.promptId);
    if (links.some((l) => l.name === r.name)) return 'ok';
    if (links.length >= r.max) return 'limit';
    this.tags.ensureTag(r);
    this.tags.promptAssignments.push({ promptId: r.promptId, name: r.name, createdAt: r.now });
    p.updatedAt = r.now;
    return 'ok';
  }

  async removeTag(r: { promptId: string; name: string; now: string }): Promise<'ok' | 'missing'> {
    const p = this.rows.get(r.promptId);
    if (!p) return 'missing';
    const links = this.tags.promptAssignments;
    const kept = links.filter((l) => !(l.promptId === r.promptId && l.name === r.name));
    if (kept.length !== links.length) {
      links.splice(0, links.length, ...kept);
      p.updatedAt = r.now;
    }
    return 'ok';
  }
}
