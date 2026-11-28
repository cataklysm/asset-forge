import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ImageModel, ListImageModelsResult, ListModelsResult, ProviderList } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { ModelSelect } from '../../src/renderer/src/components/ModelSelect';
import { ProviderSelect } from '../../src/renderer/src/components/ProviderSelect';
import { PROVIDER_STATE_LABELS } from '../../src/renderer/src/labels';
import { useImageProviderChoice, useProviderChoice } from '../../src/renderer/src/provider-choice';
import {
  defaultEditModelOf,
  defaultModelOf,
  defaultProviderId,
  providerStatus,
  ProviderSettingsProvider,
  useProviders,
  type ProvidersState,
} from '../../src/renderer/src/provider-context';
import { deferred, fakeError, fakeProviders, installFakeApi, providerView } from './fake-api';

const LOCAL = providerView({ name: 'Local', taggingModel: 'vision-a', promptModel: 'vision-b' });
const RUNPOD = providerView({
  name: 'RunPod',
  baseUrl: 'https://pod.example.test',
  taggingModel: 'big-vision',
  promptModel: null,
});

const READY: ListModelsResult = { ok: true, models: [{ name: 'big-vision', vision: true }] };
const UNREACHABLE: ListModelsResult = { ok: false, code: 'provider_unreachable' };

const providerSelect = () => screen.getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement;
const optionTexts = (el: HTMLSelectElement) =>
  within(el)
    .getAllByRole('option')
    .map((o) => o.textContent);
const modelCalls = (api: ReturnType<typeof installFakeApi>) =>
  api.calls.filter((c) => c.channel === 'providers:listModels');

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

it('a failed reload keeps the list already held and does not count as failed', async () => {
  const api = installFakeApi(fakeProviders({ providers: [LOCAL, RUNPOD] }).handlers);
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(state?.list?.providers).toHaveLength(2));
  api.set('providers:list', () => {
    throw fakeError('internal_error', 'internal_error');
  });
  let rejected = false;
  await act(async () => {
    await state!.reload().catch(() => {
      rejected = true;
    });
  });
  expect(rejected).toBe(true);
  expect(state!.list?.providers.map((p) => p.name)).toEqual(['Local', 'RunPod']);
  expect(state!.failed).toBe(false);
  expect(state!.loading).toBe(false);
});

it('a reload drops the model answers of entries that are no longer listed', async () => {
  const fake = fakeProviders({ providers: [LOCAL, RUNPOD] });
  installFakeApi(fake.handlers);
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(Object.keys(state!.models).sort()).toEqual([LOCAL.id, RUNPOD.id].sort()));
  // Deleted elsewhere: the next list no longer holds RunPod.
  fake.state.providers = [LOCAL];
  await act(async () => {
    await state!.reload();
  });
  expect(Object.keys(state!.models)).toEqual([LOCAL.id]);
});

it('a reload whose list predates a save does not drop the saved entry or its models', async () => {
  const fake = fakeProviders({ providers: [LOCAL] });
  const api = installFakeApi(fake.handlers);
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(state!.models[LOCAL.id]).toBeDefined());
  const stale = deferred<ProviderList>();
  api.set('providers:list', () => stale.promise);
  let reloading: Promise<void> = Promise.resolve();
  act(() => {
    reloading = state!.reload();
  });
  // The reload's answer is read before the save: it does not hold the new entry.
  const before = structuredClone(fake.state);
  api.set('providers:list', fake.handlers['providers:list']);
  let saved: { id: string } | null = null;
  await act(async () => {
    saved = await state!.save({
      name: 'RunPod',
      baseUrl: 'https://pod.example.test',
      timeoutSeconds: 120,
      taggingModel: 'big-vision',
      promptModel: null,
    });
  });
  await act(async () => {
    stale.resolve(before);
    await reloading;
  });
  await waitFor(() => expect(state!.list?.providers.map((p) => p.name)).toEqual(['Local', 'RunPod']));
  await waitFor(() => expect(state!.models[saved!.id]).toBeDefined());
  expect(state!.loading).toBe(false);
});

it('a failed first load holds no list and counts as failed', async () => {
  installFakeApi({
    ...fakeProviders().handlers,
    'providers:list': () => {
      throw fakeError('internal_error', 'internal_error');
    },
  });
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(state?.failed).toBe(true));
  expect(state!.list).toBeNull();
  expect(state!.loading).toBe(false);
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
  const refreshed = modelCalls(api)
    .slice(before)
    .map((c) => c.request);
  expect(refreshed).toHaveLength(2);
  expect(refreshed).toEqual(
    expect.arrayContaining([
      { providerId: LOCAL.id, refresh: true },
      { providerId: RUNPOD.id, refresh: true },
    ]),
  );
});

it('a re-check keeps the last answer until the new one comes', async () => {
  const user = userEvent.setup();
  const slow = deferred<ListModelsResult>();
  let calls = 0;
  const fake = fakeProviders(
    { providers: [LOCAL] },
    {
      [LOCAL.id]: () => {
        calls += 1;
        return calls === 1 ? READY : slow.promise;
      },
    },
  );
  installFakeApi(fake.handlers);
  renderHarness();
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['Local — ready']));
  await user.click(providerSelect());
  expect(calls).toBe(2);
  expect(optionTexts(providerSelect())).toEqual(['Local — ready']);
  await act(async () => slow.resolve(UNREACHABLE));
  expect(optionTexts(providerSelect())).toEqual(['Local — not reachable']);
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
  const fake = fakeProviders(
    { providers: [LOCAL] },
    {
      [LOCAL.id]: () => {
        throw fakeError('not_found', 'This provider does not exist');
      },
    },
  );
  installFakeApi(fake.handlers);
  renderHarness();
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['Local — error']));
});

it('maps every answer to its state', () => {
  const of = (answer: ListModelsResult | undefined) =>
    providerStatus({ list: null, models: { x: answer }, imageModels: {} }, 'x');
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
    no_edit_model: 'no edit model',
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
  list: {
    providers: [LOCAL, RUNPOD],
    lastUsedId: null,
    lastUsedImageId: null,
    fromEnvironment: false,
    canStoreKey: true,
    ...p,
  },
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

// --- provider kinds ---

const VENICE = providerView({
  kind: 'venice',
  name: 'Venice',
  baseUrl: 'https://api.venice.ai/api/v1',
  taggingModel: null,
  promptModel: null,
  editModel: 'edit-b',
});
const VENICE_2 = providerView({
  kind: 'venice',
  name: 'Venice 2',
  baseUrl: 'https://api.venice.ai/api/v1',
  taggingModel: null,
  promptModel: null,
  editModel: null,
});

const imageModel = (name: string): ImageModel => ({
  name,
  aspectRatios: null,
  resolutions: null,
  defaultResolution: null,
  promptCharacterLimit: null,
  price: null,
});
const EDIT_MODELS: ListImageModelsResult = { ok: true, models: [imageModel('edit-a'), imageModel('edit-b')] };
const imageCalls = (api: ReturnType<typeof installFakeApi>) =>
  api.calls.filter((c) => c.channel === 'providers:listImageModels');

it('image entries are asked through providers:listImageModels, vision entries through providers:listModels', async () => {
  const api = installFakeApi(fakeProviders({ providers: [LOCAL, VENICE] }).handlers);
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(state!.imageModels[VENICE.id]).toEqual({ ok: true, models: [] }));
  expect(modelCalls(api).map((c) => c.request)).toEqual([{ providerId: LOCAL.id }]);
  expect(imageCalls(api).map((c) => c.request)).toEqual([{ providerId: VENICE.id }]);
  expect(state!.models[VENICE.id]).toBeUndefined();
  act(() => state!.checkAll());
  expect(
    imageCalls(api)
      .slice(1)
      .map((c) => c.request),
  ).toEqual([{ providerId: VENICE.id, refresh: true }]);
  await waitFor(() => expect(state!.imageModels[VENICE.id]).toEqual({ ok: true, models: [] }));
});

it('the select of the analysis dialogs lists no Venice entry; purpose image lists only those', async () => {
  installFakeApi(fakeProviders({ providers: [VENICE, LOCAL, VENICE_2] }).handlers);
  render(
    <ProviderSettingsProvider>
      <ProviderSelect value={LOCAL.id} onChange={() => {}} />
      <ProviderSelect purpose="image" value={VENICE.id} onChange={() => {}} />
    </ProviderSettingsProvider>,
  );
  const [analysis, image] = screen.getAllByRole('combobox', { name: 'Provider' }) as HTMLSelectElement[];
  await waitFor(() => expect(optionTexts(analysis!)).toEqual(['Local — ready']));
  await waitFor(() => expect(optionTexts(image!)).toEqual(['Venice — no edit model', 'Venice 2 — no edit model']));
});

it('a Venice entry with an empty edit model list shows no edit model', async () => {
  installFakeApi(fakeProviders({ providers: [VENICE] }).handlers);
  render(
    <ProviderSettingsProvider>
      <ProviderSelect purpose="image" value={VENICE.id} onChange={() => {}} />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['Venice — no edit model']));
});

it('maps every image list answer to its state', () => {
  const list: ProviderList = {
    providers: [VENICE],
    lastUsedId: null,
    lastUsedImageId: null,
    fromEnvironment: false,
    canStoreKey: true,
  };
  const of = (answer: ListImageModelsResult | 'checking' | undefined) =>
    providerStatus({ list, models: {}, imageModels: answer === undefined ? {} : { [VENICE.id]: answer } }, VENICE.id);
  expect(of(undefined)).toBe('checking');
  expect(of('checking')).toBe('checking');
  expect(of(EDIT_MODELS)).toBe('ready');
  expect(of({ ok: true, models: [] })).toBe('no_edit_model');
  for (const code of ['provider_unreachable', 'provider_timeout', 'provider_unavailable'] as const)
    expect(of({ ok: false, code })).toBe('unreachable');
  expect(of({ ok: false, code: 'provider_unauthorized' })).toBe('unauthorized');
  expect(of({ ok: false, code: 'provider_insufficient_balance' })).toBe('error');
  // A vision answer under the same id does not count for an image entry.
  expect(providerStatus({ list, models: { [VENICE.id]: READY }, imageModels: {} }, VENICE.id)).toBe('checking');
});

it('an older image list answer for the same entry is dropped, and one for a deleted entry too', async () => {
  const first = deferred<ListImageModelsResult>();
  const late = deferred<ListImageModelsResult>();
  let calls = 0;
  const fake = fakeProviders({ providers: [VENICE, VENICE_2] });
  installFakeApi({
    ...fake.handlers,
    'providers:listImageModels': ({ providerId }) => {
      if (providerId === VENICE_2.id) return late.promise;
      calls += 1;
      return calls === 1 ? first.promise : EDIT_MODELS;
    },
  });
  render(
    <ProviderSettingsProvider>
      <Probe />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(calls).toBe(1));
  expect(state!.imageModels[VENICE.id]).toBe('checking');
  await act(async () => {
    await state!.loadModels(VENICE.id, true);
  });
  expect(state!.imageModels[VENICE.id]).toEqual(EDIT_MODELS);
  await act(async () => first.resolve({ ok: false, code: 'provider_unreachable' }));
  expect(state!.imageModels[VENICE.id]).toEqual(EDIT_MODELS);
  await act(async () => {
    await state!.remove(VENICE_2.id);
  });
  await act(async () => late.resolve(EDIT_MODELS));
  expect(VENICE_2.id in state!.imageModels).toBe(false);
});

function ChoiceProbe({ purpose, opening }: { purpose: 'vision' | 'image'; opening: string | null }) {
  const image = useImageProviderChoice(purpose === 'image' ? opening : null);
  const analysis = useProviderChoice('tagging', purpose === 'vision' ? opening : null);
  const choice = purpose === 'image' ? image : analysis;
  return (
    <>
      <ProviderSelect purpose={purpose} value={choice.providerId} onChange={choice.setProvider} />
      <p>{`choice:${choice.providerId ?? 'none'}:${choice.model ?? 'none'}`}</p>
    </>
  );
}

it('the analysis choice offers only vision entries, even when an image entry is first', async () => {
  installFakeApi(fakeProviders({ providers: [VENICE, LOCAL, RUNPOD], lastUsedImageId: VENICE.id }).handlers);
  render(
    <ProviderSettingsProvider>
      <ChoiceProbe purpose="vision" opening="open" />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(screen.getByText(`choice:${LOCAL.id}:vision-a`)).toBeTruthy());
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['Local — ready', 'RunPod — ready']));
});

it('the image choice preselects the image entry used last with its edit model when listed, else the first model', async () => {
  const user = userEvent.setup();
  const fake = fakeProviders({
    providers: [LOCAL, VENICE, VENICE_2],
    lastUsedId: LOCAL.id,
    lastUsedImageId: VENICE.id,
  });
  installFakeApi({ ...fake.handlers, 'providers:listImageModels': () => EDIT_MODELS });
  render(
    <ProviderSettingsProvider>
      <ChoiceProbe purpose="image" opening="open" />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(screen.getByText(`choice:${VENICE.id}:edit-b`)).toBeTruthy());
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['Venice — ready', 'Venice 2 — ready']));
  await user.selectOptions(providerSelect(), VENICE_2.id);
  // Venice 2 has no stored edit model: the first listed one is in force.
  expect(screen.getByText(`choice:${VENICE_2.id}:edit-a`)).toBeTruthy();
});

it('a late image list answer for a deselected entry is ignored', async () => {
  const user = userEvent.setup();
  const slow = deferred<ListImageModelsResult>();
  const fake = fakeProviders({ providers: [VENICE, VENICE_2], lastUsedImageId: VENICE.id });
  let askedVenice = 0;
  installFakeApi({
    ...fake.handlers,
    'providers:listImageModels': ({ providerId }) => {
      if (providerId === VENICE_2.id) return { ok: true, models: [imageModel('edit-c')] };
      askedVenice += 1;
      // The first ask answers; the check of the opening hangs until released.
      return askedVenice === 1 ? EDIT_MODELS : slow.promise;
    },
  });
  render(
    <ProviderSettingsProvider>
      <ChoiceProbe purpose="image" opening="open" />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(askedVenice).toBe(2));
  // The re-check of the opening keeps the last answer while it runs.
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['Venice — ready', 'Venice 2 — ready']));
  expect(screen.getByText(`choice:${VENICE.id}:edit-b`)).toBeTruthy();
  await user.selectOptions(providerSelect(), VENICE_2.id);
  expect(screen.getByText(`choice:${VENICE_2.id}:edit-c`)).toBeTruthy();
  await act(async () => slow.resolve({ ok: true, models: [imageModel('edit-z')] }));
  expect(optionTexts(providerSelect())).toEqual(['Venice — ready', 'Venice 2 — ready']);
  expect(providerSelect().value).toBe(VENICE_2.id);
  expect(screen.getByText(`choice:${VENICE_2.id}:edit-c`)).toBeTruthy();
});

it('defaultProviderId and defaultEditModelOf follow the kind', () => {
  const s: Pick<ProvidersState, 'list' | 'imageModels'> = {
    list: {
      providers: [VENICE, LOCAL, VENICE_2, RUNPOD],
      lastUsedId: RUNPOD.id,
      lastUsedImageId: VENICE_2.id,
      fromEnvironment: false,
      canStoreKey: true,
    },
    imageModels: { [VENICE.id]: EDIT_MODELS, [VENICE_2.id]: { ok: true, models: [] } },
  };
  expect(defaultProviderId(s)).toBe(RUNPOD.id);
  expect(defaultProviderId(s, 'image')).toBe(VENICE_2.id);
  // An image entry named as the vision one used last does not count, and the other way round.
  const crossed = { list: { ...s.list!, lastUsedId: VENICE.id, lastUsedImageId: LOCAL.id } };
  expect(defaultProviderId(crossed)).toBe(LOCAL.id);
  expect(defaultProviderId(crossed, 'image')).toBe(VENICE.id);
  expect(defaultProviderId({ list: { ...s.list!, providers: [LOCAL] } }, 'image')).toBeNull();

  expect(defaultEditModelOf(s, VENICE.id)).toBe('edit-b');
  expect(
    defaultEditModelOf({ ...s, imageModels: { [VENICE.id]: { ok: true, models: [imageModel('edit-z')] } } }, VENICE.id),
  ).toBe('edit-z');
  expect(defaultEditModelOf(s, VENICE_2.id)).toBeNull();
  // Before or without a usable list the stored model stands.
  expect(defaultEditModelOf({ ...s, imageModels: {} }, VENICE.id)).toBe('edit-b');
  expect(defaultEditModelOf({ ...s, imageModels: { [VENICE.id]: 'checking' } }, VENICE.id)).toBe('edit-b');
  expect(
    defaultEditModelOf({ ...s, imageModels: { [VENICE.id]: { ok: false, code: 'provider_unreachable' } } }, VENICE.id),
  ).toBe('edit-b');
  expect(defaultEditModelOf(s, null)).toBeNull();
  expect(defaultEditModelOf(s, LOCAL.id)).toBeNull();
});

// --- OpenAI-compatible entries ---

const VLLM = providerView({
  kind: 'openai',
  name: 'vLLM',
  baseUrl: 'http://127.0.0.1:11500/v1',
  taggingModel: 'qwen-vl',
  promptModel: null,
});
const UNKNOWN_VISION: ListModelsResult = { ok: true, models: [{ name: 'qwen-vl', vision: null }] };

it('the analysis select lists the ollama and the openai entry and no venice one', async () => {
  installFakeApi(fakeProviders({ providers: [LOCAL, VENICE, VLLM] }, { [VLLM.id]: UNKNOWN_VISION }).handlers);
  renderHarness();
  await waitFor(() => expect(optionTexts(providerSelect())).toEqual(['Local — ready', 'vLLM — ready']));
});

it('the analysis choice preselects the openai entry used last with its default model', async () => {
  installFakeApi(
    fakeProviders({ providers: [LOCAL, VLLM], lastUsedId: VLLM.id }, { [VLLM.id]: UNKNOWN_VISION }).handlers,
  );
  render(
    <ProviderSettingsProvider>
      <ChoiceProbe purpose="vision" opening="open" />
    </ProviderSettingsProvider>,
  );
  await waitFor(() => expect(screen.getByText(`choice:${VLLM.id}:qwen-vl`)).toBeTruthy());
  expect(providerSelect().value).toBe(VLLM.id);
});

it('defaultProviderId takes an openai entry used last for the vision purpose', () => {
  const s = listOf({ providers: [VENICE, LOCAL, VLLM], lastUsedId: VLLM.id });
  expect(defaultProviderId(s)).toBe(VLLM.id);
  expect(defaultProviderId(s, 'vision')).toBe(VLLM.id);
  expect(defaultProviderId(listOf({ providers: [VENICE, VLLM], lastUsedId: null }))).toBe(VLLM.id);
});
