import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AnalysisPreview,
  AnalysisTarget,
  EnqueueAnalysisResult,
  IpcRequest,
  JobSummary,
  ListModelsResult,
  VisionSettingsView,
} from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { AnalysisStartDialog } from '../../src/renderer/src/components/AnalysisStartDialog';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { BUTTON, ICON_BUTTON } from '../../src/renderer/src/ui';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { NONE_SKIPPED, nextId } from './fixtures';

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

const IDLE: JobSummary = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 0, paused: null };

const PREVIEW: AnalysisPreview = { analysable: 7, alreadyAnalysed: 3, alreadyQueued: 2, notAnalysable: 1 };
const NOTHING_NEW: AnalysisPreview = { analysable: 0, alreadyAnalysed: 3, alreadyQueued: 2, notAnalysable: 1 };

const ENQUEUED: EnqueueAnalysisResult = { enqueued: 7, skipped: { ...NONE_SKIPPED, alreadyAnalysed: 3, alreadyQueued: 2, notAnalysable: 1 } };

const assetTarget = (): AnalysisTarget => ({ kind: 'asset', assetId: '00000000-0000-4000-8000-0000000000aa' });

type PreviewRequest = IpcRequest<'analysis:preview'>;

function install(handlers: FakeHandlers = {}, settings: VisionSettingsView = CONFIGURED, models: ListModelsResult = MODELS) {
  return installFakeApi({
    'settings:getVision': () => settings,
    'settings:listVisionModels': () => models,
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
        <AnalysisStartDialog
          open={o.open ?? true}
          target={'target' in o ? (o.target ?? null) : target}
          onClose={onClose}
          onStarted={onStarted}
          onOpenSettings={onOpenSettings}
        />
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
  expect(callsOf(api, 'analysis:preview')).toEqual([{ target: assetTarget(), model: 'vision-b' }]);
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
    { target: assetTarget(), model: 'vision-b' },
    { target: assetTarget(), model: 'vision-a' },
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
    { target: assetTarget(), model: 'vision-b', mode: 'apply', force: true },
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
    { target: assetTarget(), model: 'vision-b', mode: 'apply', force: false },
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
  expect(callsOf(api, 'analysis:preview')).toEqual([{ target: { kind: 'files', fileIds }, model: 'vision-b' }]);
});

it('every button uses the shared button look', async () => {
  install({}, UNCONFIGURED);
  renderDialog();
  await screen.findByRole('button', { name: 'Settings' });
  for (const button of screen.getAllByRole('button')) expect([BUTTON, ICON_BUTTON]).toContain(button.className);
});
