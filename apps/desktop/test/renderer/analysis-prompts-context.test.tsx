import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  AnalysisPromptsProvider,
  defaultPromptId,
  useAnalysisPrompts,
  type AnalysisPromptsState,
} from '../../src/renderer/src/analysis-prompts-context';
import { fakeAnalysisPrompts, fakeError, installFakeApi } from './fake-api';
import { imagePrompt, taggingPrompt } from './fixtures';

const DEFAULT_TAGGING = taggingPrompt();
const DETAILED = taggingPrompt({ name: 'Detailed', maxTags: 25 });
const DEFAULT_IMAGE = imagePrompt();

function seeded() {
  return fakeAnalysisPrompts({
    prompts: [DEFAULT_TAGGING, DETAILED, DEFAULT_IMAGE],
    lastUsed: { tagging: DETAILED.id, imagePrompt: null },
  });
}

/** Renders the provider and returns a getter for its latest state. */
function mount() {
  let state: AnalysisPromptsState | null = null;
  function Probe() {
    state = useAnalysisPrompts();
    return <p>{state.prompts === null ? (state.failed ? 'failed' : 'loading') : `${state.prompts.length} prompts`}</p>;
  }
  render(
    <AnalysisPromptsProvider>
      <Probe />
    </AnalysisPromptsProvider>,
  );
  return () => state!;
}

it('outside a provider the state is empty', () => {
  let state: AnalysisPromptsState | null = null;
  function Probe() {
    state = useAnalysisPrompts();
    return null;
  }
  render(<Probe />);
  expect(state).toMatchObject({ prompts: null, loading: false, failed: false });
});

it('loads once and exposes the list and the prompts used last', async () => {
  const fake = seeded();
  const api = installFakeApi(fake.handlers);
  const state = mount();
  expect(await screen.findByText('3 prompts')).toBeTruthy();
  expect(state().prompts!.map((p) => p.name)).toEqual(['Default', 'Detailed', 'Default']);
  expect(state().lastUsed).toEqual({ tagging: DETAILED.id, imagePrompt: null });
  expect(state().loading).toBe(false);
  expect(state().failed).toBe(false);
  expect(api.calls.filter((c) => c.channel === 'analysisPrompts:list')).toHaveLength(1);
});

it('a failed load sets failed and reload recovers', async () => {
  const fake = seeded();
  const api = installFakeApi({
    ...fake.handlers,
    'analysisPrompts:list': () => {
      throw fakeError('internal_error', 'internal_error');
    },
  });
  const state = mount();
  expect(await screen.findByText('failed')).toBeTruthy();
  expect(state().prompts).toBeNull();
  api.set('analysisPrompts:list', fake.handlers['analysisPrompts:list']);
  await act(() => state().reload());
  expect(screen.getByText('3 prompts')).toBeTruthy();
  expect(state().failed).toBe(false);
});

it('save appends a new prompt and replaces an existing one without listing again', async () => {
  const api = installFakeApi(seeded().handlers);
  const state = mount();
  await screen.findByText('3 prompts');

  const created = await act(() => state().save({ purpose: 'image_prompt', name: 'Short', text: 'Be brief' }));
  expect(created.name).toBe('Short');
  expect(state().prompts!.map((p) => p.id)).toEqual([DEFAULT_TAGGING.id, DETAILED.id, DEFAULT_IMAGE.id, created.id]);

  await act(() => state().save({ id: DETAILED.id, purpose: 'tagging', name: 'Detailed', text: 'Changed', maxTags: 30 }));
  expect(state().prompts![1]).toEqual({ ...DETAILED, text: 'Changed', maxTags: 30 });
  expect(api.calls.filter((c) => c.channel === 'analysisPrompts:list')).toHaveLength(1);
});

it('remove drops the prompt and clears a matching prompt used last', async () => {
  installFakeApi(seeded().handlers);
  const state = mount();
  await screen.findByText('3 prompts');
  await act(() => state().remove(DETAILED.id));
  expect(state().prompts!.map((p) => p.id)).toEqual([DEFAULT_TAGGING.id, DEFAULT_IMAGE.id]);
  expect(state().lastUsed).toEqual({ tagging: null, imagePrompt: null });
});

it('reset replaces the prompt with the answer', async () => {
  installFakeApi(seeded().handlers);
  const state = mount();
  await screen.findByText('3 prompts');
  const answer = await act(() => state().reset(DETAILED.id));
  expect(answer).toMatchObject({ text: 'Built-in tagging text', maxTags: 15 });
  expect(state().prompts![1]).toEqual(answer);
});

it('a refused call rejects and leaves the list as it was', async () => {
  installFakeApi(seeded().handlers);
  const state = mount();
  await screen.findByText('3 prompts');
  await expect(state().remove(DEFAULT_IMAGE.id)).rejects.toThrow('The last analysis prompt of a purpose cannot be deleted');
  expect(state().prompts).toHaveLength(3);
});

it('noteUsed changes the prompt used last', async () => {
  installFakeApi(seeded().handlers);
  const state = mount();
  await screen.findByText('3 prompts');
  act(() => state().noteUsed('image_prompt', DEFAULT_IMAGE.id));
  act(() => state().noteUsed('tagging', DEFAULT_TAGGING.id));
  await waitFor(() => expect(state().lastUsed).toEqual({ tagging: DEFAULT_TAGGING.id, imagePrompt: DEFAULT_IMAGE.id }));
});

it('defaultPromptId prefers the prompt used last, falls back to the first of the purpose, and is null without a list', () => {
  const prompts = [DEFAULT_TAGGING, DETAILED, DEFAULT_IMAGE];
  expect(defaultPromptId({ prompts, lastUsed: { tagging: DETAILED.id, imagePrompt: null } }, 'tagging')).toBe(DETAILED.id);
  expect(defaultPromptId({ prompts, lastUsed: { tagging: DETAILED.id, imagePrompt: null } }, 'image_prompt')).toBe(DEFAULT_IMAGE.id);
  expect(defaultPromptId({ prompts, lastUsed: { tagging: 'gone', imagePrompt: null } }, 'tagging')).toBe(DEFAULT_TAGGING.id);
  // An id of the other purpose is not taken.
  expect(defaultPromptId({ prompts, lastUsed: { tagging: DEFAULT_IMAGE.id, imagePrompt: null } }, 'tagging')).toBe(DEFAULT_TAGGING.id);
  expect(defaultPromptId({ prompts: [DEFAULT_TAGGING], lastUsed: { tagging: null, imagePrompt: null } }, 'image_prompt')).toBeNull();
  expect(defaultPromptId({ prompts: null, lastUsed: { tagging: DETAILED.id, imagePrompt: null } }, 'tagging')).toBeNull();
});
