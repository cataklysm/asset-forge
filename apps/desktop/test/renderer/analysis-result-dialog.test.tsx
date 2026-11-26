import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  JOB_ERROR_MESSAGES,
  type FileRecord,
  type IpcResponse,
  type JobSummary,
  type JobView,
  type ListModelsResult,
  type ProposalView,
  type VisionSettingsView,
} from '@assetforge/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnalysisResultDialog,
  CHOOSE_MODEL,
  MODEL_NOT_LISTED,
  NO_VISION_MODEL,
  NOT_ANALYSABLE,
  PROPOSAL_CHANGED,
  STALE_TITLE,
} from '../../src/renderer/src/components/AnalysisResultDialog';
import { JOB_POLL_MS, JobsProvider } from '../../src/renderer/src/jobs-context';
import { SETTINGS_LOAD_FAILED, START_LOADING } from '../../src/renderer/src/labels';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { AI_CHIP, BUTTON, BUTTON_INLINE, ICON_BUTTON } from '../../src/renderer/src/ui';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { fileRecord, nextId } from './fixtures';

const NOW = '2026-01-01T00:00:00.000Z';

const CONFIGURED: VisionSettingsView = {
  baseUrl: 'http://127.0.0.1:11500',
  timeoutSeconds: 120,
  taggingModel: 'vision-a',
  promptModel: null,
  hasApiKey: false,
  fromEnvironment: false,
  canStoreKey: true,
};

const UNCONFIGURED: VisionSettingsView = { ...CONFIGURED, baseUrl: null, taggingModel: null };

const MODELS: ListModelsResult = {
  ok: true,
  models: [
    { name: 'vision-a', vision: true },
    { name: 'vision-b', vision: true },
    { name: 'text-only', vision: false },
  ],
};

const IDLE: JobSummary = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 0, paused: null };

function proposalOf(p: Partial<ProposalView> = {}): ProposalView {
  return {
    model: 'vision-a',
    createdAt: NOW,
    stale: false,
    tags: [
      { name: 'wood', displayName: 'Wood' },
      { name: 'oak', displayName: 'Oak' },
      { name: 'table', displayName: 'Table' },
    ],
    ...p,
  };
}

function jobOf(file: FileRecord, p: Partial<JobView> = {}): JobView {
  return {
    id: nextId(),
    type: 'vision.analyze_file',
    status: 'queued',
    attempt: 0,
    fileId: file.id,
    fileName: file.originalName,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    startedAt: null,
    finishedAt: null,
    runAfter: null,
    ...p,
  };
}

type Stored = IpcResponse<'analysis:getProposal'>;

interface Options {
  stored?: Stored;
  settings?: VisionSettingsView;
  models?: ListModelsResult;
  handlers?: FakeHandlers;
  open?: boolean;
}

function setup(file: FileRecord, options: Options = {}) {
  const state = {
    stored: options.stored ?? { proposal: null, job: null },
    summary: IDLE,
  };
  const api = installFakeApi({
    'settings:getVision': () => options.settings ?? CONFIGURED,
    'settings:listVisionModels': () => options.models ?? MODELS,
    'jobs:summary': () => state.summary,
    'analysis:getProposal': () => state.stored,
    'analysis:enqueue': () => ({
      enqueued: 1,
      skipped: { notFound: 0, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 0 },
    }),
    'analysis:acceptProposal': () => ({}),
    'analysis:discardProposal': () => ({}),
    'jobs:cancel': () => ({}),
    ...options.handlers,
  });
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const onOpenSettings = vi.fn();
  const ui = (open: boolean, shownFile: FileRecord = file) => (
    <JobsProvider>
      <ProviderSettingsProvider>
        <AnalysisResultDialog
          open={open}
          file={shownFile}
          onClose={onClose}
          onChanged={onChanged}
          onOpenSettings={onOpenSettings}
        />
      </ProviderSettingsProvider>
    </JobsProvider>
  );
  const view = render(ui(options.open ?? true));
  return { api, state, onClose, onChanged, onOpenSettings, rerender: (open: boolean, shownFile?: FileRecord) => view.rerender(ui(open, shownFile)) };
}

const callsOf = (api: ReturnType<typeof installFakeApi>, channel: string) =>
  api.calls.filter((c) => c.channel === channel);

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const tagBox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const modelSelect = () => screen.getByRole('combobox', { name: 'Tagging model' }) as HTMLSelectElement;

/** Waits until the provider has the settings and the model list. */
async function providerReady() {
  await waitFor(() => expect(within(modelSelect()).getAllByRole('option').map((o) => o.textContent)).toContain('vision-b'));
}

describe('AnalysisResultDialog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('without a result offers the tagging default and Analyse sends a forced proposal for the one file', async () => {
    const file = fileRecord();
    const { api } = setup(file);
    await providerReady();
    expect(modelSelect().value).toBe('vision-a');
    expect(callsOf(api, 'analysis:getProposal')[0]!.request).toEqual({ fileId: file.id });

    const user = userEvent.setup();
    await user.selectOptions(modelSelect(), 'vision-b');
    await user.click(button('Analyse'));
    await waitFor(() => expect(callsOf(api, 'analysis:enqueue')).toHaveLength(1));
    expect(callsOf(api, 'analysis:enqueue')[0]!.request).toEqual({
      target: { kind: 'files', fileIds: [file.id] },
      model: 'vision-b',
      mode: 'propose',
      force: true,
    });
    // The new job state is read again.
    await waitFor(() => expect(callsOf(api, 'analysis:getProposal').length).toBeGreaterThanOrEqual(2));
  });

  it('an enqueue that queued nothing shows that the file cannot be analysed', async () => {
    const file = fileRecord();
    setup(file, {
      handlers: {
        'analysis:enqueue': () => ({
          enqueued: 0,
          skipped: { notFound: 0, notAnalysable: 1, alreadyQueued: 0, alreadyAnalysed: 0 },
        }),
      },
    });
    await providerReady();
    await userEvent.setup().click(button('Analyse'));
    expect((await screen.findByRole('alert')).textContent).toContain(NOT_ANALYSABLE);
  });

  it('a queued or running job shows its status and Cancel cancels it', async () => {
    const file = fileRecord();
    const job = jobOf(file, { status: 'running' });
    const { api, state } = setup(file, { stored: { proposal: null, job } });
    expect((await screen.findByRole('status')).textContent).toContain('Running');
    expect(screen.queryByRole('button', { name: 'Analyse' })).toBeNull();

    state.stored = { proposal: null, job: { ...job, status: 'cancelled' } };
    await userEvent.setup().click(button('Cancel'));
    await waitFor(() => expect(callsOf(api, 'jobs:cancel')).toHaveLength(1));
    expect(callsOf(api, 'jobs:cancel')[0]!.request).toEqual({ jobId: job.id });
    expect(await screen.findByRole('button', { name: 'Analyse' })).toBeTruthy();
  });

  it('a queued job shows Queued', async () => {
    const file = fileRecord();
    setup(file, { stored: { proposal: null, job: jobOf(file, { status: 'queued' }) } });
    expect((await screen.findByRole('status')).textContent).toContain('Queued');
  });

  it('a failed job without a proposal shows its message and Analyse', async () => {
    const file = fileRecord();
    const job = jobOf(file, {
      status: 'failed',
      errorCode: 'provider_unreachable',
      errorMessage: 'The analysis provider could not be reached',
    });
    const { api } = setup(file, { stored: { proposal: null, job } });
    expect((await screen.findByRole('alert')).textContent).toContain('The analysis provider could not be reached');
    await providerReady();
    await userEvent.setup().click(button('Analyse'));
    await waitFor(() => expect(callsOf(api, 'analysis:enqueue')).toHaveLength(1));
  });

  it('a re-analysis that failed after the stored proposal shows its message above the still usable proposal', async () => {
    const file = fileRecord();
    const job = jobOf(file, {
      status: 'failed',
      createdAt: '2026-01-01T00:05:00.000Z',
      errorCode: 'provider_timeout',
      errorMessage: JOB_ERROR_MESSAGES.provider_timeout,
    });
    setup(file, { stored: { proposal: proposalOf(), job } });
    expect((await screen.findByRole('alert')).textContent).toBe(JOB_ERROR_MESSAGES.provider_timeout);
    const alert = screen.getByRole('alert');
    const chips = screen.getByRole('group', { name: 'Proposed tags' });
    expect(alert.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tagBox('Wood').checked).toBe(true);
    expect(button('Accept').disabled).toBe(false);
  });

  it('a failed job without a message falls back to the fixed text of its code', async () => {
    const file = fileRecord();
    const job = jobOf(file, {
      status: 'failed',
      createdAt: '2026-01-01T00:05:00.000Z',
      errorCode: 'provider_unauthorized',
      errorMessage: null,
    });
    setup(file, { stored: { proposal: proposalOf(), job } });
    expect((await screen.findByRole('alert')).textContent).toBe(JOB_ERROR_MESSAGES.provider_unauthorized);
  });

  it('a failed job older than the stored proposal shows no alert', async () => {
    const file = fileRecord();
    const job = jobOf(file, {
      status: 'failed',
      createdAt: '2025-12-31T23:00:00.000Z',
      errorCode: 'provider_timeout',
      errorMessage: JOB_ERROR_MESSAGES.provider_timeout,
    });
    setup(file, { stored: { proposal: proposalOf(), job } });
    await screen.findByRole('checkbox', { name: 'Wood' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an Analyse still in flight after closing and reopening for another file neither blocks nor reports on it', async () => {
    const a = fileRecord({ originalName: 'a.png' });
    const b = fileRecord({ originalName: 'b.png' });
    const pending = deferred<IpcResponse<'analysis:enqueue'>>();
    const { api, onClose, rerender } = setup(a, { handlers: { 'analysis:enqueue': () => pending.promise } });
    await providerReady();
    const user = userEvent.setup();
    await user.click(button('Analyse'));
    expect(button('Analyse').disabled).toBe(true);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(false);
    rerender(true, b);
    await waitFor(() =>
      expect(callsOf(api, 'analysis:getProposal').some((c) => (c.request as { fileId: string }).fileId === b.id)).toBe(true),
    );
    await waitFor(() => expect(button('Analyse').disabled).toBe(false));

    const readsOfA = callsOf(api, 'analysis:getProposal').filter((c) => (c.request as { fileId: string }).fileId === a.id).length;
    await act(async () =>
      pending.resolve({ enqueued: 0, skipped: { notFound: 0, notAnalysable: 1, alreadyQueued: 0, alreadyAnalysed: 0 } }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button('Analyse').disabled).toBe(false);
    expect(callsOf(api, 'analysis:getProposal').filter((c) => (c.request as { fileId: string }).fileId === a.id)).toHaveLength(readsOfA);
  });

  it('an accept that succeeds after the dialog moved on reports the change but does not close the new opening', async () => {
    const a = fileRecord({ originalName: 'a.png' });
    const b = fileRecord({ originalName: 'b.png' });
    const pending = deferred<IpcResponse<'analysis:acceptProposal'>>();
    const { api, onClose, onChanged, rerender } = setup(a, {
      stored: { proposal: proposalOf(), job: null },
      handlers: { 'analysis:acceptProposal': () => pending.promise },
    });
    await screen.findByRole('checkbox', { name: 'Wood' });
    await userEvent.setup().click(button('Accept'));
    await waitFor(() => expect(callsOf(api, 'analysis:acceptProposal')).toHaveLength(1));
    rerender(false);
    rerender(true, b);
    await act(async () => pending.resolve({}));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows every proposed tag switched on in the AI chip style and the model it came from', async () => {
    const file = fileRecord();
    setup(file, { stored: { proposal: proposalOf({ model: 'vision-b' }), job: null } });
    expect(await screen.findByRole('checkbox', { name: 'Wood' })).toBeTruthy();
    for (const name of ['Wood', 'Oak', 'Table']) {
      expect(tagBox(name).checked).toBe(true);
      expect(tagBox(name).closest('label')!.className).toContain(AI_CHIP);
    }
    expect(screen.getByTitle('Model').textContent).toBe('vision-b');
    expect(button('Accept').disabled).toBe(false);
    expect(button('Discard').disabled).toBe(false);
    expect(button('Analyse again')).toBeTruthy();
  });

  it('Accept sends only the tags still on, then reports the change and closes', async () => {
    const file = fileRecord();
    const { api, onChanged, onClose } = setup(file, { stored: { proposal: proposalOf(), job: null } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Oak' }));
    expect(tagBox('Oak').checked).toBe(false);
    await user.click(button('Accept'));
    await waitFor(() => expect(callsOf(api, 'analysis:acceptProposal')).toHaveLength(1));
    expect(callsOf(api, 'analysis:acceptProposal')[0]!.request).toEqual({ fileId: file.id, names: ['wood', 'table'] });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Accept is disabled with every tag switched off', async () => {
    const file = fileRecord();
    setup(file, { stored: { proposal: proposalOf(), job: null } });
    const user = userEvent.setup();
    for (const name of ['Wood', 'Oak', 'Table']) await user.click(await screen.findByRole('checkbox', { name }));
    expect(button('Accept').disabled).toBe(true);
    await user.click(tagBox('Table'));
    expect(button('Accept').disabled).toBe(false);
  });

  it('Discard discards the proposal and reports the change', async () => {
    const file = fileRecord();
    const { api, state, onChanged } = setup(file, { stored: { proposal: proposalOf(), job: null } });
    await screen.findByRole('checkbox', { name: 'Wood' });
    state.stored = { proposal: null, job: null };
    await userEvent.setup().click(button('Discard'));
    await waitFor(() => expect(callsOf(api, 'analysis:discardProposal')).toHaveLength(1));
    expect(callsOf(api, 'analysis:discardProposal')[0]!.request).toEqual({ fileId: file.id });
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Wood' })).toBeNull());
    expect(button('Analyse')).toBeTruthy();
  });

  it('a stale proposal can only be discarded or analysed again', async () => {
    const file = fileRecord();
    setup(file, { stored: { proposal: proposalOf({ stale: true }), job: null } });
    await screen.findByRole('checkbox', { name: 'Wood' });
    expect(button('Accept').disabled).toBe(true);
    expect(button('Accept').title).toBe(STALE_TITLE);
    expect(tagBox('Wood').disabled).toBe(true);
    expect(button('Discard').disabled).toBe(false);
    await providerReady();
    expect(button('Analyse again').disabled).toBe(false);
  });

  it('closing sends nothing', async () => {
    const file = fileRecord();
    const { api, onClose } = setup(file, { stored: { proposal: proposalOf(), job: null } });
    await screen.findByRole('checkbox', { name: 'Wood' });
    await providerReady();
    const before = api.calls.filter((c) => c.channel !== 'jobs:summary').length;
    const user = userEvent.setup();
    await user.click(tagBox('Oak'));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.calls.filter((c) => c.channel !== 'jobs:summary')).toHaveLength(before);
  });

  it('a closed dialog reads nothing', async () => {
    const file = fileRecord();
    const { api } = setup(file, { open: false });
    await act(async () => {});
    expect(callsOf(api, 'analysis:getProposal')).toHaveLength(0);
  });

  it('switches to the proposal when the job finishes while open', async () => {
    vi.useFakeTimers();
    const file = fileRecord();
    const job = jobOf(file, { status: 'running' });
    const { state } = setup(file, { stored: { proposal: null, job } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByRole('status')).textContent).toContain('Running');

    state.stored = { proposal: proposalOf(), job: { ...job, status: 'succeeded' } };
    state.summary = { ...IDLE, succeeded: 1, changes: 1 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(tagBox('Wood').checked).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a proposal replaced under the open dialog is shown fresh, with every tag on again', async () => {
    vi.useFakeTimers();
    const file = fileRecord();
    const { state } = setup(file, { stored: { proposal: proposalOf(), job: null } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(tagBox('Wood'));
    expect(tagBox('Wood').checked).toBe(false);

    state.stored = {
      proposal: proposalOf({ model: 'vision-b', createdAt: '2026-01-01T00:05:00.000Z' }),
      job: null,
    };
    state.summary = { ...IDLE, succeeded: 1, changes: 1 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(screen.getByTitle('Model').textContent).toBe('vision-b');
    expect(tagBox('Wood').checked).toBe(true);
  });

  it('a re-read of the same proposal keeps the switched-off tags', async () => {
    vi.useFakeTimers();
    const file = fileRecord();
    const { state } = setup(file, { stored: { proposal: proposalOf(), job: null } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(tagBox('Wood'));
    state.summary = { ...IDLE, changes: 1 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(tagBox('Wood').checked).toBe(false);
  });

  it('Accept against a proposal replaced since it was shown accepts nothing and shows the new one', async () => {
    const file = fileRecord();
    const { api, state, onChanged } = setup(file, { stored: { proposal: proposalOf(), job: null } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Oak' }));
    state.stored = {
      proposal: proposalOf({ model: 'vision-b', createdAt: '2026-01-01T00:05:00.000Z' }),
      job: null,
    };
    await user.click(button('Accept'));
    expect((await screen.findByRole('alert')).textContent).toContain(PROPOSAL_CHANGED);
    expect(callsOf(api, 'analysis:acceptProposal')).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByTitle('Model').textContent).toBe('vision-b');
    expect(tagBox('Oak').checked).toBe(true);
  });

  for (const code of ['invalid_operation', 'not_found'] as const)
    it(`an accept the main side refuses with ${code} re-reads and shows the fixed text`, async () => {
      const file = fileRecord();
      const { api, state, onChanged, onClose } = setup(file, {
        stored: { proposal: proposalOf(), job: null },
        handlers: {
          'analysis:acceptProposal': () => {
            state.stored = { proposal: null, job: null };
            throw fakeError(code);
          },
        },
      });
      await screen.findByRole('checkbox', { name: 'Wood' });
      const reads = callsOf(api, 'analysis:getProposal').length;
      await userEvent.setup().click(button('Accept'));
      // The fixed text, not the main side's message.
      expect((await screen.findByRole('alert')).textContent).toBe(PROPOSAL_CHANGED);
      // The pre-check read, then the re-read after the refusal.
      expect(callsOf(api, 'analysis:getProposal').length).toBe(reads + 2);
      await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Wood' })).toBeNull());
      expect(onChanged).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

  it('a double click on Accept sends one request', async () => {
    const file = fileRecord();
    const { api } = setup(file, { stored: { proposal: proposalOf(), job: null } });
    await screen.findByRole('checkbox', { name: 'Wood' });
    fireEvent.click(button('Accept'));
    fireEvent.click(button('Accept'));
    await waitFor(() => expect(callsOf(api, 'analysis:acceptProposal')).toHaveLength(1));
  });

  it('not configured: Analyse is disabled with a title and Settings navigates to the settings', async () => {
    const file = fileRecord();
    const { api, onOpenSettings, onClose } = setup(file, { settings: UNCONFIGURED });
    const settings = await screen.findByRole('button', { name: 'Settings' });
    expect(button('Analyse').disabled).toBe(true);
    expect(button('Analyse').title).toBe('No analysis provider is configured');
    await userEvent.setup().click(settings);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(callsOf(api, 'analysis:enqueue')).toHaveLength(0);
  });

  it('no selectable model: Analyse is disabled with a title and Settings is offered', async () => {
    const file = fileRecord();
    setup(file, {
      settings: { ...CONFIGURED, taggingModel: null },
      models: { ok: true, models: [{ name: 'text-only', vision: false }] },
    });
    await waitFor(() => expect(button('Analyse').title).toBe(NO_VISION_MODEL));
    expect(button('Analyse').disabled).toBe(true);
    expect(button('Settings')).toBeTruthy();
  });

  it('without a chosen model Analyse is disabled with a title', async () => {
    const file = fileRecord();
    setup(file, { settings: { ...CONFIGURED, taggingModel: null } });
    await providerReady();
    expect(button('Analyse').disabled).toBe(true);
    expect(button('Analyse').title).toBe(CHOOSE_MODEL);
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });

  it('a stored default the provider does not offer blocks Analyse with the reason', async () => {
    const file = fileRecord();
    setup(file, { settings: { ...CONFIGURED, taggingModel: 'gone-model' } });
    await providerReady();
    expect(button('Analyse').disabled).toBe(true);
    expect(button('Analyse').title).toBe(MODEL_NOT_LISTED);
  });

  it('while the settings load Analyse says so instead of "not configured"', async () => {
    const file = fileRecord();
    const settings = deferred<VisionSettingsView>();
    setup(file, { handlers: { 'settings:getVision': () => settings.promise } });
    await waitFor(() => expect(button('Analyse').title).toBe(START_LOADING));
    expect(button('Analyse').title).not.toBe(JOB_ERROR_MESSAGES.provider_not_configured);
    await act(async () => settings.reject(fakeError('internal_error')));
    await waitFor(() => expect(button('Analyse').title).toBe(SETTINGS_LOAD_FAILED));
  });

  it('uses only the shared button styles', async () => {
    const file = fileRecord();
    setup(file, { stored: { proposal: proposalOf(), job: null } });
    await screen.findByRole('checkbox', { name: 'Wood' });
    await providerReady();
    for (const el of screen.getAllByRole('button')) expect([BUTTON, ICON_BUTTON, BUTTON_INLINE]).toContain(el.className);
  });
});
