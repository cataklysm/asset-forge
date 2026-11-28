import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IpcRequest } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { AnalysisPromptsProvider } from '../../src/renderer/src/analysis-prompts-context';
import { PromptSettings } from '../../src/renderer/src/components/PromptSettings';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { SettingsScreen } from '../../src/renderer/src/screens/SettingsScreen';
import { BUTTON, BUTTON_INLINE, ICON_BUTTON } from '../../src/renderer/src/ui';
import {
  fakeAnalysisPrompts,
  fakeError,
  fakeProviders,
  installFakeApi,
  providerView,
  type FakeHandlers,
} from './fake-api';
import { BUILT_IN_TAGGING_TEXT, imagePrompt, taggingPrompt } from './fixtures';

const DEFAULT_TAGGING = taggingPrompt();
const DETAILED = taggingPrompt({ name: 'Detailed', text: 'Describe the person precisely', maxTags: 25 });
const DEFAULT_IMAGE = imagePrompt({ text: 'Write a prompt for this image' });

function install(handlers: FakeHandlers = {}) {
  const fake = fakeAnalysisPrompts({ prompts: [DEFAULT_TAGGING, DETAILED, DEFAULT_IMAGE] });
  const api = installFakeApi({ ...fake.handlers, ...handlers });
  return { api, fake };
}

const requestsOf = <C extends keyof FakeHandlers>(api: ReturnType<typeof installFakeApi>, channel: C) =>
  api.calls.filter((c) => c.channel === channel).map((c) => c.request as IpcRequest<C>);

function renderSection() {
  return render(
    <AnalysisPromptsProvider>
      <PromptSettings />
    </AnalysisPromptsProvider>,
  );
}

const group = (name: string) => screen.getByRole('group', { name });
const entry = (purpose: string, name: string) =>
  within(group(purpose)).getByRole('button', { name }) as HTMLButtonElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement | HTMLTextAreaElement;

async function loaded() {
  await screen.findByRole('heading', { name: 'Analysis prompts' });
  await waitFor(() => expect(entry('Tagging', 'Detailed')).toBeTruthy());
}

it('shows both lists and the editor of the selected entry', async () => {
  install();
  renderSection();
  await loaded();
  expect(
    within(group('Tagging'))
      .getAllByRole('listitem')
      .map((li) => li.textContent),
  ).toEqual(['Default', 'Detailed']);
  expect(
    within(group('Image to prompt'))
      .getAllByRole('listitem')
      .map((li) => li.textContent),
  ).toEqual(['Default']);

  await userEvent.click(entry('Tagging', 'Detailed'));
  expect(entry('Tagging', 'Detailed').getAttribute('aria-pressed')).toBe('true');
  expect(field('Name').value).toBe('Detailed');
  expect(field('Name').getAttribute('maxlength')).toBe('60');
  expect(field('Tag limit').value).toBe('25');
  expect(field('Text').value).toBe('Describe the person precisely');
  expect(field('Text').getAttribute('maxlength')).toBe('8000');

  await userEvent.click(entry('Image to prompt', 'Default'));
  expect(field('Text').value).toBe('Write a prompt for this image');
  expect(screen.queryByLabelText('Tag limit')).toBeNull();
});

it('Save sends the trimmed values and is disabled without changes or with an invalid draft', async () => {
  const { api } = install();
  renderSection();
  await loaded();
  await userEvent.click(entry('Tagging', 'Detailed'));
  expect(button('Save').disabled).toBe(true);
  expect(button('Save').title).toBe('No unsaved changes');

  await userEvent.clear(field('Name'));
  expect(button('Save').disabled).toBe(true);
  expect(button('Save').title).toBe('Enter a name');
  await userEvent.type(field('Name'), '  Characters, detailed  ');
  await userEvent.clear(field('Tag limit'));
  await userEvent.type(field('Tag limit'), '51');
  expect(button('Save').disabled).toBe(true);
  expect(button('Save').title).toBe('The tag limit must be a whole number from 1 to 50');
  await userEvent.clear(field('Tag limit'));
  await userEvent.type(field('Tag limit'), '30');
  await userEvent.clear(field('Text'));
  expect(button('Save').title).toBe('Enter a text');
  await userEvent.type(field('Text'), '  Look closely  ');
  expect(button('Save').disabled).toBe(false);

  await userEvent.click(button('Save'));
  await waitFor(() => expect(entry('Tagging', 'Characters, detailed')).toBeTruthy());
  expect(requestsOf(api, 'analysisPrompts:save')).toEqual([
    { id: DETAILED.id, purpose: 'tagging', name: 'Characters, detailed', text: 'Look closely', maxTags: 30 },
  ]);
  expect(field('Text').value).toBe('Look closely');
  expect(button('Save').disabled).toBe(true);
  expect(screen.queryByTitle('Unsaved changes')).toBeNull();
});

it('a draft survives switching entries, with the marker shown meanwhile', async () => {
  install();
  renderSection();
  await loaded();
  await userEvent.click(entry('Tagging', 'Detailed'));
  await userEvent.type(field('Text'), ' and more');
  expect(within(entry('Tagging', 'Detailed')).getByTitle('Unsaved changes')).toBeTruthy();

  await userEvent.click(entry('Tagging', 'Default'));
  expect(field('Text').value).toBe(BUILT_IN_TAGGING_TEXT);
  expect(within(entry('Tagging', 'Detailed')).getByTitle('Unsaved changes')).toBeTruthy();
  expect(within(entry('Tagging', 'Default')).queryByTitle('Unsaved changes')).toBeNull();

  await userEvent.click(entry('Tagging', 'Detailed'));
  expect(field('Text').value).toBe('Describe the person precisely and more');
  expect(button('Save').disabled).toBe(false);

  // Typing the stored value back leaves nothing unsaved.
  await userEvent.clear(field('Text'));
  await userEvent.type(field('Text'), 'Describe the person precisely');
  expect(screen.queryByTitle('Unsaved changes')).toBeNull();
});

it('New creates "New prompt", then "New prompt 2", with the built-in content, and selects it', async () => {
  const { api } = install();
  renderSection();
  await loaded();
  await userEvent.click(entry('Tagging', 'Detailed'));
  await userEvent.click(within(group('Tagging')).getByRole('button', { name: 'New' }));
  await waitFor(() => expect(entry('Tagging', 'New prompt').getAttribute('aria-pressed')).toBe('true'));
  expect(field('Name').value).toBe('New prompt');
  expect(field('Text').value).toBe(BUILT_IN_TAGGING_TEXT);
  expect(field('Tag limit').value).toBe('15');

  await userEvent.click(within(group('Tagging')).getByRole('button', { name: 'New' }));
  await waitFor(() => expect(entry('Tagging', 'New prompt 2').getAttribute('aria-pressed')).toBe('true'));

  const saves = requestsOf(api, 'analysisPrompts:save');
  expect(saves.map((s) => [s.id, s.purpose, s.name])).toEqual([
    [undefined, 'tagging', 'New prompt'],
    [undefined, 'tagging', 'New prompt 2'],
  ]);
  expect(saves[0]!.text).toBe(BUILT_IN_TAGGING_TEXT);
  expect(requestsOf(api, 'analysisPrompts:reset')).toHaveLength(2);

  await userEvent.click(within(group('Image to prompt')).getByRole('button', { name: 'New' }));
  await waitFor(() => expect(entry('Image to prompt', 'New prompt').getAttribute('aria-pressed')).toBe('true'));
  expect(screen.queryByLabelText('Tag limit')).toBeNull();
});

it('Reset calls the channel without asking and shows the returned text', async () => {
  const { api } = install();
  renderSection();
  await loaded();
  await userEvent.click(entry('Tagging', 'Detailed'));
  await userEvent.type(field('Text'), ' unsaved');
  await userEvent.click(button('Reset'));
  await waitFor(() => expect(field('Text').value).toBe(BUILT_IN_TAGGING_TEXT));
  expect(field('Tag limit').value).toBe('15');
  expect(field('Name').value).toBe('Detailed');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(requestsOf(api, 'analysisPrompts:reset')).toEqual([{ id: DETAILED.id }]);
  expect(screen.queryByTitle('Unsaved changes')).toBeNull();
});

it('Delete asks first, then calls the channel', async () => {
  const { api } = install();
  renderSection();
  await loaded();
  await userEvent.click(entry('Tagging', 'Detailed'));
  await userEvent.click(button('Delete'));
  const dialog = await screen.findByRole('dialog', { name: 'Delete the prompt Detailed?' });
  expect(requestsOf(api, 'analysisPrompts:delete')).toHaveLength(0);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(within(group('Tagging')).queryByRole('button', { name: 'Detailed' })).toBeNull());
  expect(requestsOf(api, 'analysisPrompts:delete')).toEqual([{ id: DETAILED.id }]);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // The selection moves to a remaining prompt.
  expect(entry('Tagging', 'Default').getAttribute('aria-pressed')).toBe('true');
});

it('Delete is disabled for the only prompt of a purpose', async () => {
  install();
  renderSection();
  await loaded();
  await userEvent.click(entry('Image to prompt', 'Default'));
  expect(button('Delete').disabled).toBe(true);
  expect(button('Delete').title).toBe('The last prompt cannot be deleted');
  await userEvent.click(entry('Tagging', 'Default'));
  expect(button('Delete').disabled).toBe(false);
});

it('a refused save shows its fixed message and keeps the draft', async () => {
  install();
  renderSection();
  await loaded();
  await userEvent.click(entry('Tagging', 'Detailed'));
  await userEvent.clear(field('Name'));
  await userEvent.type(field('Name'), 'default');
  await userEvent.click(button('Save'));
  expect((await screen.findByRole('alert')).textContent).toBe('An analysis prompt with this name already exists');
  expect(field('Name').value).toBe('default');
  expect(within(entry('Tagging', 'Detailed')).getByTitle('Unsaved changes')).toBeTruthy();
});

it('a failed load shows an alert with a retry button that recovers', async () => {
  const { api, fake } = install({
    'analysisPrompts:list': () => {
      throw fakeError('internal_error', 'internal_error');
    },
  });
  renderSection();
  expect((await screen.findByRole('alert')).textContent).toBe('The analysis prompts could not be read');
  api.set('analysisPrompts:list', fake.handlers['analysisPrompts:list']);
  await userEvent.click(button('Retry'));
  await loaded();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('uses only the shared button styles', async () => {
  install();
  renderSection();
  await loaded();
  const allowed = new Set([BUTTON, ICON_BUTTON, BUTTON_INLINE]);
  for (const el of screen.getAllByRole('button')) expect(allowed.has(el.className)).toBe(true);
});

// --- inside the settings screen ---

const ENVIRONMENT = providerView({ id: 'environment', name: 'Environment' });

const section = (name: string) => screen.getByRole('heading', { name }).closest('section')! as HTMLElement;

function renderSettings() {
  return render(
    <ProviderSettingsProvider>
      <AnalysisPromptsProvider>
        <SettingsScreen />
      </AnalysisPromptsProvider>
    </ProviderSettingsProvider>,
  );
}

it('the section is editable in the environment mode of the provider settings', async () => {
  install(fakeProviders({ providers: [ENVIRONMENT], fromEnvironment: true }).handlers);
  renderSettings();
  await screen.findByText('From environment');
  await loaded();
  expect((within(section('Vision providers')).getByLabelText('Name') as HTMLInputElement).disabled).toBe(true);
  expect((within(section('Analysis prompts')).getByLabelText('Name') as HTMLInputElement).disabled).toBe(false);
});

it('the section is there when the provider settings cannot be read', async () => {
  install({
    'providers:list': () => {
      throw fakeError('internal_error', 'internal_error');
    },
  });
  renderSettings();
  await waitFor(() => expect(within(section('Vision providers')).getByRole('button', { name: 'Retry' })).toBeTruthy());
  await loaded();
  expect(within(section('Analysis prompts')).queryByRole('button', { name: 'Retry' })).toBeNull();
});
