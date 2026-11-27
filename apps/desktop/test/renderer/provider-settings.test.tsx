import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_PROVIDER_OPTIONS,
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
    options: DEFAULT_PROVIDER_OPTIONS,
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
  for (const name of ['Name', 'Base URL', 'API key', 'Timeout (s)', 'Temperature', 'Max. answer tokens', 'Extra parameters'])
    expect(field(name).disabled).toBe(true);
  for (const name of ['Tagging model', 'Prompt model', 'Thinking']) expect(select(name).disabled).toBe(true);
  expect(field('Temperature').value).toBe('0');
  expect(select('Thinking').value).toBe('default');
  expect(field('Max. answer tokens').value).toBe('');
  expect(field('Extra parameters').value).toBe('');
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
  expect(within(select('Kind')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Ollama', 'OpenAI-compatible', 'Venice']);
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

// --- OpenAI-compatible kind and request options ---

const OPTION_FIELDS = ['Temperature', 'Thinking', 'Max. answer tokens', 'Extra parameters', 'Parallel requests'];
const TOOLTIPS: Record<string, string> = {
  Temperature: '0 gives the most repeatable answers',
  Thinking:
    'Sent as think (Ollama) or chat_template_kwargs.enable_thinking (OpenAI-compatible). For other models leave Server default and use Extra parameters',
  'Max. answer tokens': 'Empty: the server decides',
  'Extra parameters': 'A JSON object merged into every request of this provider',
  'Parallel requests': 'Analysis requests sent at the same time',
};
const NOT_AN_OBJECT = 'The extra parameters are not a JSON object';
const RESPONSE_FORMAT = 'The extra parameters must not set response_format';

const TUNED = providerView({
  name: 'Tuned',
  options: { temperature: 0.7, thinking: 'on', maxTokens: 512, extra: '{"top_k":40}', parallelRequests: 6 },
});
const VLLM = providerView({ kind: 'openai', name: 'vLLM', baseUrl: 'http://127.0.0.1:11500/v1', taggingModel: null, promptModel: null });

/** Replaces the text of a field; `paste` so braces are not read as key names. */
async function retype(user: ReturnType<typeof userEvent.setup>, name: string, text: string) {
  await user.clear(field(name));
  if (text !== '') {
    await user.click(field(name));
    await user.paste(text);
  }
}

it('choosing OpenAI-compatible shows the placeholder and the option fields, Venice hides them', async () => {
  const user = userEvent.setup();
  install();
  renderSection();
  await loaded();
  await user.click(button('New'));
  for (const name of OPTION_FIELDS) expect(screen.getByLabelText(name)).toBeTruthy();
  await user.selectOptions(select('Kind'), 'openai');
  expect(field('Base URL').value).toBe('');
  expect(field('Base URL').placeholder).toBe('http://localhost:8000/v1');
  expect(select('Tagging model')).toBeTruthy();
  expect(select('Prompt model')).toBeTruthy();
  for (const name of OPTION_FIELDS) expect(screen.getByLabelText(name)).toBeTruthy();
  expect(field('Temperature').value).toBe('0');
  expect(select('Thinking').value).toBe('default');
  expect(within(select('Thinking')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Server default', 'Off', 'On']);
  await user.selectOptions(select('Kind'), 'venice');
  for (const name of OPTION_FIELDS) expect(screen.queryByLabelText(name)).toBeNull();
});

it('the option fields carry their explanation only as tooltips', async () => {
  install();
  renderSection();
  await loaded();
  for (const name of OPTION_FIELDS) {
    const control = screen.getByLabelText(name);
    const label = control.closest('label')!;
    expect(label.getAttribute('title')).toBe(TOOLTIPS[name]);
    expect(screen.queryByText(TOOLTIPS[name]!)).toBeNull();
    const own = Array.from(label.querySelectorAll('span')).map((s) => s.textContent);
    expect(own).toEqual([name]);
  }
  const temperature = field('Temperature');
  expect([temperature.type, temperature.min, temperature.max, temperature.step]).toEqual(['number', '0', '2', '0.1']);
  expect(field('Max. answer tokens').type).toBe('number');
  const parallel = field('Parallel requests');
  expect([parallel.type, parallel.min, parallel.max, parallel.step, parallel.value]).toEqual(['number', '1', '64', '1', '1']);
  const extra = screen.getByLabelText('Extra parameters') as HTMLTextAreaElement;
  expect(extra.tagName).toBe('TEXTAREA');
  expect(extra.rows).toBe(4);
  expect(extra.maxLength).toBe(4000);
  expect(extra.getAttribute('spellcheck')).toBe('false');
  expect(extra.className).toContain('font-mono');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('an existing entry shows its stored options', async () => {
  install({ providers: [TUNED] });
  renderSection();
  await loaded();
  expect(field('Temperature').value).toBe('0.7');
  expect(select('Thinking').value).toBe('on');
  expect(field('Max. answer tokens').value).toBe('512');
  expect(field('Extra parameters').value).toBe('{"top_k":40}');
  expect(field('Parallel requests').value).toBe('6');
});

it('Save sends a changed parallel requests value and keeps it after the save', async () => {
  const user = userEvent.setup();
  const { api, fake } = install({ providers: [TUNED, VLLM] });
  renderSection();
  await loaded();
  await retype(user, 'Parallel requests', '12');
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'providers:save')).toHaveLength(1));
  expect((callsOf(api, 'providers:save')[0]!.request as SaveRequest).options?.parallelRequests).toBe(12);
  await waitFor(() => expect(fake.state.providers[0]!.options?.parallelRequests).toBe(12));
  expect(field('Parallel requests').value).toBe('12');
  await user.click(within(list()).getByRole('button', { name: 'vLLM' }));
  expect(field('Parallel requests').value).toBe('1');
  await retype(user, 'Parallel requests', '64');
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'providers:save')).toHaveLength(2));
  expect((callsOf(api, 'providers:save')[1]!.request as SaveRequest).options?.parallelRequests).toBe(64);
});

it('a Venice entry shows no parallel requests field', async () => {
  const user = userEvent.setup();
  const venice = providerView({ kind: 'venice', name: 'Venice', baseUrl: VENICE_DEFAULT_BASE_URL, taggingModel: null, promptModel: null, options: null });
  install({ providers: [LOCAL, venice] });
  renderSection();
  await loaded();
  expect(screen.getByLabelText('Parallel requests')).toBeTruthy();
  await user.click(within(list()).getByRole('button', { name: 'Venice' }));
  expect(screen.queryByLabelText('Parallel requests')).toBeNull();
  expect(screen.queryByText('Parallel requests')).toBeNull();
});

it('Save sends the typed options, and an empty token field as null', async () => {
  const user = userEvent.setup();
  const { api, fake } = install({ providers: [TUNED] });
  renderSection();
  await loaded();
  await retype(user, 'Temperature', '0.5');
  await user.selectOptions(select('Thinking'), 'off');
  await retype(user, 'Max. answer tokens', '256');
  await retype(user, 'Extra parameters', '{"top_p":0.9}');
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'providers:save')).toHaveLength(1));
  expect((callsOf(api, 'providers:save')[0]!.request as SaveRequest).options).toEqual({
    temperature: 0.5,
    thinking: 'off',
    maxTokens: 256,
    extra: '{"top_p":0.9}',
    parallelRequests: 6,
  });
  await waitFor(() => expect(fake.state.providers[0]!.options?.maxTokens).toBe(256));
  await retype(user, 'Max. answer tokens', '');
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'providers:save')).toHaveLength(2));
  expect((callsOf(api, 'providers:save')[1]!.request as SaveRequest).options).toEqual({
    temperature: 0.5,
    thinking: 'off',
    maxTokens: null,
    extra: '{"top_p":0.9}',
    parallelRequests: 6,
  });
});

it('a new OpenAI-compatible entry is sent with kind openai and its options', async () => {
  const user = userEvent.setup();
  const { api } = install();
  renderSection();
  await loaded();
  await user.click(button('New'));
  await user.selectOptions(select('Kind'), 'openai');
  await user.type(field('Name'), 'vLLM');
  await user.type(field('Base URL'), 'http://127.0.0.1:11500/v1');
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'providers:save')).toHaveLength(1));
  expect(callsOf(api, 'providers:save')[0]!.request).toEqual({
    kind: 'openai',
    name: 'vLLM',
    baseUrl: 'http://127.0.0.1:11500/v1',
    timeoutSeconds: 120,
    taggingModel: null,
    promptModel: null,
    options: DEFAULT_PROVIDER_OPTIONS,
  });
  await waitFor(() => expect(screen.getByText('OpenAI-compatible', { selector: '[data-kind]' })).toBeTruthy());
});

it.each([
  ['Temperature', ''],
  ['Temperature', '0,5'],
  ['Temperature', '3'],
  ['Max. answer tokens', '0'],
  ['Max. answer tokens', '1.5'],
  ['Parallel requests', ''],
  ['Parallel requests', '0'],
  ['Parallel requests', '65'],
  ['Parallel requests', '1.5'],
])('%s %j disables Save and marks the field invalid', async (name, text) => {
  const user = userEvent.setup();
  install();
  renderSection();
  await loaded();
  expect(button('Save').disabled).toBe(false);
  expect(field(name).getAttribute('aria-invalid')).toBeNull();
  await retype(user, name, text);
  expect(field(name).getAttribute('aria-invalid')).toBe('true');
  expect(button('Save').disabled).toBe(true);
});

it('extra parameters that are not an object show the fixed message and disable Save', async () => {
  const user = userEvent.setup();
  install();
  renderSection();
  await loaded();
  await retype(user, 'Extra parameters', '[1]');
  expect(field('Extra parameters').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('alert').textContent).toBe(NOT_AN_OBJECT);
  expect(button('Save').disabled).toBe(true);
  await retype(user, 'Extra parameters', '{"top_p":0.9}');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(field('Extra parameters').getAttribute('aria-invalid')).toBeNull();
  expect(button('Save').disabled).toBe(false);
});

it('response_format is refused for an openai entry and accepted for an ollama entry', async () => {
  const user = userEvent.setup();
  install({ providers: [LOCAL, VLLM] });
  renderSection();
  await loaded();
  await retype(user, 'Extra parameters', '{"response_format":{}}');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(button('Save').disabled).toBe(false);
  await user.click(within(list()).getByRole('button', { name: 'vLLM' }));
  await retype(user, 'Extra parameters', '{"response_format":{}}');
  expect(screen.getByRole('alert').textContent).toBe(RESPONSE_FORMAT);
  expect(field('Extra parameters').getAttribute('aria-invalid')).toBe('true');
  expect(button('Save').disabled).toBe(true);
});

it('a Venice entry is saved without options', async () => {
  const user = userEvent.setup();
  const { api } = install({ providers: [VENICE] }, { 'providers:listImageModels': () => EDIT_MODELS });
  renderSection();
  await loaded();
  for (const name of OPTION_FIELDS) expect(screen.queryByLabelText(name)).toBeNull();
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'providers:save')).toHaveLength(1));
  expect('options' in (callsOf(api, 'providers:save')[0]!.request as SaveRequest)).toBe(false);
});
