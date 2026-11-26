import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  VENICE_DEFAULT_BASE_URL,
  type ImageModel,
  type IpcRequest,
  type ListImageModelsResult,
  type ListModelsResult,
  type ProviderList,
  type ProviderView,
} from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { ProviderSettings } from '../../src/renderer/src/components/ProviderSettings';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { deferred, fakeError, fakeProviders, installFakeApi, providerView, type FakeHandlers } from './fake-api';

const TEST_KEY = 'test-key-not-real';
const ACTIVE_JOBS = 'This provider still has active jobs; move or cancel them first';

const LOCAL = providerView({ name: 'Local', timeoutSeconds: 90, taggingModel: 'vision-b', promptModel: 'vision-a', hasApiKey: true });
const RUNPOD = providerView({ name: 'RunPod', baseUrl: 'https://pod.example.test', taggingModel: null, promptModel: null });

const MODELS: ListModelsResult = {
  ok: true,
  models: [
    { name: 'vision-a', vision: true },
    { name: 'vision-b', vision: true },
  ],
};

type SaveRequest = IpcRequest<'providers:save'>;

function install(seed: Partial<ProviderList> = { providers: [LOCAL, RUNPOD] }, handlers: FakeHandlers = {}) {
  const fake = fakeProviders(seed, { [LOCAL.id]: MODELS, [RUNPOD.id]: { ok: false, code: 'provider_unauthorized' } });
  const api = installFakeApi({ ...fake.handlers, ...handlers });
  return { api, fake };
}

const callsOf = (api: ReturnType<typeof installFakeApi>, channel: string) => api.calls.filter((c) => c.channel === channel);
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const list = () => screen.getByRole('list', { name: 'Providers' });
const entryNames = () => within(list()).getAllByRole('button').map((b) => b.textContent);

function renderSection() {
  return render(
    <ProviderSettingsProvider>
      <ProviderSettings />
    </ProviderSettingsProvider>,
  );
}

async function loaded() {
  await waitFor(() => expect(field('Name').value).not.toBe(''));
}

it('the list shows the entries in store order and the first one in the editor', async () => {
  install();
  renderSection();
  await loaded();
  expect(entryNames()).toEqual(['Local', 'RunPod']);
  expect(within(list()).getByRole('button', { name: 'Local' }).getAttribute('aria-pressed')).toBe('true');
  expect(field('Name').value).toBe('Local');
  expect(field('Base URL').value).toBe('http://127.0.0.1:11500');
  expect(field('Timeout (s)').value).toBe('90');
  expect(field('API key').value).toBe('');
  expect(field('API key').type).toBe('password');
  expect(screen.getByText('Stored')).toBeTruthy();
  await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
  expect(select('Tagging model').value).toBe('vision-b');
  expect(select('Prompt model').value).toBe('vision-a');
});

it('selecting an entry fills the editor with it and its state', async () => {
  const user = userEvent.setup();
  install();
  renderSection();
  await loaded();
  await user.click(within(list()).getByRole('button', { name: 'RunPod' }));
  expect(field('Name').value).toBe('RunPod');
  expect(field('Base URL').value).toBe('https://pod.example.test');
  expect(field('Timeout (s)').value).toBe('120');
  expect(select('Tagging model').value).toBe('');
  expect(screen.queryByText('Stored')).toBeNull();
  expect(await screen.findByText('key refused')).toBeTruthy();
  expect(within(list()).getByRole('button', { name: 'RunPod' }).getAttribute('aria-pressed')).toBe('true');
});

it('Save sends the id and no apiKey when the key field was not touched', async () => {
  const user = userEvent.setup();
  const { api } = install();
  renderSection();
  await loaded();
  await user.clear(field('Timeout (s)'));
  await user.type(field('Timeout (s)'), '30');
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'providers:save')).toHaveLength(1));
  const request = callsOf(api, 'providers:save')[0]!.request as SaveRequest;
  expect(request).toEqual({
    id: LOCAL.id,
    name: 'Local',
    baseUrl: 'http://127.0.0.1:11500',
    timeoutSeconds: 30,
    taggingModel: 'vision-b',
    promptModel: 'vision-a',
  });
  expect('apiKey' in request).toBe(false);
});

it('a typed key is sent and leaves the field after the save', async () => {
  const user = userEvent.setup();
  const { api } = install();
  renderSection();
  await loaded();
  await user.click(within(list()).getByRole('button', { name: 'RunPod' }));
  await user.type(field('API key'), TEST_KEY);
  await user.click(button('Save'));
  await waitFor(() => expect(field('API key').value).toBe(''));
  expect((callsOf(api, 'providers:save')[0]!.request as SaveRequest).apiKey).toBe(TEST_KEY);
  expect(await screen.findByText('Stored')).toBeTruthy();
});

it('Save after Remove key sends apiKey null', async () => {
  const user = userEvent.setup();
  const { api, fake } = install();
  renderSection();
  await loaded();
  await user.click(button('Remove key'));
  expect(screen.queryByText('Stored')).toBeNull();
  expect(callsOf(api, 'providers:save')).toHaveLength(0);
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'providers:save')).toHaveLength(1));
  expect((callsOf(api, 'providers:save')[0]!.request as SaveRequest).apiKey).toBeNull();
  await waitFor(() => expect(fake.state.providers[0]!.hasApiKey).toBe(false));
  expect(screen.queryByText('Stored')).toBeNull();
});

it('New then Save sends no id and selects the new entry', async () => {
  const user = userEvent.setup();
  const { api } = install();
  renderSection();
  await loaded();
  await user.click(button('New'));
  expect(field('Name').value).toBe('');
  expect(field('Timeout (s)').value).toBe('120');
  expect(button('Save').disabled).toBe(true);
  expect(button('Delete').disabled).toBe(true);
  await user.type(field('Name'), 'Studio');
  await user.type(field('Base URL'), 'http://127.0.0.1:11501');
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'providers:save')).toHaveLength(1));
  const request = callsOf(api, 'providers:save')[0]!.request as SaveRequest;
  expect('id' in request).toBe(false);
  expect(request).toMatchObject({ name: 'Studio', baseUrl: 'http://127.0.0.1:11501', timeoutSeconds: 120 });
  await waitFor(() => expect(entryNames()).toEqual(['Local', 'RunPod', 'Studio']));
  expect(within(list()).getByRole('button', { name: 'Studio' }).getAttribute('aria-pressed')).toBe('true');
  expect(button('Delete').disabled).toBe(false);
});

it('an edit made while a save runs survives the answer, and the entries wait for it', async () => {
  const user = userEvent.setup();
  const answer = deferred<ProviderView>();
  const { api } = install(undefined, { 'providers:save': () => answer.promise });
  renderSection();
  await loaded();
  await user.clear(field('Timeout (s)'));
  await user.type(field('Timeout (s)'), '30');
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'providers:save')).toHaveLength(1));
  for (const el of within(list()).getAllByRole('button')) expect((el as HTMLButtonElement).disabled).toBe(true);
  expect(button('New').disabled).toBe(true);
  await user.clear(field('Timeout (s)'));
  await user.type(field('Timeout (s)'), '45');
  await act(async () => answer.resolve({ ...LOCAL, timeoutSeconds: 30 }));
  expect(field('Timeout (s)').value).toBe('45');
  for (const el of within(list()).getAllByRole('button')) expect((el as HTMLButtonElement).disabled).toBe(false);
  expect(button('New').disabled).toBe(false);
});

it('a refused save shows its message', async () => {
  const user = userEvent.setup();
  install();
  renderSection();
  await loaded();
  await user.clear(field('Name'));
  await user.type(field('Name'), 'runpod');
  await user.click(button('Save'));
  expect((await screen.findByRole('alert')).textContent).toBe('A provider with this name already exists');
  expect(entryNames()).toEqual(['Local', 'RunPod']);
});

it('Delete asks first, then sends providers:delete', async () => {
  const user = userEvent.setup();
  const { api } = install();
  renderSection();
  await loaded();
  await user.click(button('Delete'));
  const dialog = await screen.findByRole('dialog', { name: 'Delete the provider Local?' });
  expect(callsOf(api, 'providers:delete')).toHaveLength(0);
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(callsOf(api, 'providers:delete').map((c) => c.request)).toEqual([{ id: LOCAL.id }]));
  await waitFor(() => expect(entryNames()).toEqual(['RunPod']));
  expect(field('Name').value).toBe('RunPod');
});

it('Cancel in the delete question sends nothing', async () => {
  const user = userEvent.setup();
  const { api } = install();
  renderSection();
  await loaded();
  await user.click(button('Delete'));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(callsOf(api, 'providers:delete')).toHaveLength(0);
  expect(entryNames()).toEqual(['Local', 'RunPod']);
});

it('a refused delete shows its message and keeps the entry', async () => {
  const user = userEvent.setup();
  install(undefined, {
    'providers:delete': () => {
      throw fakeError('invalid_operation', ACTIVE_JOBS);
    },
  });
  renderSection();
  await loaded();
  await user.click(button('Delete'));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
  expect((await screen.findByRole('alert')).textContent).toBe(ACTIVE_JOBS);
  expect(entryNames()).toEqual(['Local', 'RunPod']);
});

it('New is disabled at 10 entries with the limit as tooltip', async () => {
  const providers = Array.from({ length: 10 }, (_, i) => providerView({ name: `P${i + 1}` }));
  install({ providers });
  renderSection();
  await loaded();
  expect(button('New').disabled).toBe(true);
  expect(button('New').getAttribute('title')).toBe('No more than 10 providers');
});

it('environment mode shows the entry with every control disabled', async () => {
  const env = providerView({ id: 'environment', name: 'Environment', hasApiKey: false });
  installFakeApi(fakeProviders({ providers: [env], fromEnvironment: true }).handlers);
  renderSection();
  await loaded();
  expect(screen.getByText('From environment')).toBeTruthy();
  expect(entryNames()).toEqual(['Environment']);
  for (const name of ['Name', 'Base URL', 'API key', 'Timeout (s)']) expect(field(name).disabled).toBe(true);
  for (const name of ['Tagging model', 'Prompt model']) expect(select(name).disabled).toBe(true);
  for (const el of screen.getAllByRole('button')) expect((el as HTMLButtonElement).disabled).toBe(true);
});

// --- provider kinds ---

const VENICE = providerView({
  kind: 'venice',
  name: 'Venice',
  baseUrl: VENICE_DEFAULT_BASE_URL,
  taggingModel: null,
  promptModel: null,
  editModel: 'edit-b',
  hasApiKey: true,
});
const editModel = (name: string, price: string | null = null): ImageModel => ({
  name,
  aspectRatios: null,
  resolutions: null,
  defaultResolution: null,
  promptCharacterLimit: null,
  price,
});
const EDIT_MODELS: ListImageModelsResult = { ok: true, models: [editModel('edit-a', '0.04 USD'), editModel('edit-b')] };

it('creating a Venice entry sends kind venice and the prefilled URL', async () => {
  const user = userEvent.setup();
  const { api } = install();
  renderSection();
  await loaded();
  await user.click(button('New'));
  expect(select('Kind').value).toBe('ollama');
  expect(within(select('Kind')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Ollama', 'Venice']);
  expect(field('Base URL').value).toBe('');
  await user.selectOptions(select('Kind'), 'venice');
  expect(field('Base URL').value).toBe(VENICE_DEFAULT_BASE_URL);
  expect(screen.queryByRole('combobox', { name: 'Tagging model' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Prompt model' })).toBeNull();
  expect(select('Edit model').value).toBe('');
  // Back to Ollama the untouched prefill leaves again, and Venice brings it back.
  await user.selectOptions(select('Kind'), 'ollama');
  expect(field('Base URL').value).toBe('');
  expect(select('Tagging model')).toBeTruthy();
  await user.selectOptions(select('Kind'), 'venice');
  await user.type(field('Name'), 'Venice');
  await user.type(field('API key'), TEST_KEY);
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'providers:save')).toHaveLength(1));
  expect(callsOf(api, 'providers:save')[0]!.request).toEqual({
    kind: 'venice',
    name: 'Venice',
    baseUrl: VENICE_DEFAULT_BASE_URL,
    timeoutSeconds: 120,
    taggingModel: null,
    promptModel: null,
    editModel: null,
    apiKey: TEST_KEY,
  });
  await waitFor(() => expect(entryNames()).toEqual(['Local', 'RunPod', 'Venice']));
  expect(screen.queryByRole('combobox', { name: 'Kind' })).toBeNull();
  expect(screen.getByText('Venice', { selector: '[data-kind]' })).toBeTruthy();
  // The new entry is asked for its edit models, not its vision models.
  const saved = within(list()).getByRole('button', { name: 'Venice' });
  expect(saved.getAttribute('aria-pressed')).toBe('true');
  expect(await screen.findByText('no edit model')).toBeTruthy();
});

it('a typed base URL stays when the kind changes', async () => {
  const user = userEvent.setup();
  install();
  renderSection();
  await loaded();
  await user.click(button('New'));
  await user.type(field('Base URL'), 'http://127.0.0.1:11500/api/v1');
  await user.selectOptions(select('Kind'), 'venice');
  expect(field('Base URL').value).toBe('http://127.0.0.1:11500/api/v1');
});

it('editing does not offer the kind and shows it read-only', async () => {
  const user = userEvent.setup();
  const { api } = install({ providers: [LOCAL, VENICE] }, { 'providers:listImageModels': () => EDIT_MODELS });
  renderSection();
  await loaded();
  expect(screen.queryByRole('combobox', { name: 'Kind' })).toBeNull();
  expect(screen.getByText('Ollama', { selector: '[data-kind]' })).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Edit model' })).toBeNull();
  await user.click(within(list()).getByRole('button', { name: 'Venice' }));
  expect(screen.queryByRole('combobox', { name: 'Kind' })).toBeNull();
  expect(screen.getByText('Venice', { selector: '[data-kind]' })).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Tagging model' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Prompt model' })).toBeNull();
  await waitFor(() => expect(within(select('Edit model')).getAllByRole('option').map((o) => o.textContent)).toEqual(['No model', 'edit-a', 'edit-b']));
  expect(select('Edit model').value).toBe('edit-b');
  expect(within(select('Edit model')).getByRole('option', { name: 'edit-a' }).getAttribute('title')).toBe('0.04 USD');
  expect(screen.getByText('ready')).toBeTruthy();
  await user.selectOptions(select('Edit model'), 'edit-a');
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'providers:save')).toHaveLength(1));
  expect(callsOf(api, 'providers:save')[0]!.request).toEqual({
    id: VENICE.id,
    name: 'Venice',
    baseUrl: VENICE_DEFAULT_BASE_URL,
    timeoutSeconds: 120,
    taggingModel: null,
    promptModel: null,
    editModel: 'edit-a',
  });
  const before = callsOf(api, 'providers:listImageModels').length;
  await user.click(button('Refresh models'));
  expect(callsOf(api, 'providers:listImageModels').slice(before).map((c) => c.request)).toEqual([{ providerId: VENICE.id, refresh: true }]);
});

it('an empty list opens the editor for a new entry', async () => {
  const user = userEvent.setup();
  const { api } = install({ providers: [] });
  renderSection();
  await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy());
  expect(within(list()).queryAllByRole('button')).toHaveLength(0);
  await user.type(field('Name'), 'Local');
  await user.type(field('Base URL'), 'http://127.0.0.1:11500');
  await user.click(button('Save'));
  await waitFor(() => expect(entryNames()).toEqual(['Local']));
  expect('id' in (callsOf(api, 'providers:save')[0]!.request as SaveRequest)).toBe(false);
});
