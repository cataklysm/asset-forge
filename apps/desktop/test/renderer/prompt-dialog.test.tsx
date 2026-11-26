import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  JOB_ERROR_MESSAGES,
  type DescribeResult,
  type FileRecord,
  type IpcRequest,
  type ListModelsResult,
  type VisionSettingsView,
} from '@assetforge/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { PromptDialog, PROMPT_BUSY_MESSAGE } from '../../src/renderer/src/components/PromptDialog';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { BUTTON, BUTTON_INLINE, ICON_BUTTON } from '../../src/renderer/src/ui';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { fileRecord } from './fixtures';

const CONFIGURED: VisionSettingsView = {
  baseUrl: 'http://127.0.0.1:11500',
  timeoutSeconds: 120,
  taggingModel: 'vision-b',
  promptModel: 'vision-a',
  hasApiKey: false,
  fromEnvironment: false,
  canStoreKey: true,
};

const UNCONFIGURED: VisionSettingsView = { ...CONFIGURED, baseUrl: null, taggingModel: null, promptModel: null };

const MODELS: ListModelsResult = {
  ok: true,
  models: [
    { name: 'vision-a', vision: true },
    { name: 'vision-b', vision: true },
    { name: 'text-only', vision: false },
  ],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEXT = 'A weathered bronze statue of a fox under soft morning light, three-quarter view, photographic.';

type DescribeRequest = IpcRequest<'analysis:describe'>;

function install(
  view: VisionSettingsView = CONFIGURED,
  models: ListModelsResult = MODELS,
  handlers: FakeHandlers = {},
) {
  return installFakeApi({
    'settings:getVision': () => view,
    'settings:listVisionModels': () => models,
    'analysis:describe': () => ({ ok: true, text: TEXT }),
    'analysis:cancelDescribe': () => ({}),
    ...handlers,
  });
}

const callsOf = (api: ReturnType<typeof installFakeApi>, channel: string) =>
  api.calls.filter((c) => c.channel === channel).map((c) => c.request);

interface Harness {
  open?: boolean;
  file?: FileRecord | null;
  onClose?: () => void;
  onOpenSettings?: () => void;
}

function ui({ open = true, file = FILE, onClose = () => {}, onOpenSettings = () => {} }: Harness) {
  return (
    <ProviderSettingsProvider>
      <PromptDialog open={open} file={file} onClose={onClose} onOpenSettings={onOpenSettings} />
    </ProviderSettingsProvider>
  );
}

const FILE = fileRecord({ originalName: 'fox.png' });

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const modelSelect = () => screen.getByRole('combobox', { name: 'Prompt model' }) as HTMLSelectElement;
const promptField = () => screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;

async function ready() {
  await waitFor(() => expect(modelSelect().value).toBe('vision-a'));
  await waitFor(() => expect(within(modelSelect()).getAllByRole('option').map((o) => o.textContent)).toContain('vision-b'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('opens with the prompt default selected', async () => {
  install();
  render(ui({}));
  await ready();
  expect(modelSelect().value).toBe('vision-a');
  expect(promptField().value).toBe('');
  expect(promptField().readOnly).toBe(true);
});

it('Generate sends analysis:describe with a fresh request id, the file and the chosen model', async () => {
  const user = userEvent.setup();
  const api = install();
  render(ui({}));
  await ready();
  await user.selectOptions(modelSelect(), 'vision-b');
  await user.click(button('Generate'));
  await waitFor(() => expect(promptField().value).toBe(TEXT));
  await user.click(button('Generate'));
  await waitFor(() => expect(callsOf(api, 'analysis:describe')).toHaveLength(2));
  const [first, second] = callsOf(api, 'analysis:describe') as DescribeRequest[];
  expect(first).toEqual({ requestId: expect.stringMatching(UUID), fileId: FILE.id, model: 'vision-b' });
  expect(second!.requestId).toMatch(UUID);
  expect(second!.requestId).not.toBe(first!.requestId);
});

it('while running Generate is disabled and Cancel sends analysis:cancelDescribe; the late answer is dropped', async () => {
  const user = userEvent.setup();
  const pending = deferred<DescribeResult>();
  const api = install(CONFIGURED, MODELS, { 'analysis:describe': () => pending.promise });
  render(ui({}));
  await ready();
  await user.click(button('Generate'));
  expect(button('Generate').disabled).toBe(true);
  await user.click(button('Cancel'));
  const [request] = callsOf(api, 'analysis:describe') as DescribeRequest[];
  expect(callsOf(api, 'analysis:cancelDescribe')).toEqual([{ requestId: request!.requestId }]);
  await act(async () => pending.resolve({ ok: true, text: TEXT }));
  expect(promptField().value).toBe('');
  expect(button('Generate').disabled).toBe(false);
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
});

it('shows the text in a read-only field and Copy writes exactly the text', async () => {
  const user = userEvent.setup();
  install();
  render(ui({}));
  await ready();
  expect(button('Copy').disabled).toBe(true);
  await user.click(button('Generate'));
  await waitFor(() => expect(promptField().value).toBe(TEXT));
  const write = vi.spyOn(navigator.clipboard, 'writeText');
  await user.click(button('Copy'));
  expect(write).toHaveBeenCalledWith(TEXT);
  expect(await navigator.clipboard.readText()).toBe(TEXT);
});

it('a failed answer shows the fixed message of its code', async () => {
  const user = userEvent.setup();
  install(CONFIGURED, MODELS, { 'analysis:describe': () => ({ ok: false, code: 'provider_unauthorized' }) });
  render(ui({}));
  await ready();
  await user.click(button('Generate'));
  expect((await screen.findByRole('alert')).textContent).toBe(JOB_ERROR_MESSAGES.provider_unauthorized);
  expect(promptField().value).toBe('');
});

it('busy shows its fixed message', async () => {
  const user = userEvent.setup();
  install(CONFIGURED, MODELS, { 'analysis:describe': () => ({ ok: false, code: 'busy' }) });
  render(ui({}));
  await ready();
  await user.click(button('Generate'));
  expect((await screen.findByRole('alert')).textContent).toBe(PROMPT_BUSY_MESSAGE);
});

it('cancelled shows nothing', async () => {
  const user = userEvent.setup();
  const api = install(CONFIGURED, MODELS, { 'analysis:describe': () => ({ ok: false, code: 'cancelled' }) });
  render(ui({}));
  await ready();
  await user.click(button('Generate'));
  await waitFor(() => expect(button('Generate').disabled).toBe(false));
  expect(callsOf(api, 'analysis:describe')).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(promptField().value).toBe('');
});

it('a rejected call shows the error and re-enables Generate', async () => {
  const user = userEvent.setup();
  install(CONFIGURED, MODELS, {
    'analysis:describe': () => {
      throw fakeError('no_workspace_open');
    },
  });
  render(ui({}));
  await ready();
  await user.click(button('Generate'));
  expect((await screen.findByRole('alert')).textContent).toBe('no_workspace_open');
  expect(button('Generate').disabled).toBe(false);
});

it('Close calls onClose; closing while running cancels and reopening shows no old text', async () => {
  const user = userEvent.setup();
  const pending = deferred<DescribeResult>();
  let describe: FakeHandlers['analysis:describe'] = () => ({ ok: true, text: TEXT });
  const api = install(CONFIGURED, MODELS, { 'analysis:describe': (r) => describe!(r) });
  const onClose = vi.fn();
  const { rerender } = render(ui({ onClose }));
  await ready();
  await user.click(button('Generate'));
  await waitFor(() => expect(promptField().value).toBe(TEXT));

  describe = () => pending.promise;
  await user.click(button('Generate'));
  await user.click(button('Close'));
  expect(onClose).toHaveBeenCalledTimes(1);
  rerender(ui({ open: false, onClose }));
  const requests = callsOf(api, 'analysis:describe') as DescribeRequest[];
  expect(callsOf(api, 'analysis:cancelDescribe')).toEqual([{ requestId: requests[1]!.requestId }]);

  rerender(ui({ open: true, onClose }));
  await act(async () => pending.resolve({ ok: true, text: 'late' }));
  await ready();
  expect(promptField().value).toBe('');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('Esc while running cancels the request', async () => {
  const user = userEvent.setup();
  const pending = deferred<DescribeResult>();
  const api = install(CONFIGURED, MODELS, { 'analysis:describe': () => pending.promise });
  const onClose = vi.fn();
  const { rerender } = render(ui({ onClose }));
  await ready();
  await user.click(button('Generate'));
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
  rerender(ui({ open: false, onClose }));
  expect(callsOf(api, 'analysis:cancelDescribe')).toHaveLength(1);
});

it('another file while running cancels the request and drops its answer', async () => {
  const user = userEvent.setup();
  const pending = deferred<DescribeResult>();
  const api = install(CONFIGURED, MODELS, { 'analysis:describe': () => pending.promise });
  const { rerender } = render(ui({}));
  await ready();
  await user.click(button('Generate'));
  const other = fileRecord({ originalName: 'other.png' });
  rerender(ui({ file: other }));
  expect(callsOf(api, 'analysis:cancelDescribe')).toHaveLength(1);
  await act(async () => pending.resolve({ ok: true, text: TEXT }));
  expect(promptField().value).toBe('');
  expect(button('Generate').disabled).toBe(false);
});

it('keeps the text out of web storage', async () => {
  const user = userEvent.setup();
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  install();
  render(ui({}));
  await ready();
  await user.click(button('Generate'));
  await waitFor(() => expect(promptField().value).toBe(TEXT));
  expect(setItem).not.toHaveBeenCalled();
  expect(JSON.stringify({ ...localStorage })).not.toContain(TEXT);
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(TEXT);
});

it('not configured: Generate is disabled with a title and Settings navigates there', async () => {
  const user = userEvent.setup();
  const api = install(UNCONFIGURED);
  const onClose = vi.fn();
  const onOpenSettings = vi.fn();
  render(ui({ onClose, onOpenSettings }));
  await waitFor(() => expect(callsOf(api, 'settings:getVision')).toHaveLength(1));
  await waitFor(() => expect(button('Generate').title).not.toBe(''));
  expect(button('Generate').disabled).toBe(true);
  await user.click(button('Settings'));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
  expect(callsOf(api, 'analysis:describe')).toHaveLength(0);
});

it('no selectable model: Generate is disabled with a title and Settings is offered', async () => {
  install({ ...CONFIGURED, promptModel: null }, { ok: true, models: [{ name: 'text-only', vision: false }] });
  render(ui({}));
  await waitFor(() =>
    expect(within(modelSelect()).getAllByRole('option').map((o) => o.textContent)).toContain('text-only'),
  );
  expect(button('Generate').disabled).toBe(true);
  expect(button('Generate').title).not.toBe('');
  expect(button('Settings')).toBeTruthy();
});

it('without a chosen model Generate is disabled with a title', async () => {
  const user = userEvent.setup();
  install();
  render(ui({}));
  await ready();
  await user.selectOptions(modelSelect(), '');
  expect(button('Generate').disabled).toBe(true);
  expect(button('Generate').title).not.toBe('');
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
});

it('uses only the shared button classes', async () => {
  install();
  render(ui({}));
  await ready();
  for (const element of screen.getAllByRole('button'))
    expect([BUTTON, BUTTON_INLINE, ICON_BUTTON]).toContain(element.className);
});
