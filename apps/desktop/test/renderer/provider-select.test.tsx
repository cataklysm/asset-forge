import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ListModelsResult, ProviderList } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { ModelSelect } from '../../src/renderer/src/components/ModelSelect';
import { ProviderSelect } from '../../src/renderer/src/components/ProviderSelect';
import { PROVIDER_STATE_LABELS } from '../../src/renderer/src/labels';
import {
  defaultModelOf,
  defaultProviderId,
  providerStatus,
  ProviderSettingsProvider,
  useProviders,
  type ProvidersState,
} from '../../src/renderer/src/provider-context';
import { deferred, fakeError, fakeProviders, installFakeApi, providerView } from './fake-api';

const LOCAL = providerView({ name: 'Local', taggingModel: 'vision-a', promptModel: 'vision-b' });
const RUNPOD = providerView({ name: 'RunPod', baseUrl: 'https://pod.example.test', taggingModel: 'big-vision', promptModel: null });

const READY: ListModelsResult = { ok: true, models: [{ name: 'big-vision', vision: true }] };
const UNREACHABLE: ListModelsResult = { ok: false, code: 'provider_unreachable' };

const providerSelect = () => screen.getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement;
const optionTexts = (el: HTMLSelectElement) => within(el).getAllByRole('option').map((o) => o.textContent);
const modelCalls = (api: ReturnType<typeof installFakeApi>) => api.calls.filter((c) => c.channel === 'providers:listModels');

function Harness({ initial = null }: { initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <ProviderSelect value={value} onChange={setValue} />
      <ModelSelect providerId={value} purpose="tagging" value={null} onChange={() => {}} />
      <p>{`value:${value ?? 'none'}`}</p>
    </>
  );
}

function renderHarness(initial: string | null = LOCAL.id) {
  return render(
    <ProviderSettingsProvider>
      <Harness initial={initial} />
    </ProviderSettingsProvider>,
  );
}

let state: ProvidersState | null = null;
function Probe() {
  state = useProviders();
  return null;
}

it('useProviders outside a provider returns the empty state', () => {
  render(<Probe />);
  expect(state).toMatchObject({ list: null, loading: false, failed: false, models: {} });
});

it('the options name each entry with its state from the answers', async () => {
  const fake = fakeProviders({ providers: [LOCAL, RUNPOD] }, { [LOCAL.id]: UNREACHABLE, [RUNPOD.id]: READY });
  installFakeApi(fake.handlers);
  renderHarness();
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['Local — not reachable', 'RunPod — ready']));
  expect(providerSelect().value).toBe(LOCAL.id);
});

it('an entry shows checking until its answer arrives', async () => {
  const slow = deferred<ListModelsResult>();
  const fake = fakeProviders({ providers: [LOCAL, RUNPOD] }, { [LOCAL.id]: () => slow.promise, [RUNPOD.id]: READY });
  installFakeApi(fake.handlers);
  renderHarness();
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['Local — checking', 'RunPod — ready']));
  await act(async () => slow.resolve(READY));
  expect(optionTexts(providerSelect())).toEqual(['Local — ready', 'RunPod — ready']);
});

it('opening the select asks every entry once with refresh', async () => {
  const user = userEvent.setup();
  const fake = fakeProviders({ providers: [LOCAL, RUNPOD] });
  const api = installFakeApi(fake.handlers);
  renderHarness();
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['Local — ready', 'RunPod — ready']));
  const before = modelCalls(api).length;
  expect(modelCalls(api).every((c) => !('refresh' in (c.request as object)))).toBe(true);
  await user.click(providerSelect());
  const refreshed = modelCalls(api).slice(before).map((c) => c.request);
  expect(refreshed).toHaveLength(2);
  expect(refreshed).toEqual(
    expect.arrayContaining([
      { providerId: LOCAL.id, refresh: true },
      { providerId: RUNPOD.id, refresh: true },
    ]),
  );
});

it('choosing another entry switches the model list', async () => {
  const user = userEvent.setup();
  const fake = fakeProviders(
    { providers: [LOCAL, RUNPOD] },
    { [LOCAL.id]: { ok: true, models: [{ name: 'vision-a', vision: true }] }, [RUNPOD.id]: READY },
  );
  installFakeApi(fake.handlers);
  renderHarness();
  const models = () => screen.getByRole('combobox', { name: 'Tagging model' }) as HTMLSelectElement;
  await waitFor(() => expect(optionTexts(models())).toContain('vision-a'));
  await user.selectOptions(providerSelect(), RUNPOD.id);
  expect(screen.getByText(`value:${RUNPOD.id}`)).toBeTruthy();
  await waitFor(() => expect(optionTexts(models())).toContain('big-vision'));
  expect(optionTexts(models())).not.toContain('vision-a');
});

it('a slow answer for A that arrives after B was asked leaves B untouched', async () => {
  const slowA = deferred<ListModelsResult>();
  const answersB: ListModelsResult[] = [READY, { ok: true, models: [{ name: 'other', vision: true }] }];
  let callsA = 0;
  const fake = fakeProviders(
    { providers: [LOCAL, RUNPOD] },
    {
      [LOCAL.id]: () => {
        callsA += 1;
        return callsA === 1 ? READY : slowA.promise;
      },
      [RUNPOD.id]: () => answersB.shift() ?? READY,
    },
  );
  installFakeApi(fake.handlers);
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(state!.models[RUNPOD.id]).toEqual(READY));
  act(() => void state!.loadModels(LOCAL.id, true));
  await act(async () => {
    await state!.loadModels(RUNPOD.id, true);
  });
  const runpod = { ok: true, models: [{ name: 'other', vision: true }] };
  expect(state!.models[RUNPOD.id]).toEqual(runpod);
  await act(async () => slowA.resolve(UNREACHABLE));
  expect(state!.models[RUNPOD.id]).toEqual(runpod);
  expect(state!.models[LOCAL.id]).toEqual(UNREACHABLE);
});

it('an older answer for the same entry is dropped in favour of the newer one', async () => {
  const first = deferred<ListModelsResult>();
  let calls = 0;
  const fake = fakeProviders(
    { providers: [LOCAL] },
    {
      [LOCAL.id]: () => {
        calls += 1;
        return calls === 1 ? first.promise : READY;
      },
    },
  );
  installFakeApi(fake.handlers);
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(calls).toBe(1));
  await act(async () => {
    await state!.loadModels(LOCAL.id, true);
  });
  expect(state!.models[LOCAL.id]).toEqual(READY);
  await act(async () => first.resolve(UNREACHABLE));
  expect(state!.models[LOCAL.id]).toEqual(READY);
});

it('an answer that never comes keeps checking until the bound answers provider_timeout', async () => {
  const hanging = deferred<ListModelsResult>();
  const fake = fakeProviders({ providers: [LOCAL] }, { [LOCAL.id]: () => hanging.promise });
  installFakeApi(fake.handlers);
  renderHarness();
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['Local — checking']));
  await act(async () => hanging.resolve({ ok: false, code: 'provider_timeout' }));
  expect(optionTexts(providerSelect())).toEqual(['Local — not reachable']);
});

it('a rejected model call ends checking with its state', async () => {
  const fake = fakeProviders({ providers: [LOCAL] }, {
    [LOCAL.id]: () => {
      throw fakeError('not_found', 'This provider does not exist');
    },
  });
  installFakeApi(fake.handlers);
  renderHarness();
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['Local — error']));
});

it('maps every answer to its state', () => {
  const of = (answer: ListModelsResult | undefined) => providerStatus({ models: { x: answer } }, 'x');
  expect(of(undefined)).toBe('checking');
  expect(of(READY)).toBe('ready');
  expect(of({ ok: true, models: [{ name: 'unknown', vision: null }] })).toBe('ready');
  expect(of({ ok: true, models: [{ name: 'text', vision: false }] })).toBe('no_vision_model');
  expect(of({ ok: true, models: [] })).toBe('no_vision_model');
  for (const code of ['provider_unreachable', 'provider_timeout', 'provider_unavailable'] as const)
    expect(of({ ok: false, code })).toBe('unreachable');
  expect(of({ ok: false, code: 'provider_unauthorized' })).toBe('unauthorized');
  for (const code of ['provider_rejected', 'invalid_response', 'internal_error', 'provider_not_configured'] as const)
    expect(of({ ok: false, code })).toBe('error');
  expect(PROVIDER_STATE_LABELS).toEqual({
    checking: 'checking',
    ready: 'ready',
    unreachable: 'not reachable',
    unauthorized: 'key refused',
    no_vision_model: 'no vision model',
    error: 'error',
  });
});

it('exclude leaves an entry out of the options', async () => {
  installFakeApi(fakeProviders({ providers: [LOCAL, RUNPOD] }).handlers);
  render(
    <ProviderSettingsProvider>
      <ProviderSelect value={RUNPOD.id} exclude={LOCAL.id} onChange={() => {}} />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['RunPod — ready']));
});

it('without a value the select shows No provider', async () => {
  installFakeApi(fakeProviders({ providers: [] }).handlers);
  renderHarness(null);
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['No provider']));
});

it('noteUsed makes the entry the default', async () => {
  installFakeApi(fakeProviders({ providers: [LOCAL, RUNPOD] }).handlers);
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(state!.list).not.toBeNull());
  expect(defaultProviderId(state!)).toBe(LOCAL.id);
  act(() => state!.noteUsed(RUNPOD.id));
  expect(defaultProviderId(state!)).toBe(RUNPOD.id);
});

// --- defaults ---

const listOf = (p: Partial<ProviderList>): Pick<ProvidersState, 'list'> => ({
  list: { providers: [LOCAL, RUNPOD], lastUsedId: null, fromEnvironment: false, canStoreKey: true, ...p },
});

it('defaultProviderId takes the entry used last', () => {
  expect(defaultProviderId(listOf({ lastUsedId: RUNPOD.id }))).toBe(RUNPOD.id);
});

it('defaultProviderId takes the first when lastUsedId names no entry', () => {
  expect(defaultProviderId(listOf({ lastUsedId: '00000000-0000-4000-8000-00000000dead' }))).toBe(LOCAL.id);
  expect(defaultProviderId(listOf({ lastUsedId: null }))).toBe(LOCAL.id);
});

it('defaultProviderId is null for an empty or missing list', () => {
  expect(defaultProviderId(listOf({ providers: [] }))).toBeNull();
  expect(defaultProviderId({ list: null })).toBeNull();
});

it('defaultModelOf takes the stored model of the entry for the purpose', () => {
  const s = listOf({});
  expect(defaultModelOf(s, LOCAL.id, 'tagging')).toBe('vision-a');
  expect(defaultModelOf(s, LOCAL.id, 'prompt')).toBe('vision-b');
  expect(defaultModelOf(s, RUNPOD.id, 'prompt')).toBeNull();
  expect(defaultModelOf(s, null, 'tagging')).toBeNull();
  expect(defaultModelOf(s, '00000000-0000-4000-8000-00000000dead', 'tagging')).toBeNull();
});
