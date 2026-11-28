import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANALYSIS_PROMPTS_PER_PURPOSE, type AnalysisPromptPurpose } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from '@assetforge/core';
import {
  ANALYSIS_PROMPTS_FILE,
  DEFAULT_PROMPT_NAME,
  LAST_USED_WRITE_FAILED,
  createAnalysisPromptStore,
  type AnalysisPromptStore,
} from '../src/main/analysis-prompts.js';

const TAGGING_TEXT = 'Built-in tagging text.';
const IMAGE_TEXT = 'Built-in image prompt text.';
const builtIn = (purpose: AnalysisPromptPurpose) =>
  purpose === 'tagging' ? { text: TAGGING_TEXT, maxTags: 15 } : { text: IMAGE_TEXT, maxTags: null };

let dir: string;
let counter: number;
let logs: string[];

const newId = () => {
  counter++;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
};
const open = (): AnalysisPromptStore =>
  createAnalysisPromptStore({ userData: dir, newId, builtIn, log: (line) => logs.push(line) });
const filePath = () => join(dir, ANALYSIS_PROMPTS_FILE);
const UNKNOWN = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'af-prompts-'));
  counter = 0;
  logs = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function expectError(fn: () => unknown, type: typeof NotFoundError | typeof InvalidOperationError, message: string) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(type);
  expect((caught as Error).message).toBe(message);
}

describe('analysis prompt store', () => {
  it('seeds one Default per purpose, writes the file at once and keeps the ids on a new store', () => {
    const list = open().list();
    expect(list.prompts).toEqual([
      { id: expect.any(String), purpose: 'tagging', name: DEFAULT_PROMPT_NAME, text: TAGGING_TEXT, maxTags: 15 },
      { id: expect.any(String), purpose: 'image_prompt', name: DEFAULT_PROMPT_NAME, text: IMAGE_TEXT },
    ]);
    expect(list.lastUsed).toEqual({ tagging: null, imagePrompt: null });
    expect(existsSync(filePath())).toBe(true);
    expect(open().list()).toEqual(list);
  });

  it('adds a missing purpose and keeps the existing entry', () => {
    const existing = { id: UNKNOWN, purpose: 'image_prompt', name: 'Mine', text: 'My text' };
    writeFileSync(
      filePath(),
      JSON.stringify({ version: 1, prompts: [existing], lastUsed: { tagging: null, imagePrompt: UNKNOWN } }),
    );
    const list = open().list();
    expect(list.prompts).toEqual([
      existing,
      { id: expect.any(String), purpose: 'tagging', name: DEFAULT_PROMPT_NAME, text: TAGGING_TEXT, maxTags: 15 },
    ]);
    expect(list.lastUsed).toEqual({ tagging: null, imagePrompt: UNKNOWN });
    expect(JSON.parse(readFileSync(filePath(), 'utf8')).prompts).toHaveLength(2);
  });

  it.each([['not json'], [JSON.stringify({ version: 2 })]])('sets a corrupt file aside and reseeds: %s', (content) => {
    writeFileSync(filePath(), content);
    const list = open().list();
    expect(list.prompts.map((p) => p.name)).toEqual([DEFAULT_PROMPT_NAME, DEFAULT_PROMPT_NAME]);
    const corrupt = readdirSync(dir).filter((name) => name.startsWith(`${ANALYSIS_PROMPTS_FILE}.corrupt-`));
    expect(corrupt).toHaveLength(1);
    expect(readFileSync(join(dir, corrupt[0]!), 'utf8')).toBe(content);
    expect(JSON.parse(readFileSync(filePath(), 'utf8')).version).toBe(1);
  });

  it('throws other read errors', () => {
    mkdirSync(filePath());
    expect(() => open().list()).toThrow();
  });

  it('appends without id and replaces in place with id', () => {
    const store = open();
    const general = store.save({ purpose: 'tagging', name: ' General ', text: ' Some text ', maxTags: 10 });
    expect(general).toEqual({
      id: expect.any(String),
      purpose: 'tagging',
      name: 'General',
      text: 'Some text',
      maxTags: 10,
    });
    const scenes = store.save({ purpose: 'image_prompt', name: 'Scenes', text: 'Describe' });
    const tagDefault = store.list().prompts[0]!;
    if (tagDefault.purpose !== 'tagging') throw new Error('Expected the tagging Default first');
    const replaced = store.save({ ...tagDefault, name: 'Renamed', maxTags: 3 });
    expect(replaced).toEqual({ ...tagDefault, name: 'Renamed', maxTags: 3 });
    expect(store.list().prompts.map((p) => p.id)).toEqual([
      tagDefault.id,
      store.list().prompts[1]!.id,
      general.id,
      scenes.id,
    ]);
    expect(
      open()
        .list()
        .prompts.map((p) => p.name),
    ).toEqual(['Renamed', DEFAULT_PROMPT_NAME, 'General', 'Scenes']);
  });

  it('refuses a duplicate name within a purpose, compared without case and outer spaces', () => {
    const store = open();
    const general = store.save({ purpose: 'tagging', name: 'General', text: 'x', maxTags: 5 });
    for (const name of ['general', '  General ']) {
      expectError(
        () => store.save({ purpose: 'tagging', name, text: 'y', maxTags: 5 }),
        InvalidOperationError,
        'An analysis prompt with this name already exists',
      );
    }
    expect(store.save({ ...general, name: 'GENERAL' }).name).toBe('GENERAL');
    expect(store.save({ purpose: 'image_prompt', name: 'General', text: 'z' }).name).toBe('General');
  });

  it('refuses the 51st prompt of a purpose', () => {
    // The refusal is a fixed text naming 50; it must follow the contract's limit.
    expect(ANALYSIS_PROMPTS_PER_PURPOSE).toBe(50);
    const store = open();
    for (let i = 1; i < 50; i++) store.save({ purpose: 'image_prompt', name: `P${i}`, text: 't' });
    expectError(
      () => store.save({ purpose: 'image_prompt', name: 'P50', text: 't' }),
      InvalidOperationError,
      'No more than 50 analysis prompts per purpose',
    );
    expect(store.save({ purpose: 'tagging', name: 'Other', text: 't', maxTags: 1 }).name).toBe('Other');
  });

  it('refuses an unknown id, a changed purpose and invalid input', () => {
    const store = open();
    expectError(
      () => store.save({ id: UNKNOWN, purpose: 'tagging', name: 'X', text: 't', maxTags: 5 }),
      NotFoundError,
      'The analysis prompt does not exist',
    );
    const tagging = store.list().prompts[0]!;
    expectError(
      () => store.save({ id: tagging.id, purpose: 'image_prompt', name: 'X', text: 't' }),
      InvalidOperationError,
      'The purpose of an analysis prompt cannot be changed',
    );
    expectError(
      () => store.save({ purpose: 'tagging', name: '   ', text: 't', maxTags: 5 }),
      InvalidOperationError,
      'The analysis prompt is not valid',
    );
    expectError(
      () => store.save({ purpose: 'tagging', name: 'X', text: 't', maxTags: 51 }),
      InvalidOperationError,
      'The analysis prompt is not valid',
    );
  });

  it('removes prompts, but never the last one of a purpose', () => {
    const store = open();
    const [tagging, image] = store.list().prompts;
    expectError(
      () => store.remove(tagging!.id),
      InvalidOperationError,
      'The last analysis prompt of a purpose cannot be deleted',
    );
    expectError(() => store.remove(UNKNOWN), NotFoundError, 'The analysis prompt does not exist');
    const second = store.save({ purpose: 'image_prompt', name: 'Second', text: 't' });
    store.markUsed(second);
    expect(store.list().lastUsed.imagePrompt).toBe(second.id);
    store.remove(second.id);
    expect(store.list().lastUsed.imagePrompt).toBeNull();
    expect(
      open()
        .list()
        .prompts.map((p) => p.id),
    ).toEqual([tagging!.id, image!.id]);
    expect(JSON.parse(readFileSync(filePath(), 'utf8')).lastUsed.imagePrompt).toBeNull();
  });

  it('resets text and limit to the built-in content and keeps name and id', () => {
    const store = open();
    const edited = store.save({ purpose: 'tagging', name: 'Edited', text: 'Mine', maxTags: 3 });
    expect(store.reset(edited.id)).toEqual({ ...edited, text: TAGGING_TEXT, maxTags: 15 });
    const image = store.save({ purpose: 'image_prompt', name: 'Img', text: 'Mine' });
    expect(store.reset(image.id)).toEqual({ ...image, text: IMAGE_TEXT });
    expect(
      open()
        .list()
        .prompts.find((p) => p.id === edited.id),
    ).toEqual({ ...edited, text: TAGGING_TEXT, maxTags: 15 });
    expectError(() => store.reset(UNKNOWN), NotFoundError, 'The analysis prompt does not exist');
  });

  it('resolves by id and purpose, then the one used last, then the first', () => {
    const store = open();
    const [tagDefault, imageDefault] = store.list().prompts;
    const second = store.save({ purpose: 'tagging', name: 'Second', text: 't', maxTags: 4 });
    expect(store.resolve('tagging', second.id)).toEqual(second);
    expectError(() => store.resolve('tagging', imageDefault!.id), NotFoundError, 'The analysis prompt does not exist');
    expectError(() => store.resolve('image_prompt', UNKNOWN), NotFoundError, 'The analysis prompt does not exist');
    expect(store.resolve('tagging', undefined)).toEqual(tagDefault);
    store.markUsed(second);
    expect(store.resolve('tagging', undefined)).toEqual(second);
    expect(store.resolve('image_prompt', undefined)).toEqual(imageDefault);
  });

  it('persists the prompt used last and only logs a failed write', () => {
    const store = open();
    const image = store.list().prompts[1]!;
    store.markUsed(image);
    expect(open().list().lastUsed).toEqual({ tagging: null, imagePrompt: image.id });
    expect(logs).toEqual([]);

    // The file path becomes a directory: the rename onto it fails.
    rmSync(filePath());
    mkdirSync(join(filePath(), 'blocker'), { recursive: true });
    const tagging = store.list().prompts[0]!;
    expect(() => store.markUsed(tagging)).not.toThrow();
    expect(logs).toEqual([LAST_USED_WRITE_FAILED]);
  });

  it('does not write when the prompt is already the one used last', () => {
    const store = open();
    const image = store.list().prompts[1]!;
    store.markUsed(image);
    // A write would now fail and log; a skipped write does neither.
    rmSync(filePath());
    mkdirSync(join(filePath(), 'blocker'), { recursive: true });
    store.markUsed(image);
    expect(logs).toEqual([]);
  });

  it('leaves no temporary file behind', () => {
    const store = open();
    store.save({ purpose: 'tagging', name: 'General', text: 'x', maxTags: 5 });
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
