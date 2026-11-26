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

export const ANALYSIS_PROMPTS_FILE = 'analysis-prompts.json';
export const DEFAULT_PROMPT_NAME = 'Default';
export const LAST_USED_WRITE_FAILED = 'The analysis prompt used last could not be stored';

const NOT_FOUND = 'The analysis prompt does not exist';
const DUPLICATE_NAME = 'An analysis prompt with this name already exists';
const TOO_MANY = `No more than ${ANALYSIS_PROMPTS_PER_PURPOSE} analysis prompts per purpose`;
const LAST_OF_PURPOSE = 'The last analysis prompt of a purpose cannot be deleted';
const PURPOSE_CHANGED = 'The purpose of an analysis prompt cannot be changed';
const INVALID = 'The analysis prompt is not valid';

const PURPOSES = AnalysisPromptPurposeSchema.options;

type LastUsed = AnalysisPromptList['lastUsed'];

interface Stored {
  prompts: AnalysisPrompt[];
  lastUsed: LastUsed;
}

const StoredFileSchema = z.object({
  version: z.literal(1),
  prompts: z.array(AnalysisPromptSchema).refine((prompts) => new Set(prompts.map((p) => p.id)).size === prompts.length),
  lastUsed: z.object({ tagging: z.uuid().nullable(), imagePrompt: z.uuid().nullable() }),
});

export interface AnalysisPromptStore {
  list(): AnalysisPromptList;
  save(input: SaveAnalysisPrompt): AnalysisPrompt;
  remove(id: string): void;
  /** Text (and `maxTags`) back to the built-in content of its purpose; the name stays. */
  reset(id: string): AnalysisPrompt;
  /** The prompt of `purpose` with `id`; without an id the one used last, otherwise the first. `NotFoundError` for an unknown id or one of the other purpose. */
  resolve<P extends AnalysisPromptPurpose>(purpose: P, id: string | undefined): Extract<AnalysisPrompt, { purpose: P }>;
  /** Best effort: a failed write logs `LAST_USED_WRITE_FAILED` and never throws. */
  markUsed(prompt: AnalysisPrompt): void;
}

export function createAnalysisPromptStore(o: {
  userData: string;
  newId: () => string;
  builtIn: (purpose: AnalysisPromptPurpose) => { text: string; maxTags: number | null };
  log: (line: string) => void;
}): AnalysisPromptStore {
  const path = join(o.userData, ANALYSIS_PROMPTS_FILE);
  let state: Stored | null = null;

  const withBuiltIn = (id: string, purpose: AnalysisPromptPurpose, name: string): AnalysisPrompt => {
    const { text, maxTags } = o.builtIn(purpose);
    return purpose === 'tagging'
      ? { id, purpose, name, text, maxTags: maxTags ?? ANALYSIS_TAG_LIMIT_DEFAULT }
      : { id, purpose, name, text };
  };

  /** Writes `next` and only then makes it the state, so a failed write changes nothing. */
  const commit = (next: Stored): void => {
    writeAtomic(path, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`);
    state = next;
  };

  const load = (): Stored => {
    if (state !== null) return state;
    const read = readStored(path);
    const missing = PURPOSES.filter((purpose) => !read.prompts.some((p) => p.purpose === purpose));
    if (missing.length === 0) {
      state = read;
    } else {
      // Seeded at once, so the ids stay the same on the next start; a failed write is thrown.
      commit({
        ...read,
        prompts: [...read.prompts, ...missing.map((purpose) => withBuiltIn(o.newId(), purpose, DEFAULT_PROMPT_NAME))],
      });
    }
    return state!;
  };

  const find = (id: string): AnalysisPrompt => {
    const prompt = load().prompts.find((p) => p.id === id);
    if (prompt === undefined) throw new NotFoundError(NOT_FOUND);
    return prompt;
  };

  /** A stored id that no longer names a prompt of its purpose reads as null. */
  const lastUsedId = (purpose: AnalysisPromptPurpose): string | null => {
    const { prompts, lastUsed } = load();
    const id = lastUsed[lastUsedKey(purpose)];
    return prompts.some((p) => p.id === id && p.purpose === purpose) ? id : null;
  };

  return {
    list() {
      const { prompts } = load();
      return { prompts, lastUsed: { tagging: lastUsedId('tagging'), imagePrompt: lastUsedId('image_prompt') } };
    },

    save(input) {
      const parsed = SaveAnalysisPromptSchema.safeParse(input);
      if (!parsed.success) throw new InvalidOperationError(INVALID);
      const { id, ...fields } = parsed.data;
      const current = load();
      if (id !== undefined && find(id).purpose !== fields.purpose) throw new InvalidOperationError(PURPOSE_CHANGED);
      const samePurpose = current.prompts.filter((p) => p.purpose === fields.purpose && p.id !== id);
      // Names are trimmed by the schema, on save and on load.
      const key = fields.name.toLowerCase();
      if (samePurpose.some((p) => p.name.toLowerCase() === key)) throw new InvalidOperationError(DUPLICATE_NAME);
      if (id === undefined && samePurpose.length >= ANALYSIS_PROMPTS_PER_PURPOSE) throw new InvalidOperationError(TOO_MANY);

      const prompt: AnalysisPrompt = { id: id ?? o.newId(), ...fields };
      const prompts =
        id === undefined ? [...current.prompts, prompt] : current.prompts.map((p) => (p.id === id ? prompt : p));
      commit({ ...current, prompts });
      return prompt;
    },

    remove(id) {
      const prompt = find(id);
      const current = load();
      if (current.prompts.filter((p) => p.purpose === prompt.purpose).length <= 1) {
        throw new InvalidOperationError(LAST_OF_PURPOSE);
      }
      const key = lastUsedKey(prompt.purpose);
      commit({
        prompts: current.prompts.filter((p) => p.id !== id),
        lastUsed: { ...current.lastUsed, [key]: current.lastUsed[key] === id ? null : current.lastUsed[key] },
      });
    },

    reset(id) {
      const prompt = find(id);
      const current = load();
      const next = withBuiltIn(prompt.id, prompt.purpose, prompt.name);
      commit({ ...current, prompts: current.prompts.map((p) => (p.id === id ? next : p)) });
      return next;
    },

    resolve<P extends AnalysisPromptPurpose>(purpose: P, id: string | undefined) {
      type Result = Extract<AnalysisPrompt, { purpose: P }>;
      if (id !== undefined) {
        const prompt = find(id);
        if (prompt.purpose !== purpose) throw new NotFoundError(NOT_FOUND);
        return prompt as Result;
      }
      const lastUsed = lastUsedId(purpose);
      const prompts = load().prompts.filter((p) => p.purpose === purpose);
      // Seeding keeps at least one prompt per purpose.
      return (prompts.find((p) => p.id === lastUsed) ?? prompts[0]!) as Result;
    },

    markUsed(prompt) {
      try {
        const current = load();
        if (!current.prompts.some((p) => p.id === prompt.id && p.purpose === prompt.purpose)) return;
        commit({ ...current, lastUsed: { ...current.lastUsed, [lastUsedKey(prompt.purpose)]: prompt.id } });
      } catch {
        o.log(LAST_USED_WRITE_FAILED);
      }
    },
  };
}

function lastUsedKey(purpose: AnalysisPromptPurpose): keyof LastUsed {
  return purpose === 'tagging' ? 'tagging' : 'imagePrompt';
}

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

function empty(): Stored {
  return { prompts: [], lastUsed: { tagging: null, imagePrompt: null } };
}
