import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  buildPromptVariables,
  JOB_ERROR_MESSAGES,
  type PromptDetail,
  type PromptVersion,
  type FileRecord,
  type Generation,
  type ImageModel,
  type JobSummary,
  type ProviderView,
  type StartGeneration,
} from '@assetforge/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { GenerationStudio } from '../../src/renderer/src/components/GenerationStudio';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import {
  attachedPromptLabel,
  CLOSE_LABEL,
  DELETED_MARK,
  EDIT_PROMPT_TEXT_LABEL,
  LIBRARY_PROMPT_LABEL,
  NEWER_VERSION_TITLE,
  newVersionOfLabel,
  PROMPTS_LABEL,
  SAVE_LABEL,
  SAVE_TO_LIBRARY_LABEL,
  STUDIO_TITLE,
  VARIABLE_MISSING_TITLE,
  EDIT_MODEL_LABEL,
  GENERATE_BUTTON,
  GENERATION_STATUS_LABELS,
  NO_IMAGE_PROVIDER_TITLE,
  PROMPT_LABEL,
  RECENT_PROMPTS_LABEL,
  RESOLUTION_LABEL,
  ASPECT_LABEL,
  SAFE_MODE_LABEL,
  TRASHED_MARK,
  UPSCALES_LABEL,
} from '../../src/renderer/src/labels';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { StudioProvider, useStudio } from '../../src/renderer/src/studio-context';
import { SAFE_MODE_KEY } from '../../src/renderer/src/studio-state';
import { TagsProvider } from '../../src/renderer/src/tags-context';
import {
  deferred,
  fakeError,
  fakePrompts,
  fakeProviders,
  installFakeApi,
  promptDetail,
  providerView,
  type FakeHandlers,
} from './fake-api';
import { fileRecord, nextId } from './fixtures';

const MOCK_EDIT: ImageModel = {
  name: 'mock-edit',
  aspectRatios: ['1:1', '16:9', '9:16'],
  resolutions: ['1K', '2K', '4K'],
  defaultResolution: '1K',
  promptCharacterLimit: 1500,
  price: '$0.04 per image',
};
const MOCK_EDIT_BASIC: ImageModel = {
  name: 'mock-edit-basic',
  aspectRatios: null,
  resolutions: null,
  defaultResolution: null,
  promptCharacterLimit: null,
  price: null,
};

/** A model that states resolutions but no default one. */
const RES_ONLY: ImageModel = {
  name: 'res-only',
  aspectRatios: null,
  resolutions: ['1K', '2K'],
  defaultResolution: null,
  promptCharacterLimit: null,
  price: null,
};

const VENICE: ProviderView = providerView({
  kind: 'venice',
  name: 'Venice',
  baseUrl: 'https://api.venice.ai/api/v1',
  taggingModel: null,
  promptModel: null,
  editModel: 'mock-edit',
  hasApiKey: true,
});

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

function generation(source: FileRecord, p: Partial<Generation> = {}): Generation {
  return {
    id: nextId(),
    kind: 'edit',
    status: 'succeeded',
    errorCode: null,
    providerId: VENICE.id,
    providerName: VENICE.name,
    providerKind: 'venice',
    model: 'mock-edit',
    prompt: 'make it blue',
    parameters: { v: 1, aspectRatio: null, resolution: '1K', safeMode: true },
    jobId: nextId(),
    jobStatus: 'succeeded',
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    inputs: [{ fileId: source.id, name: source.originalName, sha256: source.sha256 ?? 'a'.repeat(64), trashed: false }],
    outputs: [{ fileId: nextId(), name: 'file edit 1.png', sha256: 'b'.repeat(64), trashed: false }],
    promptId: null,
    promptVersionId: null,
    promptTitle: null,
    promptVersionNumber: null,
    promptVariables: null,
    ...p,
  };
}

interface Options {
  /** The image provider entries; none by default is not wanted, so `[VENICE]` unless given. */
  providers?: ProviderView[];
  results?: Generation[];
  /** The generations made from other files, by file id. */
  byFile?: Record<string, Generation[]>;
  recent?: string[];
  /** The library prompts. */
  prompts?: PromptDetail[];
  handlers?: FakeHandlers;
}

function studioHandlers(
  file: FileRecord,
  options: Options,
  state: { results: Generation[]; byFile: Record<string, Generation[]>; summary: JobSummary },
): FakeHandlers {
  const providers = options.providers ?? [VENICE];
  return {
    ...fakeProviders({ providers, lastUsedImageId: providers[0]?.id ?? null }).handlers,
    ...fakePrompts(options.prompts ?? []).handlers,
    'providers:listImageModels': () => ({ ok: true, models: [MOCK_EDIT, MOCK_EDIT_BASIC, RES_ONLY] }),
    'jobs:summary': () => state.summary,
    'generations:forFile': ({ fileId }) => ({
      madeBy: null,
      results: structuredClone(fileId === file.id ? state.results : (state.byFile[fileId] ?? [])),
    }),
    'generations:recentPrompts': () => ({ prompts: options.recent ?? [] }),
    'generations:start': (request) => ({
      ok: true,
      generation: generation(file, {
        status: 'pending',
        jobStatus: 'queued',
        outputs: [],
        prompt: 'prompt' in request ? (request.prompt ?? null) : null,
      }),
    }),
    'generations:retry': ({ generationId }) => ({
      ...state.results.find((g) => g.id === generationId)!,
      status: 'pending',
    }),
    'generations:remove': () => ({}),
    'files:trashMany': ({ fileIds }) => ({ items: fileIds.map((fileId) => ({ fileId, file: null, error: null })) }),
    ...options.handlers,
  };
}

function setup(options: Options = {}) {
  const file = fileRecord({ originalName: 'file.png' });
  const state = { results: options.results ?? [], byFile: options.byFile ?? {}, summary: IDLE };
  const api = installFakeApi(studioHandlers(file, options, state));
  const onClose = vi.fn();
  const onOpenFile = vi.fn();
  const ui = (shown: FileRecord) => (
    <JobsProvider>
      <ProviderSettingsProvider>
        <GenerationStudio file={shown} onClose={onClose} onOpenFile={onOpenFile} />
      </ProviderSettingsProvider>
    </JobsProvider>
  );
  const view = render(ui(file));
  return { api, file, state, onClose, onOpenFile, rerender: (shown: FileRecord) => view.rerender(ui(shown)) };
}

const callsOf = (api: ReturnType<typeof installFakeApi>, channel: string) =>
  api.calls.filter((c) => c.channel === channel);

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const combobox = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const optionsOf = (select: HTMLSelectElement) =>
  within(select)
    .getAllByRole('option')
    .map((o) => o.textContent);
const promptBox = () => screen.getByRole('textbox', { name: PROMPT_LABEL }) as HTMLTextAreaElement;
const tileNames = () =>
  within(screen.getByRole('list', { name: 'Results' }))
    .queryAllByRole('listitem')
    .map((li) => li.getAttribute('aria-label'));

/** Waits until the edit models of the image provider are listed. */
async function modelsReady() {
  await waitFor(() => expect(optionsOf(combobox(EDIT_MODEL_LABEL))).toContain('mock-edit-basic'));
}

describe('GenerationStudio', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('without an image provider Generate is disabled with a title', async () => {
    const { api } = setup({ providers: [] });
    await waitFor(() => expect(callsOf(api, 'providers:list')).toHaveLength(1));
    await userEvent.setup().type(promptBox(), 'make it blue');
    await waitFor(() => expect(button(GENERATE_BUTTON).title).toBe(NO_IMAGE_PROVIDER_TITLE));
    expect(button(GENERATE_BUTTON).disabled).toBe(true);
  });

  it('Generate is disabled with a title while the prompt is empty', async () => {
    setup();
    await modelsReady();
    expect(button(GENERATE_BUTTON).disabled).toBe(true);
    expect(button(GENERATE_BUTTON).title).toBe('The prompt must have 1 to 8000 characters');
  });

  it('shows the price of a model in its option title', async () => {
    setup();
    await modelsReady();
    const option = within(combobox(EDIT_MODEL_LABEL)).getByRole('option', { name: 'mock-edit' }) as HTMLOptionElement;
    expect(option.title).toBe('$0.04 per image');
  });

  it('aspect and resolution selects show only the model values', async () => {
    setup();
    await modelsReady();
    expect(combobox(EDIT_MODEL_LABEL).value).toBe('mock-edit');
    expect(optionsOf(combobox(ASPECT_LABEL))).toEqual(['Default', '1:1', '16:9', '9:16']);
    expect(optionsOf(combobox(RESOLUTION_LABEL))).toEqual(['1K', '2K', '4K']);
    expect(combobox(RESOLUTION_LABEL).value).toBe('1K');

    await userEvent.setup().selectOptions(combobox(EDIT_MODEL_LABEL), 'mock-edit-basic');
    expect(screen.queryByRole('combobox', { name: ASPECT_LABEL })).toBeNull();
    expect(screen.queryByRole('combobox', { name: RESOLUTION_LABEL })).toBeNull();
  });

  it('Generate twice sends two starts and the prompt stays', async () => {
    const { api, file } = setup();
    await modelsReady();
    const user = userEvent.setup();
    await user.type(promptBox(), 'make it blue');
    await user.selectOptions(combobox(ASPECT_LABEL), '16:9');
    await user.selectOptions(combobox(RESOLUTION_LABEL), '2K');
    await user.click(button(GENERATE_BUTTON));
    await waitFor(() => expect(callsOf(api, 'generations:start')).toHaveLength(1));
    await waitFor(() => expect(button(GENERATE_BUTTON).disabled).toBe(false));
    await user.click(button(GENERATE_BUTTON));
    await waitFor(() => expect(callsOf(api, 'generations:start')).toHaveLength(2));
    const expected: StartGeneration = {
      kind: 'edit',
      fileId: file.id,
      providerId: VENICE.id,
      model: 'mock-edit',
      prompt: 'make it blue',
      aspectRatio: '16:9',
      resolution: '2K',
      safeMode: true,
    };
    expect(callsOf(api, 'generations:start').map((c) => c.request)).toEqual([expected, expected]);
    expect(promptBox().value).toBe('make it blue');
  });

  it('a start answered with a code shows its message in the title of Generate', async () => {
    setup({ handlers: { 'generations:start': () => ({ ok: false, code: 'provider_unauthorized' }) } });
    await modelsReady();
    const user = userEvent.setup();
    await user.type(promptBox(), 'make it blue');
    await user.click(button(GENERATE_BUTTON));
    await waitFor(() => expect(button(GENERATE_BUTTON).title).toBe(JOB_ERROR_MESSAGES.provider_unauthorized));
  });

  it('a recent prompt fills the prompt', async () => {
    setup({ recent: ['paint it red', 'make it blue'] });
    await modelsReady();
    await waitFor(() => expect(optionsOf(combobox(RECENT_PROMPTS_LABEL))).toContain('paint it red'));
    await userEvent.setup().selectOptions(combobox(RECENT_PROMPTS_LABEL), 'paint it red');
    expect(promptBox().value).toBe('paint it red');
  });

  it('shows tiles for queued, running, failed, trashed and deleted results', async () => {
    const file = fileRecord();
    const output = { fileId: nextId(), name: 'x.png', sha256: 'c'.repeat(64), trashed: false };
    const results = [
      generation(file, { status: 'pending', jobStatus: 'queued', outputs: [], createdAt: '2026-01-05T00:00:00.000Z' }),
      generation(file, { status: 'pending', jobStatus: 'running', outputs: [], createdAt: '2026-01-04T00:00:00.000Z' }),
      generation(file, {
        status: 'failed',
        errorCode: 'provider_content_refused',
        jobStatus: 'failed',
        outputs: [],
        createdAt: '2026-01-03T00:00:00.000Z',
      }),
      generation(file, { outputs: [{ ...output, trashed: true }], createdAt: '2026-01-02T00:00:00.000Z' }),
      generation(file, { outputs: [{ ...output, fileId: null }], createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const { api } = setup({ results });
    await waitFor(() =>
      expect(tileNames()).toEqual([
        GENERATION_STATUS_LABELS.pending,
        GENERATION_STATUS_LABELS.running,
        GENERATION_STATUS_LABELS.failed,
        TRASHED_MARK,
        DELETED_MARK,
      ]),
    );
    const failed = screen.getByRole('listitem', { name: GENERATION_STATUS_LABELS.failed });
    const mark = within(failed).getByText(GENERATION_STATUS_LABELS.failed);
    expect(mark.title).toBe(JOB_ERROR_MESSAGES.provider_content_refused);
    expect(failed.getAttribute('aria-description')).toBe(JOB_ERROR_MESSAGES.provider_content_refused);
    expect(within(screen.getByRole('listitem', { name: TRASHED_MARK })).getByText('x.png').title).toBe('x.png');
    expect(within(screen.getByRole('listitem', { name: DELETED_MARK })).getByText('x.png').title).toBe('x.png');
    const user = userEvent.setup();
    await user.click(within(failed).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(callsOf(api, 'generations:retry')).toHaveLength(1));
    expect(callsOf(api, 'generations:retry')[0]!.request).toEqual({ generationId: results[2]!.id });
    await user.click(within(failed).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(callsOf(api, 'generations:remove')).toHaveLength(1));
    expect(callsOf(api, 'generations:remove')[0]!.request).toEqual({ generationId: results[2]!.id });
    // Queued and running tiles offer nothing.
    expect(
      within(screen.getByRole('listitem', { name: GENERATION_STATUS_LABELS.pending })).queryAllByRole('button'),
    ).toEqual([]);
  });

  it('a cancelled result offers Retry and Remove', async () => {
    const file = fileRecord();
    setup({ results: [generation(file, { status: 'cancelled', jobStatus: 'cancelled', outputs: [] })] });
    const tile = await screen.findByRole('listitem', { name: GENERATION_STATUS_LABELS.cancelled });
    expect(
      within(tile)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Retry', 'Remove']);
  });

  it('opening on a file with results shows them newest first', async () => {
    const file = fileRecord();
    const older = generation(file, { createdAt: '2026-01-01T00:00:00.000Z' });
    older.outputs[0]!.name = 'older.png';
    const newer = generation(file, { createdAt: '2026-01-02T00:00:00.000Z' });
    newer.outputs[0]!.name = 'newer.png';
    const { api, file: source } = setup({ results: [older, newer] });
    await waitFor(() => expect(tileNames()).toEqual(['newer.png', 'older.png']));
    expect(callsOf(api, 'generations:forFile')[0]!.request).toEqual({ fileId: source.id });
  });

  it('a selected ready result opens, upscales and deletes', async () => {
    const file = fileRecord();
    const ready = generation(file);
    const outputId = ready.outputs[0]!.fileId!;
    const { api, onOpenFile } = setup({ results: [ready] });
    await modelsReady();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'file edit 1.png' }));

    await user.click(button('Open'));
    expect(onOpenFile).toHaveBeenCalledWith(outputId);

    await user.click(button('Upscale 4×'));
    await waitFor(() => expect(callsOf(api, 'generations:start')).toHaveLength(1));
    expect(callsOf(api, 'generations:start')[0]!.request).toEqual({
      kind: 'upscale',
      fileId: outputId,
      providerId: VENICE.id,
      scale: 4,
    });

    await user.click(button('Delete'));
    await waitFor(() => expect(callsOf(api, 'files:trashMany')).toHaveLength(1));
    expect(callsOf(api, 'files:trashMany')[0]!.request).toEqual({ fileIds: [outputId] });
  });

  it('Use settings fills the form', async () => {
    const file = fileRecord();
    const ready = generation(file, {
      model: 'mock-edit',
      prompt: 'paint it red',
      parameters: { v: 1, aspectRatio: '9:16', resolution: '4K', safeMode: false },
    });
    setup({ results: [ready] });
    await modelsReady();
    const user = userEvent.setup();
    await user.selectOptions(combobox(EDIT_MODEL_LABEL), 'mock-edit-basic');
    await user.click(await screen.findByRole('button', { name: 'file edit 1.png' }));
    await user.click(button('Use settings'));
    expect(promptBox().value).toBe('paint it red');
    expect(combobox(EDIT_MODEL_LABEL).value).toBe('mock-edit');
    expect(combobox(ASPECT_LABEL).value).toBe('9:16');
    expect(combobox(RESOLUTION_LABEL).value).toBe('4K');
    expect((screen.getByRole('checkbox', { name: SAFE_MODE_LABEL }) as HTMLInputElement).checked).toBe(false);
  });

  it('the safe mode toggle persists', async () => {
    setup();
    await modelsReady();
    const box = screen.getByRole('checkbox', { name: SAFE_MODE_LABEL }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.setup().click(box);
    expect(box.checked).toBe(false);
    expect(window.localStorage.getItem(SAFE_MODE_KEY)).toBe('false');
  });

  it('starts with the remembered safe mode', async () => {
    window.localStorage.setItem(SAFE_MODE_KEY, 'false');
    setup();
    await modelsReady();
    expect((screen.getByRole('checkbox', { name: SAFE_MODE_LABEL }) as HTMLInputElement).checked).toBe(false);
  });

  it('reloads the results when the jobs change', async () => {
    const file = fileRecord();
    const { api, state } = setup();
    await waitFor(() => expect(callsOf(api, 'generations:forFile')).toHaveLength(1));
    state.results = [generation(file)];
    state.summary = { ...IDLE, changes: 1 };
    await waitFor(() => expect(tileNames()).toEqual(['file edit 1.png']), { timeout: 5000 });
  });

  it('shows the upscales of the selected result with their actions', async () => {
    const file = fileRecord();
    const ready = generation(file);
    const outputId = ready.outputs[0]!.fileId!;
    const resultFile = { fileId: outputId, name: 'file edit 1.png', sha256: 'b'.repeat(64), trashed: false };
    const upscaled = generation(file, {
      kind: 'upscale',
      model: null,
      prompt: null,
      parameters: { v: 1, scale: 4 },
      inputs: [resultFile],
      outputs: [{ fileId: nextId(), name: 'file edit 1 4x.png', sha256: 'd'.repeat(64), trashed: false }],
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    const failed = generation(file, {
      kind: 'upscale',
      status: 'failed',
      errorCode: 'provider_rejected',
      jobStatus: 'failed',
      model: null,
      prompt: null,
      parameters: { v: 1, scale: 2 },
      inputs: [resultFile],
      outputs: [],
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    // An edit made from the result is not an upscale and stays out of the studio.
    const edit = generation(file, { inputs: [resultFile], createdAt: '2026-01-04T00:00:00.000Z' });
    edit.outputs[0]!.name = 'edit of edit.png';
    const { api, onOpenFile } = setup({ results: [ready], byFile: { [outputId]: [failed, upscaled, edit] } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'file edit 1.png' }));

    const list = await screen.findByRole('list', { name: UPSCALES_LABEL });
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole('listitem')
          .map((li) => li.getAttribute('aria-label')),
      ).toEqual(['file edit 1 4x.png', GENERATION_STATUS_LABELS.failed]),
    );
    expect(callsOf(api, 'generations:forFile').map((c) => c.request)).toContainEqual({ fileId: outputId });

    const tile = within(list).getByRole('listitem', { name: 'file edit 1 4x.png' });
    expect(
      within(tile)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Open', 'Delete']);
    await user.click(within(tile).getByRole('button', { name: 'Open' }));
    expect(onOpenFile).toHaveBeenCalledWith(upscaled.outputs[0]!.fileId);
    await user.click(within(tile).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(callsOf(api, 'files:trashMany')).toHaveLength(1));
    expect(callsOf(api, 'files:trashMany')[0]!.request).toEqual({ fileIds: [upscaled.outputs[0]!.fileId] });

    const failedTile = within(list).getByRole('listitem', { name: GENERATION_STATUS_LABELS.failed });
    await user.click(within(failedTile).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(callsOf(api, 'generations:retry')).toHaveLength(1));
    expect(callsOf(api, 'generations:retry')[0]!.request).toEqual({ generationId: failed.id });
  });

  it('an upscale start shows the new upscale under the selected result', async () => {
    const file = fileRecord();
    const ready = generation(file);
    const outputId = ready.outputs[0]!.fileId!;
    const queued = generation(file, {
      kind: 'upscale',
      status: 'pending',
      jobStatus: 'queued',
      model: null,
      prompt: null,
      parameters: { v: 1, scale: 2 },
      outputs: [],
    });
    const holder: { state?: { byFile: Record<string, Generation[]> } } = {};
    const { state } = setup({
      results: [ready],
      handlers: {
        'generations:start': () => {
          holder.state!.byFile[outputId] = [queued];
          return { ok: true, generation: queued };
        },
      },
    });
    holder.state = state;
    await modelsReady();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'file edit 1.png' }));
    await user.click(button('Upscale 2×'));
    const list = await screen.findByRole('list', { name: UPSCALES_LABEL });
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole('listitem')
          .map((li) => li.getAttribute('aria-label')),
      ).toEqual([GENERATION_STATUS_LABELS.pending]),
    );
  });

  it('Use settings of another entry selects that entry and its model', async () => {
    const other: ProviderView = { ...VENICE, id: nextId(), name: 'Venice B', editModel: 'mock-edit' };
    const file = fileRecord();
    const fromOther = generation(file, { providerId: other.id, providerName: other.name, model: 'mock-edit-basic' });
    setup({ providers: [VENICE, other], results: [fromOther] });
    await modelsReady();
    expect(combobox('Provider').value).toBe(VENICE.id);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'file edit 1.png' }));
    await user.click(button('Use settings'));
    await waitFor(() => expect(combobox('Provider').value).toBe(other.id));
    expect(combobox(EDIT_MODEL_LABEL).value).toBe('mock-edit-basic');
    expect(promptBox().value).toBe('make it blue');
  });

  it('Use settings of a result whose entry is gone keeps the selected entry and fills the rest', async () => {
    const file = fileRecord();
    const orphan = generation(file, {
      providerId: nextId(),
      providerName: 'Gone',
      model: 'mock-edit-basic',
      prompt: 'paint it red',
    });
    setup({ results: [orphan] });
    await modelsReady();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'file edit 1.png' }));
    await user.click(button('Use settings'));
    expect(promptBox().value).toBe('paint it red');
    expect(combobox('Provider').value).toBe(VENICE.id);
    expect(combobox(EDIT_MODEL_LABEL).value).toBe('mock-edit');
    // Nothing waits for the gone entry: a later model choice stands.
    await user.selectOptions(combobox(EDIT_MODEL_LABEL), 'res-only');
    expect(combobox(EDIT_MODEL_LABEL).value).toBe('res-only');
  });

  it('another file starts from a fresh state', async () => {
    const made = generation(fileRecord());
    const { rerender } = setup({
      handlers: {
        'generations:start': () => ({ ok: false, code: 'provider_rejected' }),
        'generations:forFile': ({ fileId }) => ({ madeBy: null, results: fileId === 'other' ? [] : [made] }),
      },
    });
    await modelsReady();
    const user = userEvent.setup();
    await user.type(promptBox(), 'make it blue');
    await user.click(button(GENERATE_BUTTON));
    await waitFor(() => expect(button(GENERATE_BUTTON).title).toBe(JOB_ERROR_MESSAGES.provider_rejected));
    await user.click(await screen.findByRole('button', { name: 'file edit 1.png' }));
    expect(screen.getByRole('button', { name: 'Use settings' })).toBeTruthy();

    rerender(fileRecord({ id: 'other', originalName: 'other.png' }));
    await waitFor(() => expect(tileNames()).toEqual([]));
    expect(promptBox().value).toBe('');
    expect(button(GENERATE_BUTTON).title).toBe('The prompt must have 1 to 8000 characters');
    expect(screen.queryByRole('button', { name: 'Use settings' })).toBeNull();
  });

  it('a field change clears the start error', async () => {
    setup({ handlers: { 'generations:start': () => ({ ok: false, code: 'provider_rejected' }) } });
    await modelsReady();
    const user = userEvent.setup();
    await user.type(promptBox(), 'make it blue');
    await user.click(button(GENERATE_BUTTON));
    await waitFor(() => expect(button(GENERATE_BUTTON).title).toBe(JOB_ERROR_MESSAGES.provider_rejected));
    await user.type(promptBox(), '!');
    expect(button(GENERATE_BUTTON).title).toBe('');
  });

  it('a failed results load clears on the next successful read', async () => {
    let fail = true;
    const { state } = setup({
      handlers: {
        'generations:forFile': () => {
          if (fail) throw fakeError('internal_error', 'Unexpected error');
          return { madeBy: null, results: [] };
        },
      },
    });
    await screen.findByRole('alert');
    fail = false;
    state.summary = { ...IDLE, changes: 1 };
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 5000 });
  });

  it('keeps the form usable while a start is in flight', async () => {
    const pending = deferred<{ ok: false; code: 'provider_rejected' }>();
    setup({ handlers: { 'generations:start': () => pending.promise } });
    await modelsReady();
    const user = userEvent.setup();
    await user.type(promptBox(), 'make it blue');
    await user.click(button(GENERATE_BUTTON));
    expect(button(GENERATE_BUTTON).disabled).toBe(true);
    expect(promptBox().disabled).toBe(false);
    expect(combobox(EDIT_MODEL_LABEL).disabled).toBe(false);
    expect((screen.getByRole('checkbox', { name: SAFE_MODE_LABEL }) as HTMLInputElement).disabled).toBe(false);
    pending.resolve({ ok: false, code: 'provider_rejected' });
    await waitFor(() => expect(button(GENERATE_BUTTON).disabled).toBe(false));
  });

  it('offers Default resolution for a model without a default one', async () => {
    setup();
    await modelsReady();
    const user = userEvent.setup();
    await user.selectOptions(combobox(EDIT_MODEL_LABEL), 'res-only');
    expect(optionsOf(combobox(RESOLUTION_LABEL))).toEqual(['Default', '1K', '2K']);
    await user.selectOptions(combobox(RESOLUTION_LABEL), '2K');
    expect(optionsOf(combobox(RESOLUTION_LABEL))).toEqual(['Default', '1K', '2K']);
    await user.selectOptions(combobox(RESOLUTION_LABEL), 'Default');
    expect(combobox(RESOLUTION_LABEL).value).toBe('');
  });

  it('focuses the prompt on opening and names no region after the dialog', async () => {
    setup();
    await modelsReady();
    expect(document.activeElement).toBe(promptBox());
    expect(screen.queryByRole('region', { name: 'Studio' })).toBeNull();
  });
});

function versionOf(content: string, number: number, defaults: Record<string, string> = {}): PromptVersion {
  return {
    id: nextId(),
    number,
    content,
    variables: buildPromptVariables(content, defaults),
    createdAt: `2026-11-2${number}T08:00:00.000Z`,
  };
}

/** `A {{view}} of {{who}}` with the default `front` for view and none for who. */
const hero = () => promptDetail({ title: 'Hero shot', content: 'A {{view}} of {{who}}', defaults: { view: 'front' } });

const textbox = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;

/** Opens the library picker and chooses the prompt titled `title`. */
async function pickPrompt(user: ReturnType<typeof userEvent.setup>, title: string, number = 1) {
  await user.click(button(LIBRARY_PROMPT_LABEL));
  const picker = await screen.findByRole('dialog', { name: PROMPTS_LABEL });
  await user.click(await within(picker).findByText(title));
  await screen.findByText(attachedPromptLabel(title, number));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: PROMPTS_LABEL })).toBeNull());
}

const startRequests = (api: ReturnType<typeof installFakeApi>) =>
  callsOf(api, 'generations:start').map((c) => c.request as StartGeneration);

describe('GenerationStudio with library prompts', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('a picked prompt shows its variables with their defaults and blocks Generate until all are filled', async () => {
    const prompt = hero();
    const { api, file } = setup({ prompts: [prompt] });
    await modelsReady();
    const user = userEvent.setup();
    await pickPrompt(user, 'Hero shot');
    expect(textbox('view').value).toBe('front');
    expect(textbox('who').value).toBe('');
    expect(promptBox().readOnly).toBe(true);
    expect(promptBox().value).toBe('A front of {{who}}');
    expect(button(GENERATE_BUTTON).disabled).toBe(true);
    expect(button(GENERATE_BUTTON).title).toBe(VARIABLE_MISSING_TITLE);

    await user.type(textbox('who'), 'a hero');
    expect(promptBox().value).toBe('A front of a hero');
    expect(button(GENERATE_BUTTON).disabled).toBe(false);
    await user.click(button(GENERATE_BUTTON));
    await waitFor(() => expect(startRequests(api)).toHaveLength(1));
    const request = startRequests(api)[0]!;
    expect(request).toEqual({
      kind: 'edit',
      fileId: file.id,
      providerId: VENICE.id,
      model: 'mock-edit',
      promptVersionId: prompt.currentVersion.id,
      variables: { view: 'front', who: 'a hero' },
      resolution: '1K',
      safeMode: true,
    });
    expect('prompt' in request).toBe(false);
  });

  it('a resolved text over the model limit blocks Generate with the prompt length reason', async () => {
    setup({ prompts: [promptDetail({ title: 'Long', content: '{{who}}' })] });
    await modelsReady();
    const user = userEvent.setup();
    await pickPrompt(user, 'Long');
    await user.click(textbox('who'));
    await user.paste('x'.repeat(1501));
    expect(button(GENERATE_BUTTON).title).toBe('The prompt is longer than this model allows');
  });

  it('a value typed for a variable is prefilled for the same name in another prompt, also in a studio opened anew', async () => {
    const a = fileRecord({ originalName: 'a.png' });
    const b = fileRecord({ originalName: 'b.png' });
    const state = { results: [], byFile: {}, summary: IDLE };
    installFakeApi(
      studioHandlers(
        a,
        { prompts: [hero(), promptDetail({ title: 'Close-up', content: 'Close-up of the {{View}}' })] },
        state,
      ),
    );
    function Opener() {
      const studio = useStudio();
      return (
        <>
          {[a, b].map((f) => (
            <button key={f.id} type="button" onClick={() => studio.open(f)}>
              {`open ${f.originalName}`}
            </button>
          ))}
        </>
      );
    }
    const wrap = (children: ReactNode) => (
      <JobsProvider>
        <ProviderSettingsProvider>
          <TagsProvider>
            <StudioProvider onOpenPrompt={async () => true}>{children}</StudioProvider>
          </TagsProvider>
        </ProviderSettingsProvider>
      </JobsProvider>
    );
    render(wrap(<Opener />));
    const user = userEvent.setup();
    await user.click(button('open a.png'));
    await screen.findByRole('dialog', { name: `${STUDIO_TITLE} a.png` });
    await modelsReady();
    await pickPrompt(user, 'Hero shot');
    await user.clear(textbox('view'));
    await user.type(textbox('view'), 'side');
    await pickPrompt(user, 'Close-up');
    expect(textbox('View').value).toBe('side');

    await user.click(button(CLOSE_LABEL));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `${STUDIO_TITLE} a.png` })).toBeNull());
    await user.click(button('open b.png'));
    await screen.findByRole('dialog', { name: `${STUDIO_TITLE} b.png` });
    await modelsReady();
    await pickPrompt(user, 'Close-up');
    expect(textbox('View').value).toBe('side');
  });

  it('Edit text makes the resolved text a free prompt and the next start sends only the prompt', async () => {
    const { api } = setup({ prompts: [hero()] });
    await modelsReady();
    const user = userEvent.setup();
    await pickPrompt(user, 'Hero shot');
    await user.type(textbox('who'), 'a hero');
    await user.click(button(EDIT_PROMPT_TEXT_LABEL));
    expect(promptBox().readOnly).toBe(false);
    expect(promptBox().value).toBe('A front of a hero');
    expect(screen.queryByRole('textbox', { name: 'who' })).toBeNull();
    await user.type(promptBox(), ' now');
    await user.click(button(GENERATE_BUTTON));
    await waitFor(() => expect(startRequests(api)).toHaveLength(1));
    const request = startRequests(api)[0]!;
    expect(request).toMatchObject({ prompt: 'A front of a hero now' });
    expect('promptVersionId' in request || 'variables' in request).toBe(false);
  });

  it('Save to library after Edit text offers a new version of the prompt and attaches the form to it', async () => {
    const prompt = hero();
    const { api } = setup({ prompts: [prompt] });
    await modelsReady();
    const user = userEvent.setup();
    await pickPrompt(user, 'Hero shot');
    await user.click(button(EDIT_PROMPT_TEXT_LABEL));
    await user.clear(promptBox());
    await user.type(promptBox(), 'A {{{{view}} at night');
    await user.click(button(SAVE_TO_LIBRARY_LABEL));
    const dialog = await screen.findByRole('dialog', { name: SAVE_TO_LIBRARY_LABEL });
    const asVersion = (await within(dialog).findByRole('radio', {
      name: newVersionOfLabel('Hero shot'),
    })) as HTMLInputElement;
    expect(asVersion.checked).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: SAVE_LABEL }));
    await waitFor(() =>
      expect(callsOf(api, 'prompts:saveVersion').map((c) => c.request)).toEqual([
        {
          promptId: prompt.id,
          baseVersionId: prompt.currentVersion.id,
          content: 'A {{view}} at night',
          defaults: { view: 'front', who: '' },
        },
      ]),
    );
    expect(callsOf(api, 'prompts:create')).toEqual([]);
    await screen.findByText(attachedPromptLabel('Hero shot', 2));
    expect(screen.queryByRole('dialog', { name: SAVE_TO_LIBRARY_LABEL })).toBeNull();
    expect(textbox('view').value).toBe('front');
    expect(promptBox().readOnly).toBe(true);
    expect(promptBox().value).toBe('A front at night');
  });

  it('Save to library of a typed prompt creates a prompt, shows a refusal inside the dialog and attaches the form', async () => {
    const { api } = setup({ prompts: [promptDetail({ title: 'Taken' })] });
    await modelsReady();
    const user = userEvent.setup();
    await user.type(promptBox(), 'make it blue');
    await user.click(button(SAVE_TO_LIBRARY_LABEL));
    const dialog = await screen.findByRole('dialog', { name: SAVE_TO_LIBRARY_LABEL });
    expect(within(dialog).queryAllByRole('radio')).toEqual([]);
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    await user.type(title, 'taken');
    await user.click(within(dialog).getByRole('button', { name: SAVE_LABEL }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('This title is already used');
    await user.clear(title);
    await user.type(title, 'Blue');
    await user.click(within(dialog).getByRole('button', { name: SAVE_LABEL }));
    await screen.findByText(attachedPromptLabel('Blue', 1));
    expect(
      callsOf(api, 'prompts:create')
        .map((c) => c.request)
        .at(-1),
    ).toEqual({
      title: 'Blue',
      description: '',
      content: 'make it blue',
      defaults: {},
    });
    expect(callsOf(api, 'prompts:saveVersion')).toEqual([]);
    expect(promptBox().readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: SAVE_TO_LIBRARY_LABEL })).toBeNull();
  });

  it('a recent prompt forgets the origin of a detached text', async () => {
    const { api } = setup({ prompts: [hero()], recent: ['paint it red'] });
    await modelsReady();
    const user = userEvent.setup();
    await pickPrompt(user, 'Hero shot');
    await user.click(button(EDIT_PROMPT_TEXT_LABEL));
    await waitFor(() => expect(optionsOf(combobox(RECENT_PROMPTS_LABEL))).toContain('paint it red'));
    await user.selectOptions(combobox(RECENT_PROMPTS_LABEL), 'paint it red');
    await user.click(button(SAVE_TO_LIBRARY_LABEL));
    const dialog = await screen.findByRole('dialog', { name: SAVE_TO_LIBRARY_LABEL });
    expect(within(dialog).queryAllByRole('radio')).toEqual([]);
    expect(callsOf(api, 'prompts:get')).toHaveLength(1);
  });

  it('Use settings attaches the version of a library result with its values; a newer version loads on a click', async () => {
    const older = versionOf('A {{view}} of {{who}}', 1);
    const current = versionOf('A {{view}} of {{who}} at night', 2);
    const prompt = promptDetail({ title: 'Hero shot', versions: [current, older] });
    const file = fileRecord();
    const made = generation(file, {
      prompt: 'A back of a villain',
      promptId: prompt.id,
      promptVersionId: older.id,
      promptTitle: 'Hero shot',
      promptVersionNumber: 1,
      promptVariables: { view: 'back', who: 'a villain' },
    });
    setup({ prompts: [prompt], results: [made] });
    await modelsReady();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'file edit 1.png' }));
    await user.click(button('Use settings'));
    const titleButton = await screen.findByRole('button', { name: attachedPromptLabel('Hero shot', 1) });
    expect(titleButton.title).toBe(NEWER_VERSION_TITLE);
    expect(textbox('view').value).toBe('back');
    expect(textbox('who').value).toBe('a villain');
    expect(promptBox().value).toBe('A back of a villain');

    await user.click(titleButton);
    await screen.findByText(attachedPromptLabel('Hero shot', 2));
    expect(screen.queryByRole('button', { name: attachedPromptLabel('Hero shot', 2) })).toBeNull();
    expect(textbox('view').value).toBe('back');
    expect(promptBox().value).toBe('A back of a villain at night');
  });

  it('Use settings on a free result fills the free text and loads no prompt', async () => {
    const { api } = setup({ prompts: [hero()], results: [generation(fileRecord(), { prompt: 'paint it red' })] });
    await modelsReady();
    const user = userEvent.setup();
    await pickPrompt(user, 'Hero shot');
    await user.click(await screen.findByRole('button', { name: 'file edit 1.png' }));
    await user.click(button('Use settings'));
    expect(promptBox().readOnly).toBe(false);
    expect(promptBox().value).toBe('paint it red');
    expect(screen.queryByText(attachedPromptLabel('Hero shot', 1))).toBeNull();
    expect(callsOf(api, 'prompts:get')).toHaveLength(1);
  });

  it('a late answer of an earlier Use settings is ignored', async () => {
    const prompt = hero();
    const file = fileRecord();
    const fromLibrary = generation(file, {
      createdAt: '2026-01-02T00:00:00.000Z',
      prompt: 'A side of a hero',
      promptId: prompt.id,
      promptVersionId: prompt.currentVersion.id,
      promptTitle: 'Hero shot',
      promptVersionNumber: 1,
      promptVariables: { view: 'side', who: 'a hero' },
    });
    fromLibrary.outputs[0]!.name = 'library.png';
    const free = generation(file, { prompt: 'paint it red' });
    free.outputs[0]!.name = 'free.png';
    const pending = deferred<PromptDetail>();
    setup({ prompts: [prompt], results: [fromLibrary, free], handlers: { 'prompts:get': () => pending.promise } });
    await modelsReady();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'library.png' }));
    await user.click(button('Use settings'));
    await user.click(screen.getByRole('button', { name: 'free.png' }));
    await user.click(button('Use settings'));
    await act(async () => pending.resolve(structuredClone(prompt)));
    expect(promptBox().value).toBe('paint it red');
    expect(screen.queryByText(attachedPromptLabel('Hero shot', 1))).toBeNull();
  });

  it('a not_found start shows the message and keeps the prompt and its values', async () => {
    setup({
      prompts: [hero()],
      handlers: {
        'generations:start': () => {
          throw fakeError('not_found', 'This prompt version does not exist');
        },
      },
    });
    await modelsReady();
    const user = userEvent.setup();
    await pickPrompt(user, 'Hero shot');
    await user.type(textbox('who'), 'a hero');
    await user.click(button(GENERATE_BUTTON));
    await waitFor(() => expect(button(GENERATE_BUTTON).title).toBe('This prompt version does not exist'));
    expect(screen.getByText(attachedPromptLabel('Hero shot', 1))).toBeTruthy();
    expect(textbox('view').value).toBe('front');
    expect(textbox('who').value).toBe('a hero');
  });
});

describe('GenerationStudio raised over the linked file dialog', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  /** The real provider with buttons that open the studio and show the source in the linked dialog. */
  function setupRaise(options: Options = {}) {
    const file = fileRecord({ originalName: 'file.png' });
    const state = { results: options.results ?? [], byFile: options.byFile ?? {}, summary: IDLE };
    const api = installFakeApi({
      ...studioHandlers(file, options, state),
      'tags:suggest': () => [],
      'files:measure': () => file,
      ...options.handlers,
    });
    function Opener() {
      const studio = useStudio();
      return (
        <>
          <button type="button" onClick={() => studio.open(file)}>
            open studio
          </button>
          <button type="button" onClick={() => void studio.openFile(file.id)}>
            open linked
          </button>
        </>
      );
    }
    render(
      <JobsProvider>
        <ProviderSettingsProvider>
          <TagsProvider>
            <StudioProvider onOpenPrompt={async () => true}>
              <Opener />
            </StudioProvider>
          </TagsProvider>
        </ProviderSettingsProvider>
      </JobsProvider>,
    );
    const studioName = `${STUDIO_TITLE} ${file.originalName}`;
    const user = userEvent.setup();
    return {
      api,
      file,
      user,
      async open() {
        await user.click(button('open studio'));
        await screen.findByRole('dialog', { name: studioName });
        await modelsReady();
      },
      /** Shows the linked dialog over the studio, then raises the studio again (a remount). */
      async raise() {
        await user.click(button('open linked'));
        await screen.findByRole('dialog', { name: file.originalName });
        await user.click(button('open studio'));
        await screen.findByRole('dialog', { name: studioName });
        await modelsReady();
      },
      async close() {
        await user.click(
          within(screen.getByRole('dialog', { name: studioName })).getByRole('button', { name: CLOSE_LABEL }),
        );
        await waitFor(() => expect(screen.queryByRole('dialog', { name: studioName })).toBeNull());
      },
    };
  }

  it('keeps Generate disabled and the typed prompt while a start is in flight across a raise', async () => {
    const pending = deferred<{ ok: false; code: 'provider_rejected' }>();
    const s = setupRaise({ handlers: { 'generations:start': () => pending.promise } });
    await s.open();
    await s.user.type(promptBox(), 'make it blue');
    await s.user.click(button(GENERATE_BUTTON));
    expect(button(GENERATE_BUTTON).disabled).toBe(true);

    await s.raise();
    expect(promptBox().value).toBe('make it blue');
    expect(button(GENERATE_BUTTON).disabled).toBe(true);
    await s.user.click(button(GENERATE_BUTTON));
    expect(startRequests(s.api)).toHaveLength(1);

    await act(async () => pending.resolve({ ok: false, code: 'provider_rejected' }));
    await waitFor(() => expect(button(GENERATE_BUTTON).disabled).toBe(false));
  });

  it('shows a start that fails after a raise in the new instance, and clears it on the next start and on close', async () => {
    const message = JOB_ERROR_MESSAGES.provider_rejected;
    const pending = deferred<{ ok: false; code: 'provider_rejected' }>();
    let answer = () => pending.promise;
    const s = setupRaise({ handlers: { 'generations:start': () => answer() } });
    await s.open();
    await s.user.type(promptBox(), 'make it blue');
    await s.user.click(button(GENERATE_BUTTON));

    await s.raise();
    await act(async () => pending.resolve({ ok: false, code: 'provider_rejected' }));
    await waitFor(() => expect(button(GENERATE_BUTTON).title).toBe(message));

    // The next start clears it while it runs.
    const next = deferred<{ ok: false; code: 'provider_rejected' }>();
    answer = () => next.promise;
    await s.user.click(button(GENERATE_BUTTON));
    expect(button(GENERATE_BUTTON).title).not.toBe(message);
    await act(async () => next.resolve({ ok: false, code: 'provider_rejected' }));
    await waitFor(() => expect(button(GENERATE_BUTTON).title).toBe(message));

    await s.close();
    await s.open();
    expect(button(GENERATE_BUTTON).title).not.toBe(message);
  });

  it('shows nothing on the next open for a start that failed after the studio was closed', async () => {
    const message = JOB_ERROR_MESSAGES.provider_rejected;
    const pending = deferred<{ ok: false; code: 'provider_rejected' }>();
    const s = setupRaise({ handlers: { 'generations:start': () => pending.promise } });
    await s.open();
    await s.user.type(promptBox(), 'make it blue');
    await s.user.click(button(GENERATE_BUTTON));
    await s.close();
    await act(async () => pending.resolve({ ok: false, code: 'provider_rejected' }));

    await s.open();
    await s.user.type(promptBox(), 'make it red');
    expect(button(GENERATE_BUTTON).title).not.toBe(message);
  });

  it('keeps the attached library prompt with its values and the chosen model across a raise', async () => {
    const s = setupRaise({ prompts: [hero()] });
    await s.open();
    await s.user.selectOptions(combobox(EDIT_MODEL_LABEL), 'mock-edit-basic');
    await pickPrompt(s.user, 'Hero shot');
    await s.user.type(textbox('who'), 'a hero');

    await s.raise();
    expect(screen.getByText(attachedPromptLabel('Hero shot', 1))).toBeTruthy();
    expect(textbox('view').value).toBe('front');
    expect(textbox('who').value).toBe('a hero');
    expect(combobox(EDIT_MODEL_LABEL).value).toBe('mock-edit-basic');
  });

  it('starts from a fresh form after the studio was closed', async () => {
    const s = setupRaise();
    await s.open();
    await s.user.type(promptBox(), 'make it blue');
    await s.close();
    await s.open();
    expect(promptBox().value).toBe('');
  });
});
