import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  JOB_ERROR_MESSAGES,
  type IpcRequest,
  type ListModelsResult,
  type VisionSettingsView,
} from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { ModelSelect } from '../../src/renderer/src/components/ModelSelect';
import { ProviderSettingsProvider, useProvider } from '../../src/renderer/src/provider-context';
import { SettingsScreen } from '../../src/renderer/src/screens/SettingsScreen';
import { BUTTON, BUTTON_INLINE, ICON_BUTTON } from '../../src/renderer/src/ui';
import { installFakeApi, type FakeHandlers } from './fake-api';

const TEST_KEY = 'test-key-not-real';

const STORED: VisionSettingsView = {
  baseUrl: 'http://127.0.0.1:11500',
  timeoutSeconds: 90,
  taggingModel: 'vision-b',
  promptModel: 'vision-a',
  hasApiKey: true,
  fromEnvironment: false,
  canStoreKey: true,
};

const UNCONFIGURED: VisionSettingsView = {
  baseUrl: null,
  timeoutSeconds: 120,
  taggingModel: null,
  promptModel: null,
  hasApiKey: false,
  fromEnvironment: false,
  canStoreKey: true,
};

const MODELS: ListModelsResult = {
  ok: true,
  models: [
    { name: 'zeta-unknown', vision: null },
    { name: 'text-only', vision: false },
    { name: 'vision-b', vision: true },
    { name: 'alpha-unknown', vision: null },
    { name: 'vision-a', vision: true },
  ],
};

type SetRequest = IpcRequest<'settings:setVision'>;

function install(view: VisionSettingsView = STORED, models: ListModelsResult = MODELS, handlers: FakeHandlers = {}) {
  let current = view;
  return installFakeApi({
    'settings:getVision': () => current,
    'settings:setVision': (request) => {
      const { apiKey, ...rest } = request;
      current = {
        ...current,
        ...rest,
        hasApiKey: apiKey === undefined ? current.hasApiKey : apiKey !== null,
      };
      return current;
    },
    'settings:listVisionModels': () => models,
    ...handlers,
  });
}

const callsOf = (api: ReturnType<typeof installFakeApi>, channel: string) =>
  api.calls.filter((c) => c.channel === channel);

function renderScreen() {
  return render(
    <ProviderSettingsProvider>
      <SettingsScreen />
    </ProviderSettingsProvider>,
  );
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const optionTexts = (el: HTMLSelectElement) => within(el).getAllByRole('option').map((o) => o.textContent);

async function loaded() {
  await waitFor(() => expect(field('Base URL').value).not.toBe(''));
  await waitFor(() => expect(optionTexts(select('Tagging model'))).toContain('alpha-unknown'));
}

// --- provider context ---

it('useProvider outside a provider returns the empty state', () => {
  let state: ReturnType<typeof useProvider> | null = null;
  function Probe() {
    state = useProvider();
    return null;
  }
  render(<Probe />);
  expect(state).toMatchObject({ settings: null, models: null, loading: false });
});

it('the provider loads the settings once and the models when there is a base URL', async () => {
  const api = install();
  function Probe() {
    const { settings, models } = useProvider();
    return <p>{`${settings?.baseUrl ?? 'none'}|${models?.ok === true ? models.models.length : 'no models'}`}</p>;
  }
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  expect(await screen.findByText('http://127.0.0.1:11500|5')).toBeTruthy();
  expect(callsOf(api, 'settings:getVision')).toHaveLength(1);
  expect(callsOf(api, 'settings:listVisionModels').map((c) => c.request)).toEqual([{}]);
});

it('the provider loads no models without a base URL', async () => {
  const api = install(UNCONFIGURED);
  function Probe() {
    const { settings, loading } = useProvider();
    return <p>{settings === null || loading ? 'loading' : 'ready'}</p>;
  }
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  expect(await screen.findByText('ready')).toBeTruthy();
  expect(callsOf(api, 'settings:listVisionModels')).toHaveLength(0);
});

// --- settings screen ---

it('the screen shows the stored values and an always empty, write-only key field', async () => {
  install();
  renderScreen();
  await loaded();
  expect(screen.getByRole('heading', { level: 2, name: 'Settings' })).toBeTruthy();
  expect(field('Base URL').value).toBe('http://127.0.0.1:11500');
  expect(field('Timeout (s)').value).toBe('90');
  expect(field('Timeout (s)').type).toBe('number');
  expect(field('Timeout (s)').min).toBe('10');
  expect(field('Timeout (s)').max).toBe('600');
  expect(select('Tagging model').value).toBe('vision-b');
  expect(select('Prompt model').value).toBe('vision-a');
  const key = field('API key');
  expect(key.type).toBe('password');
  expect(key.value).toBe('');
  expect(screen.getByText('Stored')).toBeTruthy();
  expect(button('Remove key')).toBeTruthy();
});

it('Save sends no apiKey when the key field is empty', async () => {
  const user = userEvent.setup();
  const api = install();
  renderScreen();
  await loaded();
  await user.clear(field('Timeout (s)'));
  await user.type(field('Timeout (s)'), '30');
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'settings:setVision')).toHaveLength(1));
  const request = callsOf(api, 'settings:setVision')[0]!.request as SetRequest;
  expect(request).toEqual({
    baseUrl: 'http://127.0.0.1:11500',
    timeoutSeconds: 30,
    taggingModel: 'vision-b',
    promptModel: 'vision-a',
  });
  expect('apiKey' in request).toBe(false);
});

it('Save with a typed key sends it and clears the field afterwards', async () => {
  const user = userEvent.setup();
  const api = install({ ...STORED, hasApiKey: false });
  renderScreen();
  await loaded();
  expect(screen.queryByText('Stored')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove key' })).toBeNull();
  await user.type(field('API key'), TEST_KEY);
  await user.click(button('Save'));
  await waitFor(() => expect(field('API key').value).toBe(''));
  expect((callsOf(api, 'settings:setVision')[0]!.request as SetRequest).apiKey).toBe(TEST_KEY);
  expect(await screen.findByText('Stored')).toBeTruthy();
});

it('Remove key sends apiKey null', async () => {
  const user = userEvent.setup();
  const api = install();
  renderScreen();
  await loaded();
  await user.click(button('Remove key'));
  await waitFor(() => expect(callsOf(api, 'settings:setVision')).toHaveLength(1));
  expect((callsOf(api, 'settings:setVision')[0]!.request as SetRequest).apiKey).toBeNull();
  await waitFor(() => expect(screen.queryByText('Stored')).toBeNull());
});

it('an empty base URL is saved as null', async () => {
  const user = userEvent.setup();
  const api = install();
  renderScreen();
  await loaded();
  await user.clear(field('Base URL'));
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'settings:setVision')).toHaveLength(1));
  expect((callsOf(api, 'settings:setVision')[0]!.request as SetRequest).baseUrl).toBeNull();
});

it('a timeout outside 10 to 600 disables Save', async () => {
  const user = userEvent.setup();
  install();
  renderScreen();
  await loaded();
  await user.clear(field('Timeout (s)'));
  await user.type(field('Timeout (s)'), '5');
  expect(button('Save').disabled).toBe(true);
  expect(field('Timeout (s)').getAttribute('aria-invalid')).toBe('true');
  await user.clear(field('Timeout (s)'));
  await user.type(field('Timeout (s)'), '600');
  expect(button('Save').disabled).toBe(false);
});

it('Test connection saves first, then lists the models with refresh', async () => {
  const user = userEvent.setup();
  const api = install();
  renderScreen();
  await loaded();
  await user.clear(field('Base URL'));
  await user.type(field('Base URL'), 'http://127.0.0.1:11501');
  await user.click(button('Test connection'));
  await waitFor(() =>
    expect(api.calls.some((c) => c.channel === 'settings:listVisionModels' && (c.request as { refresh?: boolean }).refresh === true)).toBe(true),
  );
  const channels = api.calls.map((c) => c.channel);
  const saved = channels.indexOf('settings:setVision');
  const refreshed = api.calls.findIndex(
    (c) => c.channel === 'settings:listVisionModels' && (c.request as { refresh?: boolean }).refresh === true,
  );
  expect(saved).toBeGreaterThanOrEqual(0);
  expect(saved).toBeLessThan(refreshed);
  expect((api.calls[saved]!.request as SetRequest).baseUrl).toBe('http://127.0.0.1:11501');
  expect(await screen.findByText('5 models')).toBeTruthy();
});

it('a failed model list shows the fixed message of its code', async () => {
  const user = userEvent.setup();
  install(STORED, { ok: false, code: 'provider_unauthorized' });
  renderScreen();
  await waitFor(() => expect(field('Base URL').value).not.toBe(''));
  await user.click(button('Test connection'));
  expect((await screen.findAllByText(JOB_ERROR_MESSAGES.provider_unauthorized)).length).toBeGreaterThan(0);
  // The stored models stay the current values although the list failed.
  expect(select('Tagging model').value).toBe('vision-b');
});

it('a rejected save shows the alert', async () => {
  const user = userEvent.setup();
  install(STORED, MODELS, {
    'settings:setVision': () => {
      throw new Error('boom');
    },
  });
  // A thrown non-AssetForge error reaches the renderer as a rejected invoke.
  renderScreen();
  await loaded();
  await user.click(button('Save'));
  expect((await screen.findByRole('alert')).textContent).toBe('The application did not respond');
});

it('fromEnvironment disables every control', async () => {
  install({ ...STORED, fromEnvironment: true });
  renderScreen();
  await loaded();
  for (const name of ['Base URL', 'API key', 'Timeout (s)']) expect(field(name).disabled).toBe(true);
  for (const name of ['Tagging model', 'Prompt model']) expect(select(name).disabled).toBe(true);
  for (const el of screen.getAllByRole('button')) expect((el as HTMLButtonElement).disabled).toBe(true);
});

it('canStoreKey false disables the key field with a title', async () => {
  install({ ...STORED, hasApiKey: false, canStoreKey: false });
  renderScreen();
  await loaded();
  const key = field('API key');
  expect(key.disabled).toBe(true);
  expect(key.getAttribute('title')).toBeTruthy();
  expect(field('Base URL').disabled).toBe(false);
});

it('the two model selects disable non-vision models and list vision, then unknown, by name', async () => {
  install();
  renderScreen();
  await loaded();
  for (const name of ['Tagging model', 'Prompt model']) {
    const el = select(name);
    const names = within(el)
      .getAllByRole('option')
      .filter((o) => !(o as HTMLOptionElement).disabled && (o as HTMLOptionElement).value !== '')
      .map((o) => o.textContent);
    expect(names).toEqual(['vision-a', 'vision-b', 'alpha-unknown', 'zeta-unknown']);
    const textOnly = within(el).getByRole('option', { name: 'text-only' }) as HTMLOptionElement;
    expect(textOnly.disabled).toBe(true);
  }
});

it('a stored model no longer in the list stays visible as the current value', async () => {
  install({ ...STORED, taggingModel: 'gone-model' });
  renderScreen();
  await loaded();
  expect(select('Tagging model').value).toBe('gone-model');
  expect(within(select('Tagging model')).getByRole('option', { name: 'gone-model' })).toBeTruthy();
});

it('works when nothing is configured: empty URL, no models', async () => {
  const user = userEvent.setup();
  const api = install(UNCONFIGURED);
  renderScreen();
  await waitFor(() => expect(button('Save').disabled).toBe(false));
  expect(field('Base URL').value).toBe('');
  expect(select('Tagging model').value).toBe('');
  expect(callsOf(api, 'settings:listVisionModels')).toHaveLength(0);
  await user.type(field('Base URL'), 'http://127.0.0.1:11500');
  await user.click(button('Save'));
  await waitFor(() => expect(callsOf(api, 'settings:listVisionModels').length).toBeGreaterThan(0));
  expect((callsOf(api, 'settings:setVision')[0]!.request as SetRequest).baseUrl).toBe('http://127.0.0.1:11500');
});

it('every button uses a ui.ts class', async () => {
  install();
  renderScreen();
  await loaded();
  const allowed = new Set([BUTTON, ICON_BUTTON, BUTTON_INLINE]);
  for (const el of screen.getAllByRole('button')) expect(allowed.has(el.className)).toBe(true);
});

// --- model select on its own ---

function Harness({ initial }: { initial: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <ModelSelect purpose="tagging" value={value} onChange={setValue} />
      <p>{`value:${value ?? 'none'}`}</p>
    </>
  );
}

it('the model select preselects nothing itself and reports the choice', async () => {
  const user = userEvent.setup();
  install();
  render(
    <ProviderSettingsProvider>
      <Harness initial={null} />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(optionTexts(select('Tagging model'))).toContain('vision-a'));
  expect(select('Tagging model').value).toBe('');
  await user.selectOptions(select('Tagging model'), 'vision-a');
  expect(screen.getByText('value:vision-a')).toBeTruthy();
});

it('the model select keeps its value while the list is loading', () => {
  install(STORED, MODELS, { 'settings:listVisionModels': () => new Promise(() => {}) });
  render(
    <ProviderSettingsProvider>
      <Harness initial="vision-b" />
    </ProviderSettingsProvider>,
  );
  expect(select('Tagging model').value).toBe('vision-b');
});

it('the refresh button lists the models with refresh', async () => {
  const user = userEvent.setup();
  const api = install();
  render(
    <ProviderSettingsProvider>
      <Harness initial={null} />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(optionTexts(select('Tagging model'))).toContain('vision-a'));
  const refresh = button('Refresh models');
  expect(refresh.className).toBe(ICON_BUTTON);
  expect(refresh.getAttribute('title')).toBe('Refresh models');
  await user.click(refresh);
  await waitFor(() => expect(callsOf(api, 'settings:listVisionModels').at(-1)!.request).toEqual({ refresh: true }));
});
