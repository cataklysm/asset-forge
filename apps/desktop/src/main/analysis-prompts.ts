import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ANALYSIS_PROMPTS_PER_PURPOSE,
  ANALYSIS_TAG_LIMIT_DEFAULT,
  AnalysisPromptPurposeSchema,
  AnalysisPromptSchema,
  SaveAnalysisPromptSchema,
  type AnalysisPrompt,
  type AnalysisPromptList,
  type AnalysisPromptPurpose,
  type SaveAnalysisPrompt,
} from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from '@assetforge/core';
import { writeAtomic } from './atomic-file.js';

// App-level analysis prompts in `userData/analysis-prompts.json`, written like the provider settings
// (temporary file, rename). Kept free of Electron imports. Messages and log lines are fixed strings.

/** The file name of the analysis prompts under `userData`. */
export const ANALYSIS_PROMPTS_FILE = 'analysis-prompts.json';
/** The name of the prompt seeded for a purpose that has none. */
export const DEFAULT_PROMPT_NAME = 'Default';
/** The log line of a failed write of the prompt used last. */
export const LAST_USED_WRITE_FAILED = 'The analysis prompt used last could not be stored';

const NOT_FOUND = 'The analysis prompt does not exist';
const DUPLICATE_NAME = 'An analysis prompt with this name already exists';
// A fixed text; `analysis-prompts.test.ts` pins that it matches `ANALYSIS_PROMPTS_PER_PURPOSE`.
const TOO_MANY = 'No more than 50 analysis prompts per purpose';
const LAST_OF_PURPOSE = 'The last analysis prompt of a purpose cannot be deleted';
const PURPOSE_CHANGED = 'The purpose of an analysis prompt cannot be changed';
const INVALID = 'The analysis prompt is not valid';

const PURPOSES = AnalysisPromptPurposeSchema.options;

type LastUsed = AnalysisPromptList['lastUsed'];

/** The prompts and the ones used last, as stored. */
interface Stored {
  prompts: AnalysisPrompt[];
  lastUsed: LastUsed;
}

const StoredFileSchema = z.object({
  version: z.literal(1),
  prompts: z
    .array(AnalysisPromptSchema)
    .refine((prompts) => new Set(prompts.map((prompt) => prompt.id)).size === prompts.length),
  lastUsed: z.object({ tagging: z.uuid().nullable(), imagePrompt: z.uuid().nullable() }),
});

/** The analysis prompts of the app. */
export interface AnalysisPromptStore {
  /** @returns every prompt and the ones used last */
  list(): AnalysisPromptList;
  /**
   * Creates or replaces a prompt.
   *
   * @param input the prompt; without an id a new one
   * @returns the stored prompt
   */
  save(input: SaveAnalysisPrompt): AnalysisPrompt;
  /**
   * Deletes a prompt; the last one of a purpose stays.
   *
   * @param id the prompt
   */
  remove(id: string): void;
  /**
   * Text (and `maxTags`) back to the built-in content of its purpose; the name stays.
   *
   * @param id the prompt
   * @returns the reset prompt
   */
  reset(id: string): AnalysisPrompt;
  /**
   * The prompt of `purpose` with `id`; without an id the one used last, otherwise the first. `NotFoundError` for an
   * unknown id or one of the other purpose.
   *
   * @param purpose the purpose
   * @param id the prompt, if one was chosen
   * @returns the prompt
   */
  resolve<P extends AnalysisPromptPurpose>(purpose: P, id: string | undefined): Extract<AnalysisPrompt, { purpose: P }>;
  /**
   * Best effort: a failed write logs `LAST_USED_WRITE_FAILED` and never throws.
   *
   * @param prompt the prompt used
   */
  markUsed(prompt: AnalysisPrompt): void;
}

/** What the analysis prompt store is built with. */
export interface AnalysisPromptStoreOptions {
  /** The app's `userData` directory. */
  userData: string;
  /** Makes the id of a new prompt. */
  newId: () => string;
  /** The built-in content of a purpose. */
  builtIn: (purpose: AnalysisPromptPurpose) => { text: string; maxTags: number | null };
  /** Takes the fixed log lines. */
  log: (line: string) => void;
}

/**
 * Creates the store of the analysis prompts; the file is read on first use.
 *
 * @param options what the store is built with
 * @returns the store
 */
export function createAnalysisPromptStore(options: AnalysisPromptStoreOptions): AnalysisPromptStore {
  const prompts = new AnalysisPrompts(options);
  return {
    list: () => prompts.list(),
    save: (input) => prompts.save(input),
    remove: (id) => prompts.remove(id),
    reset: (id) => prompts.reset(id),
    resolve: (purpose, id) => prompts.resolve(purpose, id),
    markUsed: (prompt) => prompts.markUsed(prompt),
  };
}

/** The analysis prompts with their file and the state read from it. */
class AnalysisPrompts {
  /** The path of the file. */
  private readonly path: string;
  /** What was read or written last; null before the first read. */
  private state: Stored | null = null;

  /** @param options what the store is built with */
  constructor(private readonly options: AnalysisPromptStoreOptions) {
    this.path = join(options.userData, ANALYSIS_PROMPTS_FILE);
  }

  /** @returns every prompt and the ones used last */
  list(): AnalysisPromptList {
    const { prompts } = this.load();
    return { prompts, lastUsed: { tagging: this.lastUsedId('tagging'), imagePrompt: this.lastUsedId('image_prompt') } };
  }

  /**
   * Creates or replaces a prompt.
   *
   * @param input the prompt; without an id a new one
   * @returns the stored prompt
   */
  save(input: SaveAnalysisPrompt): AnalysisPrompt {
    const parsed = SaveAnalysisPromptSchema.safeParse(input);
    if (!parsed.success) throw new InvalidOperationError(INVALID);
    const { id, ...fields } = parsed.data;
    const current = this.load();
    if (id !== undefined && this.find(id).purpose !== fields.purpose) throw new InvalidOperationError(PURPOSE_CHANGED);
    const samePurpose = current.prompts.filter((prompt) => prompt.purpose === fields.purpose && prompt.id !== id);
    // Names are trimmed by the schema, on save and on load.
    const key = fields.name.toLowerCase();
    if (samePurpose.some((prompt) => prompt.name.toLowerCase() === key))
      throw new InvalidOperationError(DUPLICATE_NAME);
    if (id === undefined && samePurpose.length >= ANALYSIS_PROMPTS_PER_PURPOSE)
      throw new InvalidOperationError(TOO_MANY);

    const saved: AnalysisPrompt = { id: id ?? this.options.newId(), ...fields };
    const prompts =
      id === undefined
        ? [...current.prompts, saved]
        : current.prompts.map((prompt) => (prompt.id === id ? saved : prompt));
    this.commit({ ...current, prompts });
    return saved;
  }

  /**
   * Deletes a prompt; the last one of a purpose stays.
   *
   * @param id the prompt
   */
  remove(id: string): void {
    const removed = this.find(id);
    const current = this.load();
    if (current.prompts.filter((prompt) => prompt.purpose === removed.purpose).length <= 1) {
      throw new InvalidOperationError(LAST_OF_PURPOSE);
    }
    const key = lastUsedKey(removed.purpose);
    this.commit({
      prompts: current.prompts.filter((prompt) => prompt.id !== id),
      lastUsed: { ...current.lastUsed, [key]: current.lastUsed[key] === id ? null : current.lastUsed[key] },
    });
  }

  /**
   * Text (and `maxTags`) back to the built-in content of its purpose; the name stays.
   *
   * @param id the prompt
   * @returns the reset prompt
   */
  reset(id: string): AnalysisPrompt {
    const prompt = this.find(id);
    const current = this.load();
    const next = this.withBuiltIn(prompt.id, prompt.purpose, prompt.name);
    this.commit({ ...current, prompts: current.prompts.map((each) => (each.id === id ? next : each)) });
    return next;
  }

  /**
   * The prompt of `purpose` with `id`; without an id the one used last, otherwise the first.
   *
   * @param purpose the purpose
   * @param id the prompt, if one was chosen
   * @returns the prompt
   */
  resolve<P extends AnalysisPromptPurpose>(
    purpose: P,
    id: string | undefined,
  ): Extract<AnalysisPrompt, { purpose: P }> {
    type Result = Extract<AnalysisPrompt, { purpose: P }>;
    if (id !== undefined) {
      const prompt = this.find(id);
      if (prompt.purpose !== purpose) throw new NotFoundError(NOT_FOUND);
      return prompt as Result;
    }
    const lastUsed = this.lastUsedId(purpose);
    const prompts = this.load().prompts.filter((prompt) => prompt.purpose === purpose);
    // Seeding keeps at least one prompt per purpose.
    return (prompts.find((prompt) => prompt.id === lastUsed) ?? prompts[0]!) as Result;
  }

  /**
   * Stores the prompt as the one used last of its purpose. Best effort, never throws.
   *
   * @param prompt the prompt used
   */
  markUsed(prompt: AnalysisPrompt): void {
    try {
      const current = this.load();
      if (!current.prompts.some((each) => each.id === prompt.id && each.purpose === prompt.purpose)) return;
      const key = lastUsedKey(prompt.purpose);
      if (current.lastUsed[key] === prompt.id) return;
      this.commitLastUsed({ ...current, lastUsed: { ...current.lastUsed, [key]: prompt.id } });
    } catch {
      this.options.log(LAST_USED_WRITE_FAILED);
    }
  }

  /**
   * Writes a new prompt used last. Unlike every other change, a failed write still keeps it for this session, so the
   * dialogs preselect the prompt the owner just chose; the next successful write stores it.
   *
   * @param next the state with the new prompt used last
   */
  private commitLastUsed(next: Stored): void {
    try {
      this.commit(next);
    } catch {
      this.state = next;
      this.options.log(LAST_USED_WRITE_FAILED);
    }
  }

  /**
   * A prompt with the built-in content of its purpose.
   *
   * @param id its id
   * @param purpose its purpose
   * @param name its name
   * @returns the prompt
   */
  private withBuiltIn(id: string, purpose: AnalysisPromptPurpose, name: string): AnalysisPrompt {
    const { text, maxTags } = this.options.builtIn(purpose);
    return purpose === 'tagging'
      ? { id, purpose, name, text, maxTags: maxTags ?? ANALYSIS_TAG_LIMIT_DEFAULT }
      : { id, purpose, name, text };
  }

  /**
   * Writes `next` and only then makes it the state, so a failed write changes nothing.
   *
   * @param next the new state
   */
  private commit(next: Stored): void {
    writeAtomic(this.path, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`);
    this.state = next;
  }

  /**
   * The state, read on first use and seeded with a built-in prompt for every purpose that has none.
   *
   * @returns the state
   */
  private load(): Stored {
    if (this.state !== null) return this.state;
    const read = readStored(this.path);
    const missing = PURPOSES.filter((purpose) => !read.prompts.some((prompt) => prompt.purpose === purpose));
    if (missing.length === 0) {
      this.state = read;
    } else {
      // Seeded at once, so the ids stay the same on the next start; a failed write is thrown.
      this.commit({
        ...read,
        prompts: [
          ...read.prompts,
          ...missing.map((purpose) => this.withBuiltIn(this.options.newId(), purpose, DEFAULT_PROMPT_NAME)),
        ],
      });
    }
    return this.state!;
  }

  /**
   * The prompt with `id`; `NotFoundError` without one.
   *
   * @param id the prompt
   * @returns the prompt
   */
  private find(id: string): AnalysisPrompt {
    const prompt = this.load().prompts.find((each) => each.id === id);
    if (prompt === undefined) throw new NotFoundError(NOT_FOUND);
    return prompt;
  }

  /**
   * A stored id that no longer names a prompt of its purpose reads as null.
   *
   * @param purpose the purpose
   * @returns the id of the prompt used last, or null
   */
  private lastUsedId(purpose: AnalysisPromptPurpose): string | null {
    const { prompts, lastUsed } = this.load();
    const id = lastUsed[lastUsedKey(purpose)];
    return prompts.some((prompt) => prompt.id === id && prompt.purpose === purpose) ? id : null;
  }
}

/**
 * The key of a purpose in `lastUsed`.
 *
 * @param purpose the purpose
 * @returns the key
 */
function lastUsedKey(purpose: AnalysisPromptPurpose): keyof LastUsed {
  return purpose === 'tagging' ? 'tagging' : 'imagePrompt';
}

/**
 * Reads the stored file; a missing one reads as empty, an unreadable one is set aside and reads as empty.
 *
 * @param path the file
 * @returns what it holds
 */
function readStored(path: string): Stored {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const result = StoredFileSchema.safeParse(json);
  if (result.success) return { prompts: result.data.prompts, lastUsed: result.data.lastUsed };
  // Same pattern as the provider settings: keep the unreadable file aside, start empty.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  renameSync(path, `${path}.corrupt-${stamp}`);
  return empty();
}

/** @returns a state without prompts */
function empty(): Stored {
  return { prompts: [], lastUsed: { tagging: null, imagePrompt: null } };
}
