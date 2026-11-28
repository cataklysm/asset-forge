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
  type ProviderList,
  type ProviderView,
} from '@assetforge/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnalysisResultDialog,
  CHOOSE_MODEL,
  MODEL_NOT_LISTED,
  NO_VISION_MODEL,
  NOT_ANALYSABLE,
  PROPOSAL_CHANGED,
  proposalKey,
  STALE_TITLE,
} from '../../src/renderer/src/components/AnalysisResultDialog';
import { JOB_POLL_MS, JobsProvider } from '../../src/renderer/src/jobs-context';
import { AnalysisPromptsProvider } from '../../src/renderer/src/analysis-prompts-context';
import {
  APPLIED_TAGS_LABEL,
  BATCH_ANALYSIS_LABEL,
  PROMPTS_LOAD_FAILED,
  START_FORCE_LABEL,
  PROVIDER_STATE_LABELS,
  SETTINGS_LOAD_FAILED,
  START_LOADING,
} from '../../src/renderer/src/labels';
import { ProviderSettingsProvider, useProviders, type ProvidersState } from '../../src/renderer/src/provider-context';
import { AI_CHIP, BUTTON, BUTTON_INLINE, ICON_BUTTON } from '../../src/renderer/src/ui';
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
const TAG_DETAIL = taggingPrompt({ name: 'Detail', maxTags: 30 });
const IMAGE_DEFAULT = imagePrompt({ name: 'Describe' });
const PROMPTS = [TAG_DEFAULT, IMAGE_DEFAULT, TAG_DETAIL];

const NOW = '2026-01-01T00:00:00.000Z';

/** The one entry most tests use; `null` in its place stands for no entry at all. */
const CONFIGURED: ProviderView = providerView({ name: 'Local', taggingModel: 'vision-a', promptModel: null });
const UNCONFIGURED = null;

const MODELS: ListModelsResult = {
  ok: true,
  models: [
    { name: 'vision-a', vision: true },
    { name: 'vision-b', vision: true },
    { name: 'text-only', vision: false },
  ],
};

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

function proposalOf(p: Partial<ProposalView> = {}): ProposalView {
  return {
    model: 'vision-a',
    promptName: null,
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
    providerId: null,
    providerName: null,
    model: null,
    mode: 'propose',
    url: null,
    host: null,
    result: null,
    ...p,
  };
}

type Stored = IpcResponse<'analysis:getProposal'>;

interface Options {
  stored?: Stored;
  /** The one provider entry; `null` for none. */
  provider?: ProviderView | null;
  models?: ListModelsResult;
  handlers?: FakeHandlers;
  open?: boolean;
}

/** The `providers:*` handlers of one entry answering `models`, or of none. */
function oneProvider(entry: ProviderView | null, models: ListModelsResult) {
  return entry === null
    ? fakeProviders().handlers
    : fakeProviders({ providers: [entry], lastUsedId: entry.id }, { [entry.id]: models }).handlers;
}

let probe: ProvidersState | null = null;
function Probe() {
  probe = useProviders();
  return null;
}

function setup(file: FileRecord, options: Options = {}) {
  const state = {
    stored: options.stored ?? { proposal: null, job: null },
    summary: IDLE,
  };
  const api = installFakeApi({
    ...fakeAnalysisPrompts({ prompts: PROMPTS }).handlers,
    ...oneProvider(options.provider === undefined ? CONFIGURED : options.provider, options.models ?? MODELS),
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
        <AnalysisPromptsProvider>
          <Probe />
          <AnalysisResultDialog
            open={open}
            file={shownFile}
            onClose={onClose}
            onChanged={onChanged}
            onOpenSettings={onOpenSettings}
          />
        </AnalysisPromptsProvider>
      </ProviderSettingsProvider>
    </JobsProvider>
  );
  const view = render(ui(options.open ?? true));
  return {
    api,
    state,
    onClose,
    onChanged,
    onOpenSettings,
    rerender: (open: boolean, shownFile?: FileRecord) => view.rerender(ui(open, shownFile)),
  };
}

const callsOf = (api: ReturnType<typeof installFakeApi>, channel: string) =>
  api.calls.filter((c) => c.channel === channel);

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const tagBox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const modelSelect = () => screen.getByRole('combobox', { name: 'Tagging model' }) as HTMLSelectElement;

/** Waits until the provider has the settings and the model list. */
async function providerReady() {
  await waitFor(() =>
    expect(
      within(modelSelect())
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toContain('vision-b'),
  );
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
      providerId: CONFIGURED.id,
      mode: 'propose',
      force: true,
      promptId: TAG_DEFAULT.id,
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
      errorMessage: 'The provider could not be reached',
    });
    const { api } = setup(file, { stored: { proposal: null, job } });
    expect((await screen.findByRole('alert')).textContent).toContain('The provider could not be reached');
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
      expect(callsOf(api, 'analysis:getProposal').some((c) => (c.request as { fileId: string }).fileId === b.id)).toBe(
        true,
      ),
    );
    await waitFor(() => expect(button('Analyse').disabled).toBe(false));

    const readsOfA = callsOf(api, 'analysis:getProposal').filter(
      (c) => (c.request as { fileId: string }).fileId === a.id,
    ).length;
    await act(async () =>
      pending.resolve({
        enqueued: 0,
        skipped: { notFound: 0, notAnalysable: 1, alreadyQueued: 0, alreadyAnalysed: 0 },
      }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button('Analyse').disabled).toBe(false);
    expect(
      callsOf(api, 'analysis:getProposal').filter((c) => (c.request as { fileId: string }).fileId === a.id),
    ).toHaveLength(readsOfA);
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
    expect(callsOf(api, 'analysis:acceptProposal')[0]!.request).toEqual({
      fileId: file.id,
      createdAt: NOW,
      names: ['wood', 'table'],
    });
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
    expect(screen.getByRole('status').textContent).toContain('Running');

    state.stored = { proposal: proposalOf(), job: { ...job, status: 'succeeded' } };
    state.summary = { ...IDLE, succeeded: 1, changes: 1 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(tagBox('Wood').checked).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('an active batch job of the file shows its own state without Cancel or Analyse', async () => {
    const file = fileRecord();
    setup(file, { stored: { proposal: null, job: jobOf(file, { status: 'running', mode: 'apply' }) } });
    expect((await screen.findByRole('status')).textContent).toBe(BATCH_ANALYSIS_LABEL);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Analyse' })).toBeNull();
  });

  it('shows the tags a finished batch job applied, with Analyse again', async () => {
    vi.useFakeTimers();
    const file = fileRecord();
    const job = jobOf(file, { status: 'running', mode: 'apply', model: 'vision-b' });
    const tagged = {
      ...file,
      tags: [
        { name: 'chair', displayName: 'Chair', origin: 'ai' as const },
        { name: 'mine', displayName: 'Mine', origin: 'manual' as const },
      ],
    };
    const { api, state } = setup(file, {
      stored: { proposal: null, job },
      handlers: { 'files:list': () => ({ items: [tagged], total: 1 }) },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('status').textContent).toBe(BATCH_ANALYSIS_LABEL);
    expect(callsOf(api, 'files:list')).toHaveLength(0);

    state.stored = { proposal: null, job: { ...job, status: 'succeeded' } };
    state.summary = { ...IDLE, succeeded: 1, changes: 1 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    const applied = screen.getByRole('group', { name: APPLIED_TAGS_LABEL });
    expect(within(applied).getByText('Chair').closest('[title]')!.className).toContain(AI_CHIP);
    expect(within(applied).queryByText('Mine')).toBeNull();
    expect(screen.getByTitle('Model').textContent).toBe('vision-b');
    expect(screen.queryByRole('status')).toBeNull();
    expect(button(START_FORCE_LABEL)).toBeTruthy();
    expect(callsOf(api, 'files:list')[0]!.request).toEqual({
      scope: { kind: 'all' },
      ids: [file.id],
      offset: 0,
      limit: 1,
    });
  });

  it('a finished job of its own analysis reads no applied tags', async () => {
    const file = fileRecord();
    const { api } = setup(file, { stored: { proposal: null, job: jobOf(file, { status: 'succeeded' }) } });
    await providerReady();
    expect(screen.queryByRole('group', { name: APPLIED_TAGS_LABEL })).toBeNull();
    expect(callsOf(api, 'files:list')).toHaveLength(0);
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
    const { api, onOpenSettings, onClose } = setup(file, { provider: UNCONFIGURED });
    const settings = await screen.findByRole('button', { name: 'Settings' });
    expect(button('Analyse').disabled).toBe(true);
    expect(button('Analyse').title).toBe('No provider is configured');
    await userEvent.setup().click(settings);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(callsOf(api, 'analysis:enqueue')).toHaveLength(0);
  });

  it('no selectable model: Analyse is disabled with a title and Settings is offered', async () => {
    const file = fileRecord();
    setup(file, {
      provider: { ...CONFIGURED, taggingModel: null },
      models: { ok: true, models: [{ name: 'text-only', vision: false }] },
    });
    await waitFor(() => expect(button('Analyse').title).toBe(NO_VISION_MODEL));
    expect(button('Analyse').disabled).toBe(true);
    expect(button('Settings')).toBeTruthy();
  });

  it('Settings while an accept is in flight neither closes nor navigates', async () => {
    const file = fileRecord();
    const pending = deferred<IpcResponse<'analysis:acceptProposal'>>();
    const { api, onOpenSettings, onClose, onChanged } = setup(file, {
      stored: { proposal: proposalOf(), job: null },
      provider: { ...CONFIGURED, taggingModel: null },
      models: { ok: true, models: [{ name: 'text-only', vision: false }] },
      handlers: { 'analysis:acceptProposal': () => pending.promise },
    });
    const user = userEvent.setup();
    await screen.findByRole('checkbox', { name: 'Wood' });
    const settings = await screen.findByRole('button', { name: 'Settings' });
    await user.click(button('Accept'));
    await waitFor(() => expect(callsOf(api, 'analysis:acceptProposal')).toHaveLength(1));
    await user.click(settings);
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => pending.resolve({}));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('without a chosen model Analyse is disabled with a title', async () => {
    const file = fileRecord();
    setup(file, { provider: { ...CONFIGURED, taggingModel: null } });
    await providerReady();
    expect(button('Analyse').disabled).toBe(true);
    expect(button('Analyse').title).toBe(CHOOSE_MODEL);
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });

  it('a stored default the provider does not offer blocks Analyse with the reason', async () => {
    const file = fileRecord();
    setup(file, { provider: { ...CONFIGURED, taggingModel: 'gone-model' } });
    await providerReady();
    expect(button('Analyse').disabled).toBe(true);
    expect(button('Analyse').title).toBe(MODEL_NOT_LISTED);
  });

  it('while the settings load Analyse says so instead of "not configured"', async () => {
    const file = fileRecord();
    const settings = deferred<ProviderList>();
    setup(file, { handlers: { 'providers:list': () => settings.promise } });
    await waitFor(() => expect(button('Analyse').title).toBe(START_LOADING));
    expect(button('Analyse').title).not.toBe(JOB_ERROR_MESSAGES.provider_not_configured);
    await act(async () => settings.reject(fakeError('internal_error')));
    await waitFor(() => expect(button('Analyse').title).toBe(SETTINGS_LOAD_FAILED));
    expect(button('Settings')).toBeTruthy();
  });

  it('uses only the shared button styles', async () => {
    const file = fileRecord();
    setup(file, { stored: { proposal: proposalOf(), job: null } });
    await screen.findByRole('checkbox', { name: 'Wood' });
    await providerReady();
    for (const el of screen.getAllByRole('button'))
      expect([BUTTON, ICON_BUTTON, BUTTON_INLINE]).toContain(el.className);
  });
});

describe('AnalysisResultDialog prompt choice', () => {
  const promptSelect = () => screen.getByRole('combobox', { name: 'Prompt' }) as HTMLSelectElement;

  async function promptsListed() {
    await waitFor(() => expect(within(promptSelect()).queryAllByRole('option').length).toBeGreaterThan(1));
  }

  it('lists the tagging prompts only, below the model select', async () => {
    setup(fileRecord());
    await providerReady();
    await promptsListed();
    const options = within(promptSelect()).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((o) => o.textContent)).toEqual(['Default', 'Detail']);
    expect(options.map((o) => o.title)).toEqual(['Tag limit 15', 'Tag limit 30']);
    expect(modelSelect().compareDocumentPosition(promptSelect()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('preselects the tagging prompt used last', async () => {
    setup(fileRecord(), {
      handlers: fakeAnalysisPrompts({ prompts: PROMPTS, lastUsed: { tagging: TAG_DETAIL.id, imagePrompt: null } })
        .handlers,
    });
    await waitFor(() => expect(promptSelect().value).toBe(TAG_DETAIL.id));
  });

  it('preselects the first tagging prompt when the one used last is gone', async () => {
    setup(fileRecord(), {
      handlers: fakeAnalysisPrompts({
        prompts: PROMPTS,
        lastUsed: { tagging: nextId(), imagePrompt: IMAGE_DEFAULT.id },
      }).handlers,
    });
    await providerReady();
    await waitFor(() => expect(promptSelect().value).toBe(TAG_DEFAULT.id));
    expect(button('Analyse').disabled).toBe(false);
  });

  it('Analyse sends the chosen prompt, and reopening preselects it', async () => {
    const file = fileRecord();
    const { api, rerender } = setup(file);
    await providerReady();
    await promptsListed();
    const user = userEvent.setup();
    await user.selectOptions(promptSelect(), TAG_DETAIL.id);
    await user.click(button('Analyse'));
    await waitFor(() => expect(callsOf(api, 'analysis:enqueue')).toHaveLength(1));
    expect(callsOf(api, 'analysis:enqueue')[0]!.request).toMatchObject({ mode: 'propose', promptId: TAG_DETAIL.id });
    await waitFor(() => expect(button('Analyse').disabled).toBe(false));
    rerender(false);
    rerender(true);
    await providerReady();
    await waitFor(() => expect(promptSelect().value).toBe(TAG_DETAIL.id));
  });

  it('Analyse again sends the chosen prompt', async () => {
    const { api } = setup(fileRecord(), { stored: { proposal: proposalOf(), job: null } });
    await providerReady();
    await promptsListed();
    const user = userEvent.setup();
    await user.selectOptions(promptSelect(), TAG_DETAIL.id);
    await user.click(button('Analyse again'));
    await waitFor(() => expect(callsOf(api, 'analysis:enqueue')).toHaveLength(1));
    expect(callsOf(api, 'analysis:enqueue')[0]!.request).toMatchObject({ promptId: TAG_DETAIL.id });
  });

  it('a failed prompt load blocks Analyse with its own reason', async () => {
    setup(fileRecord(), {
      handlers: {
        'analysisPrompts:list': () => {
          throw fakeError('internal_error');
        },
      },
    });
    await providerReady();
    await waitFor(() => expect(button('Analyse').title).toBe(PROMPTS_LOAD_FAILED));
    expect(button('Analyse').disabled).toBe(true);
  });

  it('an Analyse refused with not_found shows the error and falls back to an existing prompt', async () => {
    const prompts = fakeAnalysisPrompts({ prompts: PROMPTS });
    const { api } = setup(fileRecord(), {
      handlers: {
        ...prompts.handlers,
        'analysis:enqueue': () => {
          prompts.state.prompts = prompts.state.prompts.filter((p) => p.id !== TAG_DETAIL.id);
          throw fakeError('not_found', 'The analysis prompt does not exist');
        },
      },
    });
    await providerReady();
    await promptsListed();
    const user = userEvent.setup();
    await user.selectOptions(promptSelect(), TAG_DETAIL.id);
    const lists = callsOf(api, 'analysisPrompts:list').length;
    await user.click(button('Analyse'));
    expect((await screen.findByRole('alert')).textContent).toBe('The analysis prompt does not exist');
    await waitFor(() => expect(promptSelect().value).toBe(TAG_DEFAULT.id));
    expect(callsOf(api, 'analysisPrompts:list').length).toBeGreaterThan(lists);
    expect(
      within(promptSelect())
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Default']);
  });

  it('shows the prompt name of a proposal beside its model', async () => {
    setup(fileRecord(), { stored: { proposal: proposalOf({ model: 'vision-b', promptName: 'Detail' }), job: null } });
    await screen.findByRole('checkbox', { name: 'Wood' });
    const model = screen.getByTitle('Model');
    const prompt = screen.getByTitle('Prompt');
    expect(model.textContent).toBe('vision-b');
    expect(prompt.textContent).toBe('Detail');
    expect(model.nextElementSibling).toBe(prompt);
  });

  it('the proposal key tells proposals of different prompts apart', () => {
    expect(proposalKey(proposalOf({ promptName: 'Detail' }))).not.toBe(proposalKey(proposalOf({ promptName: null })));
  });

  it('a proposal without a prompt name shows the model only', async () => {
    setup(fileRecord(), { stored: { proposal: proposalOf({ model: 'vision-b', promptName: null }), job: null } });
    await screen.findByRole('checkbox', { name: 'Wood' });
    expect(screen.getByTitle('Model').textContent).toBe('vision-b');
    expect(screen.queryByTitle('Prompt')).toBeNull();
    expect(screen.getByTitle('Model').nextElementSibling).toBeNull();
  });
});

describe('AnalysisResultDialog provider choice', () => {
  const RUNPOD = providerView({
    name: 'RunPod',
    baseUrl: 'https://pod.example.test',
    taggingModel: 'big-vision',
    promptModel: null,
  });
  const POD_MODELS: ListModelsResult = { ok: true, models: [{ name: 'big-vision', vision: true }] };
  const DOWN: ListModelsResult = { ok: false, code: 'provider_unreachable' };

  const providerSelect = () => screen.getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement;
  const optionTexts = (el: HTMLSelectElement) =>
    within(el)
      .getAllByRole('option')
      .map((o) => o.textContent);

  function two(lastUsedId: string | null, models: Record<string, ListModelsResult> = {}): FakeHandlers {
    return fakeProviders(
      { providers: [CONFIGURED, RUNPOD], lastUsedId },
      { [CONFIGURED.id]: MODELS, [RUNPOD.id]: POD_MODELS, ...models },
    ).handlers;
  }

  it('shows both entries with their states before the model select and preselects the one used last', async () => {
    setup(fileRecord(), { handlers: two(RUNPOD.id, { [CONFIGURED.id]: DOWN }) });
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
    const { api } = setup(fileRecord(), { handlers: two(null) });
    await providerReady();
    const refreshed = callsOf(api, 'providers:listModels')
      .map((c) => c.request)
      .filter((r) => (r as { refresh?: boolean }).refresh === true);
    expect(refreshed).toEqual([
      { providerId: CONFIGURED.id, refresh: true },
      { providerId: RUNPOD.id, refresh: true },
    ]);
  });

  it('switching the provider swaps the model list and preselects its tagging default', async () => {
    setup(fileRecord(), { handlers: two(CONFIGURED.id) });
    await providerReady();
    expect(modelSelect().value).toBe('vision-a');
    await userEvent.setup().selectOptions(providerSelect(), RUNPOD.id);
    await waitFor(() => expect(within(modelSelect()).queryByRole('option', { name: 'big-vision' })).toBeTruthy());
    expect(modelSelect().value).toBe('big-vision');
    expect(within(modelSelect()).queryByRole('option', { name: 'vision-b' })).toBeNull();
  });

  it('a provider that is down blocks Analyse with its reason; switching to the ready one enables it', async () => {
    setup(fileRecord(), { handlers: two(CONFIGURED.id, { [CONFIGURED.id]: DOWN }) });
    await waitFor(() => expect(button('Analyse').title).toBe(JOB_ERROR_MESSAGES.provider_unreachable));
    expect(button('Analyse').disabled).toBe(true);
    await userEvent.setup().selectOptions(providerSelect(), RUNPOD.id);
    await waitFor(() => expect(button('Analyse').disabled).toBe(false));
  });

  it('Analyse sends the selected provider and records it as used', async () => {
    const file = fileRecord();
    const { api, rerender } = setup(file, { handlers: two(CONFIGURED.id) });
    await providerReady();
    const user = userEvent.setup();
    await user.selectOptions(providerSelect(), RUNPOD.id);
    await waitFor(() => expect(button('Analyse').disabled).toBe(false));
    await user.click(button('Analyse'));
    await waitFor(() => expect(callsOf(api, 'analysis:enqueue')).toHaveLength(1));
    expect(callsOf(api, 'analysis:enqueue')[0]!.request).toEqual({
      target: { kind: 'files', fileIds: [file.id] },
      model: 'big-vision',
      providerId: RUNPOD.id,
      mode: 'propose',
      force: true,
      promptId: TAG_DEFAULT.id,
    });
    await waitFor(() => expect(probe!.list?.lastUsedId).toBe(RUNPOD.id));
    rerender(false);
    rerender(true, fileRecord());
    await waitFor(() => expect(providerSelect().value).toBe(RUNPOD.id));
  });

  it('another file starts again from the entry used last', async () => {
    const { rerender } = setup(fileRecord(), { handlers: two(CONFIGURED.id) });
    await providerReady();
    await userEvent.setup().selectOptions(providerSelect(), RUNPOD.id);
    expect(providerSelect().value).toBe(RUNPOD.id);
    rerender(true, fileRecord());
    await waitFor(() => expect(providerSelect().value).toBe(CONFIGURED.id));
    expect(modelSelect().value).toBe('vision-a');
  });

  it('an entry deleted while the dialog is open moves the selection to the remaining one', async () => {
    setup(fileRecord(), { handlers: two(CONFIGURED.id) });
    await providerReady();
    await userEvent.setup().selectOptions(providerSelect(), RUNPOD.id);
    await waitFor(() => expect(modelSelect().value).toBe('big-vision'));
    await act(async () => probe!.remove(RUNPOD.id));
    await waitFor(() => expect(providerSelect().value).toBe(CONFIGURED.id));
    expect(optionTexts(providerSelect())).toHaveLength(1);
    expect(modelSelect().value).toBe('vision-a');
  });

  it('without any entry the provider select shows no provider and Settings is offered', async () => {
    setup(fileRecord(), { provider: UNCONFIGURED });
    await screen.findByRole('button', { name: 'Settings' });
    expect(optionTexts(providerSelect())).toEqual(['No provider']);
    expect(button('Analyse').title).toBe(JOB_ERROR_MESSAGES.provider_not_configured);
  });
});
