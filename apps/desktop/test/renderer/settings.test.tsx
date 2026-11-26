import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { JOB_ERROR_MESSAGES, type ListModelsResult, type ProviderList } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { ModelSelect } from '../../src/renderer/src/components/ModelSelect';
import { ProviderSettingsProvider, useProviders } from '../../src/renderer/src/provider-context';
import { SettingsScreen } from '../../src/renderer/src/screens/SettingsScreen';
import { BUTTON, BUTTON_INLINE, ICON_BUTTON } from '../../src/renderer/src/ui';
import { deferred, fakeError, fakeProviders, installFakeApi, providerView, type FakeHandlers } from './fake-api';

const STORED = providerView({ name: 'Local', timeoutSeconds: 90, taggingModel: 'vision-b', promptModel: 'vision-a', hasApiKey: true });

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

function install(seed: Partial<ProviderList> = { providers: [STORED] }, models: ListModelsResult = MODELS, handlers: FakeHandlers = {}) {
  const ids = (seed.providers ?? []).map((p) => p.id);
  const fake = fakeProviders(seed, Object.fromEntries(ids.map((id) => [id, models])));
  return installFakeApi({ ...fake.handlers, ...handlers });
}

const callsOf = (api: ReturnType<typeof installFakeApi>, channel: string) => api.calls.filter((c) => c.channel === channel);

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
const providersSection = () => screen.getByRole('heading', { name: 'Vision providers' }).closest('section')!;

async function loaded() {
  await waitFor(() => expect(field('Base URL').value).not.toBe(''));
  await waitFor(() => expect(optionTexts(select('Tagging model'))).toContain('alpha-unknown'));
}

// --- provider context ---

it('the provider loads the list once and the models of every entry', async () => {
  const other = providerView({ name: 'Other' });
  const api = install({ providers: [STORED, other] });
  function Probe() {
    const { list, models } = useProviders();
    const count = (id: string) => {
      const answer = models[id];
      return answer?.ok === true ? answer.models.length : 'none';
    };
    return <p>{`${list?.providers.length ?? 'none'}|${count(STORED.id)}|${count(other.id)}`}</p>;
  }
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  expect(await screen.findByText('2|5|5')).toBeTruthy();
  expect(callsOf(api, 'providers:list')).toHaveLength(1);
  expect(callsOf(api, 'providers:listModels').map((c) => c.request)).toEqual([{ providerId: STORED.id }, { providerId: other.id }]);
});

it('a newer list reload wins over an older one that answers later', async () => {
  const first = deferred<ProviderList>();
  const renamed = { ...STORED, name: 'Renamed' };
  let calls = 0;
  const fake = fakeProviders({ providers: [STORED] }, { [STORED.id]: MODELS });
  installFakeApi({
    ...fake.handlers,
    'providers:list': () => {
      calls += 1;
      return calls === 1 ? first.promise : { ...fake.state, providers: [renamed] };
    },
  });
  let reload: (() => Promise<void>) | null = null;
  function Probe() {
    const state = useProviders();
    reload = state.reload;
    return <p>{state.list?.providers[0]?.name ?? 'none'}</p>;
  }
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  await act(async () => {
    await reload!();
  });
  expect(screen.getByText('Renamed')).toBeTruthy();
  await act(async () => first.resolve({ ...fake.state }));
  expect(screen.getByText('Renamed')).toBeTruthy();
});

// --- settings screen ---

it('the screen shows the provider section and the prompts section', async () => {
  install();
  renderScreen();
  await loaded();
  expect(screen.getByRole('heading', { level: 2, name: 'Settings' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Vision providers' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Prompts' })).toBeTruthy();
});

it('the editor shows the stored values and an always empty, write-only key field', async () => {
  install();
  renderScreen();
  await loaded();
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

it('a timeout outside 10 to 600 disables Save with the reason', async () => {
  const user = userEvent.setup();
  install();
  renderScreen();
  await loaded();
  const save = within(providersSection()).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  await user.clear(field('Timeout (s)'));
  await user.type(field('Timeout (s)'), '5');
  expect(save.disabled).toBe(true);
  expect(save.getAttribute('title')).toBe('The timeout must be a whole number from 10 to 600');
  expect(field('Timeout (s)').getAttribute('aria-invalid')).toBe('true');
  await user.clear(field('Timeout (s)'));
  await user.type(field('Timeout (s)'), '600');
  expect(save.disabled).toBe(false);
});

it('an empty name or base URL disables Save with the reason', async () => {
  const user = userEvent.setup();
  install();
  renderScreen();
  await loaded();
  const save = within(providersSection()).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  await user.clear(field('Base URL'));
  expect(save.disabled).toBe(true);
  expect(save.getAttribute('title')).toBe('Enter a base URL');
  await user.clear(field('Name'));
  expect(save.getAttribute('title')).toBe('Enter a name');
});

it('a failed list load shows its message and a retry', async () => {
  const user = userEvent.setup();
  let fail = true;
  const fake = fakeProviders({ providers: [STORED] }, { [STORED.id]: MODELS });
  installFakeApi({
    ...fake.handlers,
    'providers:list': () => {
      if (fail) throw fakeError('internal_error', 'internal_error');
      return structuredClone(fake.state);
    },
  });
  renderScreen();
  const section = () => providersSection();
  expect((await within(section()).findByRole('alert')).textContent).toBe('The provider settings could not be read');
  fail = false;
  await user.click(within(section()).getByRole('button', { name: 'Retry' }));
  await loaded();
});

it('a failed model list shows the fixed message of its code and keeps the stored models', async () => {
  install({ providers: [STORED] }, { ok: false, code: 'provider_unauthorized' });
  renderScreen();
  await waitFor(() => expect(field('Base URL').value).not.toBe(''));
  expect((await screen.findAllByText(JOB_ERROR_MESSAGES.provider_unauthorized)).length).toBeGreaterThan(0);
  expect(screen.getByText('key refused')).toBeTruthy();
  expect(select('Tagging model').value).toBe('vision-b');
});

it('canStoreKey false disables the key field with a title', async () => {
  install({ providers: [{ ...STORED, hasApiKey: false }], canStoreKey: false });
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
  install({ providers: [{ ...STORED, taggingModel: 'gone-model' }] });
  renderScreen();
  await loaded();
  expect(select('Tagging model').value).toBe('gone-model');
  expect(within(select('Tagging model')).getByRole('option', { name: 'gone-model' })).toBeTruthy();
});

it('every button uses a ui.ts class', async () => {
  install();
  renderScreen();
  await loaded();
  const allowed = new Set([BUTTON, ICON_BUTTON, BUTTON_INLINE]);
  for (const el of screen.getAllByRole('button')) expect(allowed.has(el.className)).toBe(true);
});

// --- model select on its own ---

function Harness({ initial, providerId = STORED.id }: { initial: string | null; providerId?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <ModelSelect providerId={providerId} purpose="tagging" value={value} onChange={setValue} />
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
  const fake = fakeProviders({ providers: [STORED] }, { [STORED.id]: () => new Promise(() => {}) });
  installFakeApi(fake.handlers);
  render(
    <ProviderSettingsProvider>
      <Harness initial="vision-b" />
    </ProviderSettingsProvider>,
  );
  expect(select('Tagging model').value).toBe('vision-b');
});

it('the model select without an entry lists nothing and cannot refresh', async () => {
  install();
  render(
    <ProviderSettingsProvider>
      <Harness initial={null} providerId={null} />
    </ProviderSettingsProvider>,
  );
  expect(optionTexts(select('Tagging model'))).toEqual(['No model']);
  expect(button('Refresh models').disabled).toBe(true);
});

it('the refresh button lists the models of its entry with refresh', async () => {
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
  await waitFor(() =>
    expect(callsOf(api, 'providers:listModels').at(-1)!.request).toEqual({ providerId: STORED.id, refresh: true }),
  );
});
