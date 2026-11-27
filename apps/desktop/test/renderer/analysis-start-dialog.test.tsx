import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AnalysisPreview,
  AnalysisTarget,
  EnqueueAnalysisResult,
  IpcRequest,
  JobSummary,
  ListModelsResult,
  ProviderList,
  ProviderView,
} from '@assetforge/contracts';
import { JOB_ERROR_MESSAGES } from '@assetforge/contracts';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisPromptsProvider } from '../../src/renderer/src/analysis-prompts-context';
import { AnalysisStartDialog } from '../../src/renderer/src/components/AnalysisStartDialog';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import {
  MODEL_NOT_LISTED,
  PROMPTS_LOAD_FAILED,
  PROVIDER_STATE_LABELS,
  SETTINGS_LOAD_FAILED,
  START_COUNTING,
  START_LOADING,
  START_NOTHING_TO_DO,
} from '../../src/renderer/src/labels';
import { ProviderSettingsProvider, useProviders, type ProvidersState } from '../../src/renderer/src/provider-context';
import { BUTTON, ICON_BUTTON } from '../../src/renderer/src/ui';
import {
  deferred,
  fakeAnalysisPrompts,
  fakeError,
  fakeProviders,
  installFakeApi,
  providerView,
  type FakeHandlers,
} from './fake-api';
import { NONE_SKIPPED, imagePrompt, nextId, taggingPrompt } from './fixtures';

const TAG_DEFAULT = taggingPrompt({ name: 'Default' });
const TAG_DETAIL = taggingPrompt({ name: 'Detail', maxTags: 30 });
const IMAGE_DEFAULT = imagePrompt({ name: 'Describe' });
const PROMPTS = [TAG_DEFAULT, IMAGE_DEFAULT, TAG_DETAIL];

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

const IDLE: JobSummary = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 0, paused: [], pausedHosts: [] };

const PREVIEW: AnalysisPreview = { analysable: 7, alreadyAnalysed: 3, alreadyQueued: 2, notAnalysable: 1 };
const NOTHING_NEW: AnalysisPreview = { analysable: 0, alreadyAnalysed: 3, alreadyQueued: 2, notAnalysable: 1 };

const ENQUEUED: EnqueueAnalysisResult = { enqueued: 7, skipped: { ...NONE_SKIPPED, alreadyAnalysed: 3, alreadyQueued: 2, notAnalysable: 1 } };

const assetTarget = (): AnalysisTarget => ({ kind: 'asset', assetId: '00000000-0000-4000-8000-0000000000aa' });

type PreviewRequest = IpcRequest<'analysis:preview'>;

/** The `providers:*` handlers of one entry answering `models`, or of none. */
function oneProvider(entry: ProviderView | null, models: ListModelsResult = MODELS) {
  return entry === null
    ? fakeProviders().handlers
    : fakeProviders({ providers: [entry], lastUsedId: entry.id }, { [entry.id]: models }).handlers;
}

function install(handlers: FakeHandlers = {}, entry: ProviderView | null = CONFIGURED, models: ListModelsResult = MODELS) {
  return installFakeApi({
    ...fakeAnalysisPrompts({ prompts: PROMPTS }).handlers,
    ...oneProvider(entry, models),
    'jobs:summary': () => IDLE,
    'analysis:preview': () => PREVIEW,
    'analysis:enqueue': () => ENQUEUED,
    ...handlers,
  });
}

const callsOf = (api: ReturnType<typeof installFakeApi>, channel: string) =>
  api.calls.filter((c) => c.channel === channel).map((c) => c.request);

interface Overrides {
  open?: boolean;
  target?: AnalysisTarget | null;
}

function renderDialog(overrides: Overrides = {}) {
  const onClose = vi.fn();
  const onStarted = vi.fn();
  const onOpenSettings = vi.fn();
  const target = 'target' in overrides ? overrides.target! : assetTarget();
  const ui = (o: Overrides) => (
    <JobsProvider>
      <ProviderSettingsProvider>
        <AnalysisPromptsProvider>
          <AnalysisStartDialog
            open={o.open ?? true}
            target={'target' in o ? (o.target ?? null) : target}
            onClose={onClose}
            onStarted={onStarted}
            onOpenSettings={onOpenSettings}
          />
        </AnalysisPromptsProvider>
      </ProviderSettingsProvider>
    </JobsProvider>
  );
  const view = render(ui(overrides));
  return { onClose, onStarted, onOpenSettings, rerender: (o: Overrides) => view.rerender(ui(o)) };
}

const modelSelect = () => screen.getByRole('combobox', { name: 'Tagging model' }) as HTMLSelectElement;
const startButton = () => screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
const count = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

async function modelsListed() {
  await waitFor(() => expect(screen.getByRole('option', { name: 'vision-a' })).toBeTruthy());
}

async function previewShown(preview: AnalysisPreview = PREVIEW) {
  await waitFor(() => expect(count('To analyse')).toBe(String(preview.analysable)));
}

it('opens with the tagging default selected and previews the target with it', async () => {
  const api = install();
  renderDialog();
  await previewShown();
  expect(modelSelect().value).toBe('vision-b');
  expect(callsOf(api, 'analysis:preview')).toEqual([{ target: assetTarget(), model: 'vision-b', providerId: CONFIGURED.id }]);
});

it('shows the four counts of the preview', async () => {
  install();
  renderDialog();
  await previewShown();
  expect(count('To analyse')).toBe('7');
  expect(count('Already analysed')).toBe('3');
  expect(count('Already queued')).toBe('2');
  expect(count('Not analysable')).toBe('1');
  expect(startButton().disabled).toBe(false);
});

it('previews again when the model changes and ignores a stale answer', async () => {
  const first = deferred<AnalysisPreview>();
  const answers: Record<string, () => AnalysisPreview | Promise<AnalysisPreview>> = {
    'vision-b': () => first.promise,
    'vision-a': () => ({ analysable: 4, alreadyAnalysed: 0, alreadyQueued: 0, notAnalysable: 0 }),
  };
  const api = install({ 'analysis:preview': (r: PreviewRequest) => answers[r.model]!() });
  renderDialog();
  await modelsListed();
  await waitFor(() => expect(callsOf(api, 'analysis:preview')).toHaveLength(1));
  await userEvent.selectOptions(modelSelect(), 'vision-a');
  await waitFor(() => expect(count('To analyse')).toBe('4'));
  expect(callsOf(api, 'analysis:preview')).toEqual([
    { target: assetTarget(), model: 'vision-b', providerId: CONFIGURED.id },
    { target: assetTarget(), model: 'vision-a', providerId: CONFIGURED.id },
  ]);
  await act(async () => first.resolve({ analysable: 99, alreadyAnalysed: 0, alreadyQueued: 0, notAnalysable: 0 }));
  expect(count('To analyse')).toBe('4');
});

it('does not preview again for an equal target passed as a new object', async () => {
  const api = install();
  const { rerender } = renderDialog();
  await previewShown();
  rerender({ target: assetTarget() });
  rerender({ target: assetTarget() });
  await previewShown();
  expect(callsOf(api, 'analysis:preview')).toHaveLength(1);
});

it('preselects no model without a stored tagging default and keeps Start disabled', async () => {
  const api = install({}, { ...CONFIGURED, taggingModel: null });
  renderDialog();
  await modelsListed();
  expect(modelSelect().value).toBe('');
  expect(startButton().disabled).toBe(true);
  expect(startButton().title).not.toBe('');
  expect(callsOf(api, 'analysis:preview')).toEqual([]);
});

it('keeps Start disabled while the preview loads', async () => {
  const pending = deferred<AnalysisPreview>();
  install({ 'analysis:preview': () => pending.promise });
  renderDialog();
  await modelsListed();
  expect(startButton().disabled).toBe(true);
  await act(async () => pending.resolve(PREVIEW));
  await previewShown();
  expect(startButton().disabled).toBe(false);
});

it('keeps Start disabled when nothing would be enqueued until Analyse again is checked', async () => {
  const api = install({ 'analysis:preview': () => NOTHING_NEW });
  const { onStarted } = renderDialog();
  await previewShown(NOTHING_NEW);
  expect(startButton().disabled).toBe(true);
  expect(startButton().title).not.toBe('');
  await userEvent.click(screen.getByRole('checkbox', { name: 'Analyse again' }));
  expect(startButton().disabled).toBe(false);
  await userEvent.click(startButton());
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
  expect(callsOf(api, 'analysis:enqueue')).toEqual([
    { target: assetTarget(), model: 'vision-b', providerId: CONFIGURED.id, mode: 'apply', force: true, promptId: TAG_DEFAULT.id },
  ]);
});

it('keeps Start disabled when the target has no analysable file at all, also with Analyse again', async () => {
  const empty: AnalysisPreview = { analysable: 0, alreadyAnalysed: 0, alreadyQueued: 2, notAnalysable: 4 };
  install({ 'analysis:preview': () => empty });
  renderDialog();
  await previewShown(empty);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Analyse again' }));
  expect(startButton().disabled).toBe(true);
});

it('Start enqueues in mode apply, then reports, closes and refreshes the jobs', async () => {
  const api = install();
  const { onStarted, onClose } = renderDialog();
  await previewShown();
  const polls = callsOf(api, 'jobs:summary').length;
  await userEvent.click(startButton());
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(callsOf(api, 'analysis:enqueue')).toEqual([
    { target: assetTarget(), model: 'vision-b', providerId: CONFIGURED.id, mode: 'apply', force: false, promptId: TAG_DEFAULT.id },
  ]);
  expect(onStarted).toHaveBeenCalledWith(ENQUEUED);
  expect(onStarted.mock.invocationCallOrder[0]!).toBeLessThan(onClose.mock.invocationCallOrder[0]!);
  await waitFor(() => expect(callsOf(api, 'jobs:summary').length).toBeGreaterThan(polls));
});

it('a rejected enqueue shows the message and keeps the dialog open', async () => {
  install({
    'analysis:enqueue': () => {
      // The fake carries the code as its message; describeError shows it as sent.
      throw fakeError('invalid_operation');
    },
  });
  const { onStarted, onClose } = renderDialog();
  await previewShown();
  await userEvent.click(startButton());
  expect((await screen.findByRole('alert')).textContent).toBe('invalid_operation');
  expect(onStarted).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(startButton().disabled).toBe(false);
});

it('a double click sends one request', async () => {
  const pending = deferred<EnqueueAnalysisResult>();
  const api = install({ 'analysis:enqueue': () => pending.promise });
  const { onStarted } = renderDialog();
  await previewShown();
  await userEvent.dblClick(startButton());
  await act(async () => pending.resolve(ENQUEUED));
  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
  expect(callsOf(api, 'analysis:enqueue')).toHaveLength(1);
});

it('without a configured provider offers a button to the settings and previews nothing', async () => {
  const api = install({}, UNCONFIGURED);
  const { onOpenSettings, onClose } = renderDialog();
  const settings = await screen.findByRole('button', { name: 'Settings' });
  expect(startButton().disabled).toBe(true);
  expect(startButton().title).not.toBe('');
  expect(callsOf(api, 'analysis:preview')).toEqual([]);
  await userEvent.click(settings);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
});

it('offers the settings when the provider has no selectable model', async () => {
  install({}, { ...CONFIGURED, taggingModel: null }, { ok: true, models: [{ name: 'text-only', vision: false }] });
  renderDialog();
  expect(await screen.findByRole('button', { name: 'Settings' })).toBeTruthy();
  expect(startButton().disabled).toBe(true);
});

it('offers no settings button when the provider is configured with a vision model', async () => {
  install();
  renderDialog();
  await previewShown();
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
});

it('offers the settings when the model list call itself fails and no model is stored', async () => {
  install(
    {
      'providers:listModels': () => {
        throw fakeError('internal_error');
      },
    },
    { ...CONFIGURED, taggingModel: null },
  );
  renderDialog();
  expect(await screen.findByRole('button', { name: 'Settings' })).toBeTruthy();
  expect(startButton().disabled).toBe(true);
});

it('a failed model list blocks Start even with a stored model, and offers no settings for it', async () => {
  install({}, CONFIGURED, { ok: false, code: 'provider_unreachable' });
  renderDialog();
  await previewShown();
  await waitFor(() => expect(startButton().title).toBe(JOB_ERROR_MESSAGES.provider_unreachable));
  expect(startButton().disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
});

it('while the settings load Start says so, and a failed load is not "not configured"', async () => {
  const settings = deferred<ProviderList>();
  install({ 'providers:list': () => settings.promise });
  renderDialog();
  await waitFor(() => expect(startButton().title).toBe(START_LOADING));
  await act(async () => settings.reject(fakeError('internal_error')));
  await waitFor(() => expect(startButton().title).toBe(SETTINGS_LOAD_FAILED));
  expect(startButton().disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
});

it('a stored tagging default the provider no longer lists blocks Start and previews nothing', async () => {
  const api = install({}, { ...CONFIGURED, taggingModel: 'gone-model' });
  renderDialog();
  await waitFor(() => expect(startButton().title).toBe(MODEL_NOT_LISTED));
  expect(startButton().disabled).toBe(true);
  // The preview may run while the list loads; the start stays blocked once it is there.
  expect(callsOf(api, 'analysis:enqueue')).toEqual([]);
});

it('the settings offer does not change while the files are counted or when nothing is to do', async () => {
  const preview = deferred<AnalysisPreview>();
  install({ 'analysis:preview': () => preview.promise }, CONFIGURED);
  renderDialog();
  await waitFor(() => expect(startButton().title).toBe(START_COUNTING));
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  await act(async () => preview.resolve(NOTHING_NEW));
  await waitFor(() => expect(startButton().title).toBe(START_NOTHING_TO_DO));
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
});

it('Settings is disabled with the given reason while the settings screen cannot be shown', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onOpenSettings = vi.fn();
  install({}, UNCONFIGURED);
  render(
    <JobsProvider>
      <ProviderSettingsProvider>
        <AnalysisPromptsProvider>
          <AnalysisStartDialog
            open
            target={assetTarget()}
            onClose={onClose}
            onStarted={() => {}}
            onOpenSettings={onOpenSettings}
            settingsBlocked="Import in progress"
          />
        </AnalysisPromptsProvider>
      </ProviderSettingsProvider>
    </JobsProvider>,
  );
  const settings = (await screen.findByRole('button', { name: 'Settings' })) as HTMLButtonElement;
  expect(settings.disabled).toBe(true);
  expect(settings.title).toBe('Import in progress');
  await user.click(settings);
  expect(onClose).not.toHaveBeenCalled();
  expect(onOpenSettings).not.toHaveBeenCalled();
});

it('a failed start keeps the retry of a preview that failed afterwards', async () => {
  let previewFails = false;
  install({
    'analysis:enqueue': () => {
      throw fakeError('invalid_operation');
    },
    'analysis:preview': () => {
      if (previewFails) throw fakeError('not_found');
      return PREVIEW;
    },
  });
  renderDialog();
  await previewShown();
  await userEvent.click(startButton());
  await screen.findByRole('alert');
  previewFails = true;
  await userEvent.selectOptions(modelSelect(), 'vision-a');
  expect(await screen.findByRole('button', { name: 'Count again' })).toBeTruthy();
  expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual(['invalid_operation', 'This item no longer exists.']);
});

it('reopening starts again from the tagging default with Analyse again off', async () => {
  install({ 'analysis:preview': () => NOTHING_NEW });
  const { rerender } = renderDialog();
  await previewShown(NOTHING_NEW);
  await userEvent.selectOptions(modelSelect(), 'vision-a');
  await userEvent.click(screen.getByRole('checkbox', { name: 'Analyse again' }));
  rerender({ open: false });
  rerender({ open: true });
  await previewShown(NOTHING_NEW);
  expect(modelSelect().value).toBe('vision-b');
  expect((screen.getByRole('checkbox', { name: 'Analyse again' }) as HTMLInputElement).checked).toBe(false);
});

it('with Analyse again the already analysed files move into To analyse', async () => {
  install({ 'analysis:preview': () => NOTHING_NEW });
  renderDialog();
  await previewShown(NOTHING_NEW);
  expect(count('Already analysed')).toBe('3');
  await userEvent.click(screen.getByRole('checkbox', { name: 'Analyse again' }));
  expect(count('To analyse')).toBe('3');
  expect(count('Already analysed')).toBe('0');
  expect(count('Already queued')).toBe('2');
  expect(count('Not analysable')).toBe('1');
});

it('with Analyse again To analyse adds the analysed files to the new ones, and unchecking restores them', async () => {
  install();
  renderDialog();
  await previewShown();
  const again = screen.getByRole('checkbox', { name: 'Analyse again' });
  await userEvent.click(again);
  expect(count('To analyse')).toBe('10');
  expect(count('Already analysed')).toBe('0');
  await userEvent.click(again);
  expect(count('To analyse')).toBe('7');
  expect(count('Already analysed')).toBe('3');
});

it('a rejected preview shows the message, blocks Start with its own reason and can be retried', async () => {
  let fail = true;
  const api = install({
    'analysis:preview': () => {
      if (fail) throw fakeError('invalid_operation');
      return PREVIEW;
    },
  });
  renderDialog();
  expect((await screen.findByRole('alert')).textContent).toBe('invalid_operation');
  expect(startButton().disabled).toBe(true);
  expect(startButton().title).toBe('The files could not be counted');
  const retry = screen.getByRole('button', { name: 'Count again' });
  expect(retry.className).toBe(ICON_BUTTON);
  expect(retry.title).toBe('Count again');
  fail = false;
  await userEvent.click(retry);
  await previewShown();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(startButton().disabled).toBe(false);
  expect(callsOf(api, 'analysis:preview')).toHaveLength(2);
});

it('while a start is in flight Cancel is disabled and Esc does not close', async () => {
  const pending = deferred<EnqueueAnalysisResult>();
  install({ 'analysis:enqueue': () => pending.promise });
  const { onClose, onStarted } = renderDialog();
  await previewShown();
  await userEvent.click(startButton());
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByRole('dialog') as HTMLDialogElement).open).toBe(true);
  await act(async () => pending.resolve(ENQUEUED));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onStarted).toHaveBeenCalledTimes(1);
});

it('a start that fails after Esc was pressed shows its error in the still open dialog', async () => {
  const pending = deferred<EnqueueAnalysisResult>();
  install({ 'analysis:enqueue': () => pending.promise });
  const { onClose } = renderDialog();
  await previewShown();
  await userEvent.click(startButton());
  await userEvent.keyboard('{Escape}');
  await act(async () => pending.reject(fakeError('invalid_operation')));
  expect((await screen.findByRole('alert')).textContent).toBe('invalid_operation');
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
});

it('Cancel closes without a request', async () => {
  const api = install();
  const { onClose, onStarted } = renderDialog();
  await previewShown();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onStarted).not.toHaveBeenCalled();
  expect(callsOf(api, 'analysis:enqueue')).toEqual([]);
});

it('a file target is sent as given', async () => {
  const fileIds = [nextId(), nextId()];
  const api = install();
  renderDialog({ target: { kind: 'files', fileIds } });
  await previewShown();
  expect(callsOf(api, 'analysis:preview')).toEqual([{ target: { kind: 'files', fileIds }, model: 'vision-b', providerId: CONFIGURED.id }]);
});

it('every button uses the shared button look', async () => {
  install({}, UNCONFIGURED);
  renderDialog();
  await screen.findByRole('button', { name: 'Settings' });
  for (const button of screen.getAllByRole('button')) expect([BUTTON, ICON_BUTTON]).toContain(button.className);
});

const promptSelect = () => screen.getByRole('combobox', { name: 'Prompt' }) as HTMLSelectElement;

async function promptsListed() {
  await waitFor(() => expect(within(promptSelect()).queryAllByRole('option').length).toBeGreaterThan(1));
}

it('the prompt select lists the tagging prompts only, below the model select, with the tag limit as tooltip', async () => {
  install();
  renderDialog();
  await previewShown();
  await promptsListed();
  const options = within(promptSelect()).getAllByRole('option') as HTMLOptionElement[];
  expect(options.map((o) => o.textContent)).toEqual(['Default', 'Detail']);
  expect(options.map((o) => o.title)).toEqual(['Tag limit 15', 'Tag limit 30']);
  expect(modelSelect().compareDocumentPosition(promptSelect()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('preselects the tagging prompt used last', async () => {
  install(fakeAnalysisPrompts({ prompts: PROMPTS, lastUsed: { tagging: TAG_DETAIL.id, imagePrompt: null } }).handlers);
  renderDialog();
  await previewShown();
  await waitFor(() => expect(promptSelect().value).toBe(TAG_DETAIL.id));
});

it('preselects the first tagging prompt when the one used last is gone', async () => {
  install(fakeAnalysisPrompts({ prompts: PROMPTS, lastUsed: { tagging: nextId(), imagePrompt: IMAGE_DEFAULT.id } }).handlers);
  renderDialog();
  await previewShown();
  await waitFor(() => expect(promptSelect().value).toBe(TAG_DEFAULT.id));
  expect(startButton().disabled).toBe(false);
});

it('Start sends the chosen prompt, and reopening preselects it', async () => {
  const api = install();
  const { rerender } = renderDialog();
  await previewShown();
  await promptsListed();
  await userEvent.selectOptions(promptSelect(), TAG_DETAIL.id);
  await userEvent.click(startButton());
  await waitFor(() => expect(callsOf(api, 'analysis:enqueue')).toHaveLength(1));
  expect(callsOf(api, 'analysis:enqueue')[0]).toMatchObject({ promptId: TAG_DETAIL.id });
  rerender({ open: false });
  rerender({ open: true });
  await previewShown();
  expect(promptSelect().value).toBe(TAG_DETAIL.id);
});

it('changing the prompt does not preview again', async () => {
  const api = install();
  renderDialog();
  await previewShown();
  await promptsListed();
  await userEvent.selectOptions(promptSelect(), TAG_DETAIL.id);
  expect(promptSelect().value).toBe(TAG_DETAIL.id);
  expect(callsOf(api, 'analysis:preview')).toHaveLength(1);
});

it('a failed prompt load blocks Start with its own reason', async () => {
  install({
    'analysisPrompts:list': () => {
      throw fakeError('internal_error');
    },
  });
  renderDialog();
  await previewShown();
  await waitFor(() => expect(startButton().title).toBe(PROMPTS_LOAD_FAILED));
  expect(startButton().disabled).toBe(true);
});

it('a start refused with not_found shows the error and falls back to an existing prompt', async () => {
  const prompts = fakeAnalysisPrompts({ prompts: PROMPTS });
  const api = install({
    ...prompts.handlers,
    'analysis:enqueue': () => {
      prompts.state.prompts = prompts.state.prompts.filter((p) => p.id !== TAG_DETAIL.id);
      throw fakeError('not_found', 'The analysis prompt does not exist');
    },
  });
  const { onStarted, onClose } = renderDialog();
  await previewShown();
  await promptsListed();
  await userEvent.selectOptions(promptSelect(), TAG_DETAIL.id);
  const lists = callsOf(api, 'analysisPrompts:list').length;
  await userEvent.click(startButton());
  expect((await screen.findByRole('alert')).textContent).toBe('This item no longer exists.');
  await waitFor(() => expect(promptSelect().value).toBe(TAG_DEFAULT.id));
  expect(callsOf(api, 'analysisPrompts:list').length).toBeGreaterThan(lists);
  expect(within(promptSelect()).getAllByRole('option').map((o) => o.textContent)).toEqual(['Default']);
  expect(onStarted).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

describe('provider choice', () => {
  const RUNPOD = providerView({ name: 'RunPod', baseUrl: 'https://pod.example.test', taggingModel: 'big-vision', promptModel: null });
  const POD_MODELS: ListModelsResult = { ok: true, models: [{ name: 'big-vision', vision: true }] };
  const DOWN: ListModelsResult = { ok: false, code: 'provider_unreachable' };

  const providerSelect = () => screen.getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement;
  const optionTexts = (el: HTMLSelectElement) => within(el).getAllByRole('option').map((o) => o.textContent);

  function installTwo(lastUsedId: string | null, models: Record<string, ListModelsResult> = {}, handlers: FakeHandlers = {}) {
    const providers = fakeProviders(
      { providers: [CONFIGURED, RUNPOD], lastUsedId },
      { [CONFIGURED.id]: MODELS, [RUNPOD.id]: POD_MODELS, ...models },
    );
    const api = install({ ...providers.handlers, ...handlers });
    return { api, providers };
  }

  let probe: ProvidersState | null = null;
  function Probe() {
    probe = useProviders();
    return null;
  }

  function renderWithProbe() {
    const onStarted = vi.fn();
    const onClose = vi.fn();
    const ui = (open: boolean) => (
      <JobsProvider>
        <ProviderSettingsProvider>
          <AnalysisPromptsProvider>
            <Probe />
            <AnalysisStartDialog
              open={open}
              target={assetTarget()}
              onClose={onClose}
              onStarted={onStarted}
              onOpenSettings={() => {}}
            />
          </AnalysisPromptsProvider>
        </ProviderSettingsProvider>
      </JobsProvider>
    );
    const view = render(ui(true));
    return { onStarted, onClose, rerender: (open: boolean) => view.rerender(ui(open)) };
  }

  it('shows both entries with their states before the model select and preselects the one used last', async () => {
    installTwo(RUNPOD.id, { [CONFIGURED.id]: DOWN });
    renderDialog();
    await waitFor(() =>
      expect(optionTexts(providerSelect())).toEqual([
        `Local — ${PROVIDER_STATE_LABELS.unreachable}`,
        `RunPod — ${PROVIDER_STATE_LABELS.ready}`,
      ]),
    );
    expect(providerSelect().value).toBe(RUNPOD.id);
    expect(modelSelect().value).toBe('big-vision');
    expect(providerSelect().compareDocumentPosition(modelSelect()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opening asks every entry for its state once', async () => {
    const { api } = installTwo(null);
    renderDialog();
    await previewShown();
    const refreshed = callsOf(api, 'providers:listModels').filter((r) => (r as { refresh?: boolean }).refresh === true);
    expect(refreshed).toEqual([
      { providerId: CONFIGURED.id, refresh: true },
      { providerId: RUNPOD.id, refresh: true },
    ]);
  });

  it('switching the provider swaps the model list, preselects its tagging default and previews with it', async () => {
    const { api } = installTwo(CONFIGURED.id);
    renderDialog();
    await previewShown();
    expect(modelSelect().value).toBe('vision-b');
    await userEvent.selectOptions(providerSelect(), RUNPOD.id);
    await waitFor(() => expect(within(modelSelect()).queryByRole('option', { name: 'big-vision' })).toBeTruthy());
    expect(modelSelect().value).toBe('big-vision');
    expect(within(modelSelect()).queryByRole('option', { name: 'vision-a' })).toBeNull();
    await waitFor(() =>
      expect(callsOf(api, 'analysis:preview').at(-1)).toEqual({ target: assetTarget(), model: 'big-vision', providerId: RUNPOD.id }),
    );
  });

  it('switching to an entry without a tagging default selects no model', async () => {
    const bare = providerView({ name: 'Bare', taggingModel: null });
    const providers = fakeProviders({ providers: [CONFIGURED, bare], lastUsedId: CONFIGURED.id }, { [CONFIGURED.id]: MODELS });
    install(providers.handlers);
    renderDialog();
    await previewShown();
    await userEvent.selectOptions(providerSelect(), bare.id);
    expect(modelSelect().value).toBe('');
    expect(startButton().disabled).toBe(true);
  });

  it('a provider that is down blocks Start with its reason; switching to the ready one enables it', async () => {
    installTwo(CONFIGURED.id, { [CONFIGURED.id]: DOWN });
    renderDialog();
    await waitFor(() => expect(startButton().title).toBe(JOB_ERROR_MESSAGES.provider_unreachable));
    expect(startButton().disabled).toBe(true);
    await userEvent.selectOptions(providerSelect(), RUNPOD.id);
    await previewShown();
    await waitFor(() => expect(startButton().disabled).toBe(false));
  });

  it('Start sends the selected provider, and the next opening preselects it', async () => {
    const { api } = installTwo(CONFIGURED.id);
    const { rerender, onStarted } = renderWithProbe();
    await previewShown();
    await userEvent.selectOptions(providerSelect(), RUNPOD.id);
    await previewShown();
    await waitFor(() => expect(startButton().disabled).toBe(false));
    await userEvent.click(startButton());
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(callsOf(api, 'analysis:enqueue')).toEqual([
      { target: assetTarget(), model: 'big-vision', providerId: RUNPOD.id, mode: 'apply', force: false, promptId: TAG_DEFAULT.id },
    ]);
    expect(probe!.list?.lastUsedId).toBe(RUNPOD.id);
    rerender(false);
    rerender(true);
    await waitFor(() => expect(providerSelect().value).toBe(RUNPOD.id));
    expect(modelSelect().value).toBe('big-vision');
  });

  it('an entry deleted while the dialog is open moves the selection to the remaining one', async () => {
    installTwo(CONFIGURED.id);
    renderWithProbe();
    await previewShown();
    await userEvent.selectOptions(providerSelect(), RUNPOD.id);
    await waitFor(() => expect(modelSelect().value).toBe('big-vision'));
    await act(async () => probe!.remove(RUNPOD.id));
    await waitFor(() => expect(providerSelect().value).toBe(CONFIGURED.id));
    expect(optionTexts(providerSelect())).toHaveLength(1);
    expect(modelSelect().value).toBe('vision-b');
  });

  it('without any entry the provider select shows no provider and Start is not configured', async () => {
    install({}, UNCONFIGURED);
    renderDialog();
    await screen.findByRole('button', { name: 'Settings' });
    expect(optionTexts(providerSelect())).toEqual(['No provider']);
    expect(startButton().title).toBe(JOB_ERROR_MESSAGES.provider_not_configured);
    expect(modelSelect().disabled).toBe(true);
  });
});
