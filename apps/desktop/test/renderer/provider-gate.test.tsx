import { expect, it } from 'vitest';
import { CHOOSE_PROMPT, PROMPTS_LOAD_FAILED, START_LOADING } from '../../src/renderer/src/labels';
import { promptGate } from '../../src/renderer/src/provider-gate';
import { imagePrompt, taggingPrompt } from './fixtures';

const TAGGING = taggingPrompt();
const IMAGE = imagePrompt();
const LOADED = { prompts: [TAGGING, IMAGE], loading: false, failed: false };

it('a failed load blocks with its own message', () => {
  expect(promptGate({ prompts: null, loading: false, failed: true }, TAGGING.id)).toBe(PROMPTS_LOAD_FAILED);
  expect(promptGate({ prompts: null, loading: true, failed: true }, null)).toBe(PROMPTS_LOAD_FAILED);
});

it('prompts not loaded yet block as loading', () => {
  expect(promptGate({ prompts: null, loading: true, failed: false }, null)).toBe(START_LOADING);
  expect(promptGate({ prompts: null, loading: false, failed: false }, TAGGING.id)).toBe(START_LOADING);
});

it('no prompt, or one not in the list, asks for a choice', () => {
  expect(promptGate(LOADED, null)).toBe(CHOOSE_PROMPT);
  expect(promptGate(LOADED, '00000000-0000-4000-8000-00000000dead')).toBe(CHOOSE_PROMPT);
  expect(CHOOSE_PROMPT).toBe('Choose a prompt');
});

it('a listed prompt lets the start go ahead', () => {
  expect(promptGate(LOADED, TAGGING.id)).toBeNull();
  expect(promptGate({ ...LOADED, loading: true }, IMAGE.id)).toBeNull();
});
