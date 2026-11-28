import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  JOB_ERROR_MESSAGES,
  type DescribeResult,
  type FileRecord,
  type IpcRequest,
  type ListModelsResult,
  type ProviderView,
} from '@assetforge/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptDialog, PROMPT_BUSY_MESSAGE } from '../../src/renderer/src/components/PromptDialog';
import { AnalysisPromptsProvider } from '../../src/renderer/src/analysis-prompts-context';
import {
  MODEL_NOT_LISTED,
  PROMPTS_LOAD_FAILED,
  PROVIDER_STATE_LABELS,
  SETTINGS_LOAD_FAILED,
} from '../../src/renderer/src/labels';
import { ProviderSettingsProvider, useProviders, type ProvidersState } from '../../src/renderer/src/provider-context';
import { BUTTON, BUTTON_INLINE, ICON_BUTTON } from '../../src/renderer/src/ui';
import {
  deferred,
  fakeAnalysisPrompts,
  fakeError,
  fakeProviders,
  installFakeApi,
  providerView,
  type FakeHandlers,
} from './fake-api';
import { fileRecord, imagePrompt, nextId, taggingPrompt } from './fixtures';

const TAG_DEFAULT = taggingPrompt({ name: 'Default' });
const IMAGE_DEFAULT = imagePrompt({ name: 'Describe' });
const IMAGE_SHORT = imagePrompt({ name: 'Short' });
const PROMPTS = [TAG_DEFAULT, IMAGE_DEFAULT, IMAGE_SHORT];

/** The one entry most tests use; `null` in its place stands for no entry at all. */
const CONFIGURED: ProviderView = providerView({ name: 'Local', taggingModel: 'vision-b', promptModel: 'vision-a' });
const UNCONFIGURED = null;

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

/** The `providers:*` handlers of one entry answering `models`, or of none. */
function oneProvider(entry: ProviderView | null, models: ListModelsResult) {
  return entry === null
    ? fakeProviders().handlers
    : fakeProviders({ providers: [entry], lastUsedId: entry.id }, { [entry.id]: models }).handlers;
}

function install(
  entry: ProviderView | null = CONFIGURED,
  models: ListModelsResult = MODELS,
  handlers: FakeHandlers = {},
) {
  return installFakeApi({
    ...fakeAnalysisPrompts({ prompts: PROMPTS }).handlers,
    ...oneProvider(entry, models),
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

let probe: ProvidersState | null = null;
function Probe() {
  probe = useProviders();
  return null;
}

function ui({ open = true, file = FILE, onClose = () => {}, onOpenSettings = () => {} }: Harness) {
  return (
    <ProviderSettingsProvider>
      <AnalysisPromptsProvider>
        <Probe />
        <PromptDialog open={open} file={file} onClose={onClose} onOpenSettings={onOpenSettings} />
      </AnalysisPromptsProvider>
    </ProviderSettingsProvider>
  );
}

const FILE = fileRecord({ originalName: 'fox.png' });

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const modelSelect = () => screen.getByRole('combobox', { name: 'Prompt model' }) as HTMLSelectElement;
const promptField = () => screen.getByRole('textbox', { name: 'Generated prompt' }) as HTMLTextAreaElement;
const promptSelect = () => screen.getByRole('combobox', { name: 'Prompt' }) as HTMLSelectElement;

async function ready() {
  await waitFor(() => expect(modelSelect().value).toBe('vision-a'));
  await waitFor(() =>
    expect(
      within(modelSelect())
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toContain('vision-b'),
  );
  await waitFor(() => expect(promptSelect().value).not.toBe(''));
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

it('the prompt select and the result text carry different names', async () => {
  install();
  render(ui({}));
  await ready();
  expect(screen.getAllByLabelText('Prompt')).toEqual([promptSelect()]);
  expect(promptField()).toBeTruthy();
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
  expect(first).toEqual({
    requestId: expect.stringMatching(UUID),
    fileId: FILE.id,
    model: 'vision-b',
    providerId: CONFIGURED.id,
    promptId: IMAGE_DEFAULT.id,
  });
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

it('the focus moves to Cancel while a request runs and back to Generate when it ends', async () => {
  const user = userEvent.setup();
  const pending = deferred<DescribeResult>();
  install(CONFIGURED, MODELS, { 'analysis:describe': () => pending.promise });
  render(ui({}));
  await ready();
  await user.click(button('Generate'));
  expect(document.activeElement).toBe(button('Cancel'));
  await user.click(button('Cancel'));
  expect(document.activeElement).toBe(button('Generate'));
});

it('Cancel then Generate again: the late answer of the cancelled call does not touch the new one', async () => {
  const user = userEvent.setup();
  const first = deferred<DescribeResult>();
  const second = deferred<DescribeResult>();
  const answers = [first, second];
  install(CONFIGURED, MODELS, { 'analysis:describe': () => answers.shift()!.promise });
  render(ui({}));
  await ready();
  await user.click(button('Generate'));
  await user.click(button('Cancel'));
  await user.click(button('Generate'));
  expect(button('Generate').title).toBe('The prompt is being generated');
  await act(async () => first.resolve({ ok: true, text: 'old text' }));
  expect(promptField().value).toBe('');
  expect(button('Generate').disabled).toBe(true);
  expect(button('Cancel')).toBeTruthy();
  await act(async () => second.resolve({ ok: true, text: TEXT }));
  expect(promptField().value).toBe(TEXT);
  expect(button('Generate').disabled).toBe(false);
});

it('a copy that works clears the message of one that failed', async () => {
  const user = userEvent.setup();
  install();
  render(ui({}));
  await ready();
  await user.click(button('Generate'));
  await waitFor(() => expect(promptField().value).toBe(TEXT));
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
  await user.click(button('Copy'));
  expect((await screen.findByRole('alert')).textContent).toBe('The text could not be copied');
  write.mockResolvedValueOnce(undefined);
  await user.click(button('Copy'));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

it('a model list refused as unauthorized offers Settings', async () => {
  install(CONFIGURED, { ok: false, code: 'provider_unauthorized' });
  render(ui({}));
  expect(await screen.findByRole('button', { name: 'Settings' })).toBeTruthy();
});

it('a failed settings load is not "not configured" and offers Settings, like the analysis dialogs', async () => {
  const user = userEvent.setup();
  const onOpenSettings = vi.fn();
  install(CONFIGURED, MODELS, {
    'providers:list': () => {
      throw fakeError('internal_error');
    },
  });
  render(ui({ onOpenSettings }));
  await waitFor(() => expect(button('Generate').title).toBe(SETTINGS_LOAD_FAILED));
  expect(button('Generate').disabled).toBe(true);
  expect(button('Generate').title).not.toBe(JOB_ERROR_MESSAGES.provider_not_configured);
  await user.click(button('Settings'));
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
});

it('a stored prompt model the provider no longer lists blocks Generate', async () => {
  install({ ...CONFIGURED, promptModel: 'gone-model' });
  render(ui({}));
  await waitFor(() => expect(button('Generate').title).toBe(MODEL_NOT_LISTED));
  expect(button('Generate').disabled).toBe(true);
});

it('Settings is disabled with the given reason while the settings screen cannot be shown', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onOpenSettings = vi.fn();
  install(UNCONFIGURED);
  render(
    <ProviderSettingsProvider>
      <AnalysisPromptsProvider>
        <PromptDialog
          open
          file={FILE}
          onClose={onClose}
          onOpenSettings={onOpenSettings}
          settingsBlocked="Import in progress"
        />
      </AnalysisPromptsProvider>
    </ProviderSettingsProvider>,
  );
  const settings = await screen.findByRole('button', { name: 'Settings' });
  expect((settings as HTMLButtonElement).disabled).toBe(true);
  expect(settings.title).toBe('Import in progress');
  await user.click(settings);
  expect(onClose).not.toHaveBeenCalled();
  expect(onOpenSettings).not.toHaveBeenCalled();
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
  await waitFor(() => expect(callsOf(api, 'providers:list')).toHaveLength(1));
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
    expect(
      within(modelSelect())
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toContain('text-only'),
  );
  expect(button('Generate').disabled).toBe(true);
  expect(button('Generate').title).toBe('The provider offers no model that can describe images');
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

it('the prompt select lists the Image to prompt prompts only, below the model select, without a tag limit', async () => {
  install();
  render(ui({}));
  await ready();
  const options = within(promptSelect()).getAllByRole('option') as HTMLOptionElement[];
  expect(options.map((o) => o.textContent)).toEqual(['Describe', 'Short']);
  expect(options.map((o) => o.title)).toEqual(['', '']);
  expect(promptSelect().value).toBe(IMAGE_DEFAULT.id);
  expect(modelSelect().compareDocumentPosition(promptSelect()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('preselects the Image to prompt prompt used last', async () => {
  install(
    CONFIGURED,
    MODELS,
    fakeAnalysisPrompts({ prompts: PROMPTS, lastUsed: { tagging: TAG_DEFAULT.id, imagePrompt: IMAGE_SHORT.id } })
      .handlers,
  );
  render(ui({}));
  await ready();
  expect(promptSelect().value).toBe(IMAGE_SHORT.id);
});

it('preselects the first Image to prompt prompt when the one used last is gone', async () => {
  install(
    CONFIGURED,
    MODELS,
    fakeAnalysisPrompts({ prompts: PROMPTS, lastUsed: { tagging: null, imagePrompt: nextId() } }).handlers,
  );
  render(ui({}));
  await ready();
  expect(promptSelect().value).toBe(IMAGE_DEFAULT.id);
  expect(button('Generate').disabled).toBe(false);
});

it('Generate sends the chosen prompt, and reopening preselects it', async () => {
  const user = userEvent.setup();
  const api = install();
  const { rerender } = render(ui({}));
  await ready();
  await user.selectOptions(promptSelect(), IMAGE_SHORT.id);
  await user.click(button('Generate'));
  await waitFor(() => expect(promptField().value).toBe(TEXT));
  expect(callsOf(api, 'analysis:describe')[0]).toMatchObject({ promptId: IMAGE_SHORT.id });
  rerender(ui({ open: false }));
  rerender(ui({ open: true }));
  await ready();
  expect(promptSelect().value).toBe(IMAGE_SHORT.id);
});

it('a cancelled answer still counts as used', async () => {
  const user = userEvent.setup();
  install(CONFIGURED, MODELS, { 'analysis:describe': () => ({ ok: false, code: 'cancelled' }) });
  const { rerender } = render(ui({}));
  await ready();
  await user.selectOptions(promptSelect(), IMAGE_SHORT.id);
  await user.click(button('Generate'));
  await waitFor(() => expect(button('Generate').disabled).toBe(false));
  rerender(ui({ open: false }));
  rerender(ui({ open: true }));
  await ready();
  expect(promptSelect().value).toBe(IMAGE_SHORT.id);
});

it('a busy answer does not count as used', async () => {
  const user = userEvent.setup();
  install(CONFIGURED, MODELS, { 'analysis:describe': () => ({ ok: false, code: 'busy' }) });
  const { rerender } = render(ui({}));
  await ready();
  await user.selectOptions(promptSelect(), IMAGE_SHORT.id);
  await user.click(button('Generate'));
  expect((await screen.findByRole('alert')).textContent).toBe(PROMPT_BUSY_MESSAGE);
  rerender(ui({ open: false }));
  rerender(ui({ open: true }));
  await ready();
  expect(promptSelect().value).toBe(IMAGE_DEFAULT.id);
});

it('a failed prompt load blocks Generate with its own reason', async () => {
  install(CONFIGURED, MODELS, {
    'analysisPrompts:list': () => {
      throw fakeError('internal_error');
    },
  });
  render(ui({}));
  await waitFor(() => expect(button('Generate').title).toBe(PROMPTS_LOAD_FAILED));
  expect(button('Generate').disabled).toBe(true);
});

it('a Generate refused with not_found shows the error and falls back to an existing prompt', async () => {
  const user = userEvent.setup();
  const prompts = fakeAnalysisPrompts({ prompts: PROMPTS });
  const api = install(CONFIGURED, MODELS, {
    ...prompts.handlers,
    'analysis:describe': () => {
      prompts.state.prompts = prompts.state.prompts.filter((p) => p.id !== IMAGE_SHORT.id);
      throw fakeError('not_found', 'The analysis prompt does not exist');
    },
  });
  render(ui({}));
  await ready();
  await user.selectOptions(promptSelect(), IMAGE_SHORT.id);
  const lists = callsOf(api, 'analysisPrompts:list').length;
  await user.click(button('Generate'));
  expect((await screen.findByRole('alert')).textContent).toBe('This item no longer exists.');
  await waitFor(() => expect(promptSelect().value).toBe(IMAGE_DEFAULT.id));
  expect(callsOf(api, 'analysisPrompts:list').length).toBeGreaterThan(lists);
  expect(
    within(promptSelect())
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['Describe']);
});

describe('provider choice', () => {
  const RUNPOD = providerView({
    name: 'RunPod',
    baseUrl: 'https://pod.example.test',
    taggingModel: 'big-vision',
    promptModel: 'pod-describe',
  });
  const POD_MODELS: ListModelsResult = {
    ok: true,
    models: [
      { name: 'big-vision', vision: true },
      { name: 'pod-describe', vision: true },
    ],
  };
  const DOWN: ListModelsResult = { ok: false, code: 'provider_unreachable' };

  const providerSelect = () => screen.getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement;
  const optionTexts = (el: HTMLSelectElement) =>
    within(el)
      .getAllByRole('option')
      .map((o) => o.textContent);

  function installTwo(
    lastUsedId: string | null,
    models: Record<string, ListModelsResult> = {},
    handlers: FakeHandlers = {},
  ) {
    const providers = fakeProviders(
      { providers: [CONFIGURED, RUNPOD], lastUsedId },
      { [CONFIGURED.id]: MODELS, [RUNPOD.id]: POD_MODELS, ...models },
    );
    return install(CONFIGURED, MODELS, { ...providers.handlers, ...handlers });
  }

  it('shows both entries with their states before the model select and preselects the one used last', async () => {
    installTwo(RUNPOD.id, { [CONFIGURED.id]: DOWN });
    render(ui({}));
    await waitFor(() =>
      expect(optionTexts(providerSelect())).toEqual([
        `Local — ${PROVIDER_STATE_LABELS.unreachable}`,
        `RunPod — ${PROVIDER_STATE_LABELS.ready}`,
      ]),
    );
    expect(providerSelect().value).toBe(RUNPOD.id);
    expect(modelSelect().value).toBe('pod-describe');
    expect(providerSelect().compareDocumentPosition(modelSelect()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opening asks every entry for its state once', async () => {
    const api = installTwo(null);
    render(ui({}));
    await ready();
    const refreshed = callsOf(api, 'providers:listModels').filter((r) => (r as { refresh?: boolean }).refresh === true);
    expect(refreshed).toEqual([
      { providerId: CONFIGURED.id, refresh: true },
      { providerId: RUNPOD.id, refresh: true },
    ]);
  });

  it('switching the provider swaps the model list and preselects its prompt default', async () => {
    const user = userEvent.setup();
    installTwo(CONFIGURED.id);
    render(ui({}));
    await ready();
    await user.selectOptions(providerSelect(), RUNPOD.id);
    await waitFor(() => expect(within(modelSelect()).queryByRole('option', { name: 'big-vision' })).toBeTruthy());
    expect(modelSelect().value).toBe('pod-describe');
    expect(within(modelSelect()).queryByRole('option', { name: 'vision-b' })).toBeNull();
  });

  it('a provider that is down blocks Generate with its reason; switching to the ready one enables it', async () => {
    const user = userEvent.setup();
    installTwo(CONFIGURED.id, { [CONFIGURED.id]: DOWN });
    render(ui({}));
    await waitFor(() => expect(button('Generate').title).toBe(JOB_ERROR_MESSAGES.provider_unreachable));
    expect(button('Generate').disabled).toBe(true);
    await user.selectOptions(providerSelect(), RUNPOD.id);
    await waitFor(() => expect(button('Generate').disabled).toBe(false));
  });

  it('Generate sends the selected provider, and the next opening preselects it', async () => {
    const user = userEvent.setup();
    const api = installTwo(CONFIGURED.id);
    const { rerender } = render(ui({}));
    await ready();
    await user.selectOptions(providerSelect(), RUNPOD.id);
    await waitFor(() => expect(button('Generate').disabled).toBe(false));
    await user.click(button('Generate'));
    await waitFor(() => expect(promptField().value).toBe(TEXT));
    expect(callsOf(api, 'analysis:describe')[0]).toMatchObject({ model: 'pod-describe', providerId: RUNPOD.id });
    expect(probe!.list?.lastUsedId).toBe(RUNPOD.id);
    rerender(ui({ open: false }));
    rerender(ui({ open: true }));
    await waitFor(() => expect(providerSelect().value).toBe(RUNPOD.id));
  });

  it('a busy answer does not record the provider as used', async () => {
    const user = userEvent.setup();
    installTwo(CONFIGURED.id, {}, { 'analysis:describe': () => ({ ok: false, code: 'busy' }) });
    render(ui({}));
    await ready();
    await user.selectOptions(providerSelect(), RUNPOD.id);
    await waitFor(() => expect(button('Generate').disabled).toBe(false));
    await user.click(button('Generate'));
    expect((await screen.findByRole('alert')).textContent).toBe(PROMPT_BUSY_MESSAGE);
    expect(probe!.list?.lastUsedId).toBe(CONFIGURED.id);
  });

  it('an entry deleted while the dialog is open moves the selection to the remaining one', async () => {
    const user = userEvent.setup();
    installTwo(CONFIGURED.id);
    render(ui({}));
    await ready();
    await user.selectOptions(providerSelect(), RUNPOD.id);
    await waitFor(() => expect(modelSelect().value).toBe('pod-describe'));
    await act(async () => probe!.remove(RUNPOD.id));
    await waitFor(() => expect(providerSelect().value).toBe(CONFIGURED.id));
    expect(optionTexts(providerSelect())).toHaveLength(1);
    expect(modelSelect().value).toBe('vision-a');
  });

  it('without any entry the provider select shows no provider and Settings is offered', async () => {
    install(UNCONFIGURED);
    render(ui({}));
    await screen.findByRole('button', { name: 'Settings' });
    expect(optionTexts(providerSelect())).toEqual(['No provider']);
    expect(button('Generate').title).toBe(JOB_ERROR_MESSAGES.provider_not_configured);
  });
});
