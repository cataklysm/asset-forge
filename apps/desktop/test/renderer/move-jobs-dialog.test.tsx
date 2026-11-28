import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IpcRequest, JobSummary, ListModelsResult, WaitingByProvider } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { MoveJobsDialog } from '../../src/renderer/src/components/MoveJobsDialog';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { deferred, fakeError, fakeProviders, installFakeApi, providerView, type FakeHandlers } from './fake-api';

const IDLE: JobSummary = {
  queued: 0,
  running: 0,
  waiting: 0,
  failed: 0,
  cancelled: 0,
  succeeded: 0,
  changes: 0,
  paused: [],
  pausedHosts: [],
};

const LOCAL = providerView({ name: 'Local Ollama', taggingModel: 'vision-a' });
const RUNPOD = providerView({ name: 'RunPod', baseUrl: 'https://pod.example.test', taggingModel: 'big-vision' });
const SPARE = providerView({ name: 'Spare', baseUrl: 'https://spare.example.test', taggingModel: null });

const READY: ListModelsResult = { ok: true, models: [{ name: 'big-vision', vision: true }] };
const UNREACHABLE: ListModelsResult = { ok: false, code: 'provider_unreachable' };

const LANES: WaitingByProvider[] = [
  { providerId: LOCAL.id, providerName: 'Local Ollama', waiting: 312 },
  { providerId: null, providerName: null, waiting: 4 },
];

function install(
  handlers: FakeHandlers = {},
  models: Record<string, ListModelsResult> = { [LOCAL.id]: UNREACHABLE, [RUNPOD.id]: READY, [SPARE.id]: READY },
  lastUsedId: string | null = null,
) {
  return installFakeApi({
    ...fakeProviders({ providers: [LOCAL, RUNPOD, SPARE], lastUsedId }, models).handlers,
    'jobs:summary': () => IDLE,
    'jobs:waitingByProvider': () => LANES,
    'jobs:reroute': () => ({ moved: 312 }),
    ...handlers,
  });
}

function renderDialog(source: string | null | undefined, onClose = vi.fn()) {
  render(
    <JobsProvider>
      <ProviderSettingsProvider>
        <MoveJobsDialog source={source} onClose={onClose} />
      </ProviderSettingsProvider>
    </JobsProvider>,
  );
  return { onClose, dialog: screen.getByRole('dialog', { name: 'Move jobs' }) };
}

const targetSelect = (dialog: HTMLElement) =>
  within(dialog).getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement;
const moveButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Move' }) as HTMLButtonElement;
const reroutes = (api: ReturnType<typeof installFakeApi>) =>
  api.calls.filter((c) => c.channel === 'jobs:reroute').map((c) => c.request as IpcRequest<'jobs:reroute'>);

it('a fixed source shows its name and waiting count; the target omits it and preselects the tagging default', async () => {
  install();
  const { dialog } = renderDialog(LOCAL.id);
  expect(await within(dialog).findByText('312 waiting')).toBeTruthy();
  expect(within(dialog).getByText('Local Ollama')).toBeTruthy();
  expect(within(dialog).queryByRole('combobox', { name: 'From' })).toBeNull();
  await waitFor(() => expect(targetSelect(dialog).value).toBe(RUNPOD.id));
  const options = within(targetSelect(dialog))
    .getAllByRole('option')
    .map((o) => o.textContent);
  expect(options.some((o) => o?.startsWith('Local Ollama'))).toBe(false);
  expect(options).toEqual(['RunPod — ready', 'Spare — ready']);
  expect((within(dialog).getByRole('combobox', { name: 'Tagging model' }) as HTMLSelectElement).value).toBe(
    'big-vision',
  );
  await waitFor(() => expect(moveButton(dialog).disabled).toBe(false));
});

it('Move is disabled with the state label for a target that is not reachable', async () => {
  const user = userEvent.setup();
  install({}, { [LOCAL.id]: UNREACHABLE, [RUNPOD.id]: UNREACHABLE, [SPARE.id]: READY });
  const { dialog } = renderDialog(LOCAL.id);
  await within(dialog).findByText('312 waiting');
  await waitFor(() => expect(targetSelect(dialog).value).toBe(RUNPOD.id));
  await waitFor(() => expect(moveButton(dialog).title).toBe('not reachable'));
  expect(moveButton(dialog).disabled).toBe(true);
  await user.selectOptions(targetSelect(dialog), SPARE.id);
  // Spare has no tagging default: no model is chosen.
  await waitFor(() => expect(moveButton(dialog).title).toBe('Choose a model'));
  expect(moveButton(dialog).disabled).toBe(true);
  await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Tagging model' }), 'big-vision');
  await waitFor(() => expect(moveButton(dialog).disabled).toBe(false));
});

it('Move sends the source, target and model once on a double click, then closes and polls the summary', async () => {
  const user = userEvent.setup();
  const pending = deferred<{ moved: number }>();
  const api = install({ 'jobs:reroute': () => pending.promise });
  const { dialog, onClose } = renderDialog(LOCAL.id);
  await waitFor(() => expect(moveButton(dialog).disabled).toBe(false));
  await user.dblClick(moveButton(dialog));
  expect(moveButton(dialog).disabled).toBe(true);
  expect(reroutes(api)).toEqual([{ fromProviderId: LOCAL.id, toProviderId: RUNPOD.id, model: 'big-vision' }]);
  const summaries = api.calls.filter((c) => c.channel === 'jobs:summary').length;
  await act(async () => pending.resolve({ moved: 312 }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(api.calls.filter((c) => c.channel === 'jobs:summary').length).toBeGreaterThan(summaries);
});

it('a source with id null is sent as null and shows No provider', async () => {
  const user = userEvent.setup();
  const api = install({}, undefined, RUNPOD.id);
  const { dialog } = renderDialog(null);
  expect(await within(dialog).findByText('4 waiting')).toBeTruthy();
  expect(within(dialog).getByText('No provider')).toBeTruthy();
  await waitFor(() => expect(targetSelect(dialog).value).toBe(RUNPOD.id));
  await waitFor(() => expect(moveButton(dialog).disabled).toBe(false));
  await user.click(moveButton(dialog));
  await waitFor(() => expect(reroutes(api)).toHaveLength(1));
  expect(reroutes(api)[0]!.fromProviderId).toBeNull();
});

it('a refusal stays visible in the dialog, which stays open', async () => {
  const user = userEvent.setup();
  install({
    'jobs:reroute': () => {
      throw fakeError('invalid_operation', 'Jobs cannot be moved onto the same provider');
    },
  });
  const { dialog, onClose } = renderDialog(LOCAL.id);
  await waitFor(() => expect(moveButton(dialog).disabled).toBe(false));
  await user.click(moveButton(dialog));
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Jobs cannot be moved onto the same provider');
  expect(onClose).not.toHaveBeenCalled();
  expect(moveButton(dialog).disabled).toBe(false);
});

it('a count of 0 disables Move', async () => {
  install({ 'jobs:waitingByProvider': () => [{ providerId: LOCAL.id, providerName: 'Local Ollama', waiting: 0 }] });
  const { dialog } = renderDialog(LOCAL.id);
  expect(await within(dialog).findByText('0 waiting')).toBeTruthy();
  await waitFor(() => expect(targetSelect(dialog).value).toBe(RUNPOD.id));
  await waitFor(() => expect(moveButton(dialog).title).toBe('No waiting jobs'));
  expect(moveButton(dialog).disabled).toBe(true);
});

it('a fixed source missing from the lanes counts 0 and is named Removed provider when unknown', async () => {
  install({ 'jobs:waitingByProvider': () => [] });
  const { dialog } = renderDialog('00000000-0000-4000-8000-00000000dead');
  expect(await within(dialog).findByText('0 waiting')).toBeTruthy();
  expect(within(dialog).getByText('Removed provider')).toBeTruthy();
});

it('a fixed source that is not listed shows no name until the lanes give the stored one', async () => {
  const dead = '00000000-0000-4000-8000-00000000dead';
  const lanes = deferred<WaitingByProvider[]>();
  install({ 'jobs:waitingByProvider': () => lanes.promise });
  const { dialog } = renderDialog(dead);
  await waitFor(() => expect(targetSelect(dialog).value).toBe(LOCAL.id));
  expect(within(dialog).queryByText('Removed provider')).toBeNull();
  await act(async () => lanes.resolve([{ providerId: dead, providerName: 'Old box', waiting: 3 }]));
  expect(within(dialog).getByText('Old box')).toBeTruthy();
  expect(within(dialog).queryByText('Removed provider')).toBeNull();
});

it('a refusal goes when another source is chosen', async () => {
  const user = userEvent.setup();
  install({
    'jobs:reroute': () => {
      throw fakeError('invalid_operation', 'Jobs cannot be moved onto the same provider');
    },
  });
  const { dialog } = renderDialog(undefined);
  await waitFor(() => expect(moveButton(dialog).disabled).toBe(false));
  await user.click(moveButton(dialog));
  await within(dialog).findByRole('alert');
  await user.selectOptions(within(dialog).getByRole('combobox', { name: 'From' }), 'No provider');
  expect(within(dialog).queryByRole('alert')).toBeNull();
});

it('a failed lane lookup gives the disabled Move its message as tooltip', async () => {
  install({
    'jobs:waitingByProvider': () => {
      throw fakeError('internal_error', 'internal_error');
    },
  });
  const { dialog } = renderDialog(LOCAL.id);
  const alert = await within(dialog).findByRole('alert');
  await waitFor(() => expect(targetSelect(dialog).value).toBe(RUNPOD.id));
  await waitFor(() => expect(moveButton(dialog).title).toBe(alert.textContent));
  expect(moveButton(dialog).title).not.toBe('');
  expect(moveButton(dialog).disabled).toBe(true);
});

it('without a source the From select lists the lanes and switches the count and the target', async () => {
  const user = userEvent.setup();
  const api = install();
  const { dialog } = renderDialog(undefined);
  const from = (await within(dialog).findByRole('combobox', { name: 'From' })) as HTMLSelectElement;
  await waitFor(() =>
    expect(
      within(from)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Local Ollama', 'No provider']),
  );
  expect(within(dialog).getByText('312 waiting')).toBeTruthy();
  await user.selectOptions(from, 'No provider');
  expect(within(dialog).getByText('4 waiting')).toBeTruthy();
  // With the null lane as source every entry is a target.
  await waitFor(() => expect(within(targetSelect(dialog)).getAllByRole('option')).toHaveLength(3));
  await user.selectOptions(targetSelect(dialog), RUNPOD.id);
  await waitFor(() => expect(moveButton(dialog).disabled).toBe(false));
  await user.click(moveButton(dialog));
  await waitFor(() =>
    expect(reroutes(api)).toEqual([{ fromProviderId: null, toProviderId: RUNPOD.id, model: 'big-vision' }]),
  );
});

it('Move jobs offers no Venice target, even when it comes first or was used last', async () => {
  const venice = providerView({
    kind: 'venice',
    name: 'Venice',
    taggingModel: null,
    promptModel: null,
    editModel: 'edit-a',
  });
  installFakeApi({
    ...fakeProviders(
      { providers: [venice, LOCAL, RUNPOD, SPARE], lastUsedId: null, lastUsedImageId: venice.id },
      { [LOCAL.id]: UNREACHABLE, [RUNPOD.id]: READY, [SPARE.id]: READY },
    ).handlers,
    'jobs:summary': () => IDLE,
    'jobs:waitingByProvider': () => LANES,
  });
  const { dialog } = renderDialog(LOCAL.id);
  await within(dialog).findByText('312 waiting');
  await waitFor(() => expect(targetSelect(dialog).value).toBe(RUNPOD.id));
  const options = within(targetSelect(dialog))
    .getAllByRole('option')
    .map((o) => o.textContent);
  expect(options).toEqual(['RunPod — ready', 'Spare — ready']);
});

it('an ollama source moves onto an OpenAI-compatible target', async () => {
  const user = userEvent.setup();
  const vllm = providerView({
    kind: 'openai',
    name: 'vLLM',
    baseUrl: 'http://127.0.0.1:11500/v1',
    taggingModel: 'qwen-vl',
  });
  const api = installFakeApi({
    ...fakeProviders(
      { providers: [LOCAL, vllm], lastUsedId: null },
      { [LOCAL.id]: UNREACHABLE, [vllm.id]: { ok: true, models: [{ name: 'qwen-vl', vision: null }] } },
    ).handlers,
    'jobs:summary': () => IDLE,
    'jobs:waitingByProvider': () => LANES,
    'jobs:reroute': () => ({ moved: 312 }),
  });
  const { dialog } = renderDialog(LOCAL.id);
  await within(dialog).findByText('312 waiting');
  await waitFor(() => expect(targetSelect(dialog).value).toBe(vllm.id));
  expect(
    within(targetSelect(dialog))
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['vLLM — ready']);
  await waitFor(() => expect(moveButton(dialog).disabled).toBe(false));
  await user.click(moveButton(dialog));
  await waitFor(() =>
    expect(reroutes(api)).toEqual([{ fromProviderId: LOCAL.id, toProviderId: vllm.id, model: 'qwen-vl' }]),
  );
});

it('an OpenAI-compatible source is offered in the From select', async () => {
  const vllm = providerView({ kind: 'openai', name: 'vLLM', baseUrl: 'http://127.0.0.1:11500/v1' });
  installFakeApi({
    ...fakeProviders({ providers: [LOCAL, vllm] }).handlers,
    'jobs:summary': () => IDLE,
    'jobs:waitingByProvider': () => [{ providerId: vllm.id, providerName: 'vLLM', waiting: 5 }],
  });
  const { dialog } = renderDialog(undefined);
  const from = (await within(dialog).findByRole('combobox', { name: 'From' })) as HTMLSelectElement;
  await waitFor(() =>
    expect(
      within(from)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['vLLM']),
  );
  await waitFor(() => expect(targetSelect(dialog).value).toBe(LOCAL.id));
});

it('Cancel closes without a request', async () => {
  const user = userEvent.setup();
  const api = install();
  const { dialog, onClose } = renderDialog(LOCAL.id);
  await within(dialog).findByText('312 waiting');
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(reroutes(api)).toHaveLength(0);
});
