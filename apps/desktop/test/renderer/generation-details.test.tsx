import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import type { FileRecord, Generation, GenerationFile, JobSummary } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { FileDetailDialog } from '../../src/renderer/src/components/FileDetailDialog';
import { Menu } from '../../src/renderer/src/components/Menu';
import { fileMenuItems } from '../../src/renderer/src/file-actions';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { StudioProvider, useStudio } from '../../src/renderer/src/studio-context';
import { TagsProvider } from '../../src/renderer/src/tags-context';
import { deferred, fakeProviders, installFakeApi, providerView, type FakeHandlers } from './fake-api';
import { fileRecord, nextId, trashedRecord } from './fixtures';

// The studio dialog is built in its own task; here it only shows which file it was opened on and
// hands a result id back through `onOpenFile`.
vi.mock('../../src/renderer/src/components/GenerationStudio', () => ({
  GenerationStudio: ({ file, onOpenFile }: { file: FileRecord; onOpenFile(fileId: string): void }) => (
    <div role="region" aria-label="Studio stub">
      <span>{file.originalName}</span>
      <button type="button" onClick={() => onOpenFile(RESULT.id)}>
        Open result
      </button>
    </div>
  ),
}));

const IDLE: JobSummary = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 0, paused: [] };
const VENICE = providerView({ kind: 'venice', name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1', taggingModel: null, promptModel: null, editModel: 'mock-edit' });
const SOURCE = fileRecord({ originalName: 'oak.png' });
const RESULT = fileRecord({ originalName: 'oak edit 1.png' });
const PROMPT = 'Turn the tree to face left';

function fileOf(record: FileRecord, p: Partial<GenerationFile> = {}): GenerationFile {
  return { fileId: record.id, name: record.originalName, sha256: 'a'.repeat(64), trashed: false, ...p };
}

function generation(p: Partial<Generation> = {}): Generation {
  return {
    id: nextId(),
    kind: 'edit',
    status: 'succeeded',
    errorCode: null,
    providerId: VENICE.id,
    providerName: 'Venice',
    providerKind: 'venice',
    model: 'mock-edit',
    prompt: PROMPT,
    parameters: { v: 1, aspectRatio: '16:9', resolution: '2K', safeMode: true },
    jobId: nextId(),
    jobStatus: 'succeeded',
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    inputs: [fileOf(SOURCE)],
    outputs: [fileOf(RESULT)],
    ...p,
  };
}

function install(handlers: FakeHandlers = {}, providers = [VENICE]) {
  return installFakeApi({
    ...fakeProviders({ providers }).handlers,
    'providers:listImageModels': () => ({ ok: true, models: [] }),
    'jobs:summary': () => IDLE,
    'tags:suggest': () => [],
    ...handlers,
  });
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <JobsProvider>
      <ProviderSettingsProvider>
        <TagsProvider>
          <StudioProvider>{children}</StudioProvider>
        </TagsProvider>
      </ProviderSettingsProvider>
    </JobsProvider>
  );
}

function MenuHost({ file }: { file: FileRecord }) {
  const studio = useStudio();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Menu label="More" items={fileMenuItems(file, { cover: null, onDetails: () => {}, studio, onError: setError })} />
      {error !== null && <p role="alert">{error}</p>}
    </>
  );
}

function DialogHost({ file }: { file: FileRecord }) {
  const studio = useStudio();
  const [shown, setShown] = useState(file);
  return (
    <FileDetailDialog
      file={shown}
      asset={null}
      actions={{ cover: null, onDetails: () => {}, studio }}
      roleControl={null}
      onFileChange={setShown}
      onMeasured={() => {}}
      list={null}
      onClose={() => {}}
    />
  );
}

const menuLabels = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'More' }));
  return user;
}

it('a complete PNG offers Generate from image and both upscales; an SVG and a trashed file offer none', async () => {
  install();
  const { unmount } = render(
    <Providers>
      <MenuHost file={fileRecord()} />
    </Providers>,
  );
  let user = await openMenu();
  expect(menuLabels()).toEqual(['Details', 'Open externally', 'Show in folder', 'Generate from image', 'Upscale 2×', 'Upscale 4×']);
  await user.keyboard('{Escape}');
  unmount();

  const svg = fileRecord({ originalName: 'logo.svg', mimeType: 'image/svg+xml', previewable: false, openable: false });
  const pending = fileRecord({ status: 'pending', sha256: null });
  for (const file of [svg, pending, trashedRecord()]) {
    const view = render(
      <Providers>
        <MenuHost file={file} />
      </Providers>,
    );
    user = await openMenu();
    expect(menuLabels()).not.toContain('Generate from image');
    expect(menuLabels()).not.toContain('Upscale 2×');
    expect(menuLabels()).not.toContain('Upscale 4×');
    await user.keyboard('{Escape}');
    view.unmount();
  }
});

it('without a Venice entry the studio entries are disabled with the reason as their title', async () => {
  const api = install({}, [providerView()]);
  render(
    <Providers>
      <MenuHost file={fileRecord()} />
    </Providers>,
  );
  await waitFor(() => expect(api.calls.some((c) => c.channel === 'providers:list')).toBe(true));
  const user = await openMenu();
  for (const name of ['Generate from image', 'Upscale 2×', 'Upscale 4×']) {
    const item = await screen.findByRole('menuitem', { name });
    await waitFor(() => expect(item.getAttribute('title')).toBe('Add an image provider in Settings first'));
    expect(item.getAttribute('aria-disabled') === 'true' || (item as HTMLButtonElement).disabled).toBe(true);
  }
  await user.keyboard('{Escape}');
  expect(api.calls.some((c) => c.channel === 'generations:start')).toBe(false);
});

it('Upscale 4× starts an upscale with scale 4 on the Venice entry', async () => {
  const file = fileRecord();
  const api = install({ 'generations:start': () => ({ ok: true, generation: generation({ kind: 'upscale' }) }) });
  render(
    <Providers>
      <MenuHost file={file} />
    </Providers>,
  );
  await waitFor(() => expect(api.calls.some((c) => c.channel === 'providers:listImageModels')).toBe(true));
  const user = await openMenu();
  await user.click(screen.getByRole('menuitem', { name: 'Upscale 4×' }));
  await waitFor(() => expect(api.calls.some((c) => c.channel === 'generations:start')).toBe(true));
  expect(api.calls.find((c) => c.channel === 'generations:start')?.request).toEqual({
    kind: 'upscale',
    fileId: file.id,
    providerId: VENICE.id,
    scale: 4,
  });
});

it('a refused upscale shows the provider message', async () => {
  install({ 'generations:start': () => ({ ok: false, code: 'provider_unreachable' }) });
  render(
    <Providers>
      <MenuHost file={fileRecord()} />
    </Providers>,
  );
  const user = await openMenu();
  await user.click(screen.getByRole('menuitem', { name: 'Upscale 2×' }));
  expect((await screen.findByRole('alert')).textContent).toBe('The provider could not be reached');
});

it('Generate from image opens the studio on that file', async () => {
  const file = fileRecord({ originalName: 'pine.png' });
  install();
  render(
    <Providers>
      <MenuHost file={file} />
    </Providers>,
  );
  const user = await openMenu();
  await user.click(screen.getByRole('menuitem', { name: 'Generate from image' }));
  const studio = await screen.findByRole('region', { name: 'Studio stub' });
  expect(within(studio).getByText('pine.png')).not.toBeNull();
});

/** `generations:forFile` for the source and its result, and `files:measure` as the lookup of either. */
function linkedHandlers(made: Generation): FakeHandlers {
  return {
    'generations:forFile': ({ fileId }) =>
      fileId === RESULT.id ? { madeBy: made, results: [] } : fileId === SOURCE.id ? { madeBy: null, results: [made] } : { madeBy: null, results: [] },
    'files:measure': ({ fileId }) => {
      const record = [SOURCE, RESULT].find((f) => f.id === fileId);
      if (record === undefined) throw new Error('unknown file');
      return record;
    },
  };
}

it('a result shows its source, provider, model, parameters and prompt; the link opens the source, which lists the result', async () => {
  const made = generation();
  install(linkedHandlers(made));
  render(
    <Providers>
      <DialogHost file={RESULT} />
    </Providers>,
  );
  const block = await screen.findByRole('region', { name: 'Generated from' });
  expect(within(block).getByText('Venice')).not.toBeNull();
  expect(within(block).getByText('mock-edit')).not.toBeNull();
  expect(within(block).getByText('16:9 · 2K · Safe mode')).not.toBeNull();
  expect(within(block).getByText(PROMPT)).not.toBeNull();

  const user = userEvent.setup();
  await user.click(within(block).getByRole('link', { name: 'oak.png' }));
  const sourceDialog = await screen.findByRole('dialog', { name: 'oak.png' });
  const results = await within(sourceDialog).findByRole('region', { name: 'Results' });
  await user.click(within(results).getByRole('link', { name: 'oak edit 1.png' }));
  // The link opens the result in that same dialog.
  await waitFor(() => expect(screen.getAllByRole('dialog', { name: 'oak edit 1.png' })).toHaveLength(2));
  expect(screen.queryByRole('dialog', { name: 'oak.png' })).toBeNull();
});

it('a purged source shows its name with the deleted mark and no link', async () => {
  const made = generation({ inputs: [fileOf(SOURCE, { fileId: null })] });
  install(linkedHandlers(made));
  render(
    <Providers>
      <DialogHost file={RESULT} />
    </Providers>,
  );
  const block = await screen.findByRole('region', { name: 'Generated from' });
  expect(within(block).getByText('oak.png')).not.toBeNull();
  expect(within(block).getByText('Deleted')).not.toBeNull();
  expect(within(block).queryByRole('link', { name: 'oak.png' })).toBeNull();
});

it('an upscale shows its scale and neither model nor prompt', async () => {
  const made = generation({ kind: 'upscale', model: null, prompt: null, parameters: { v: 1, scale: 4 } });
  install(linkedHandlers(made));
  render(
    <Providers>
      <DialogHost file={RESULT} />
    </Providers>,
  );
  const block = await screen.findByRole('region', { name: 'Generated from' });
  expect(within(block).getByText('Upscale 4×')).not.toBeNull();
  expect(within(block).queryByRole('button', { name: 'Copy prompt' })).toBeNull();
});

it('the copy button writes the prompt to the clipboard', async () => {
  install(linkedHandlers(generation()));
  render(
    <Providers>
      <DialogHost file={RESULT} />
    </Providers>,
  );
  const block = await screen.findByRole('region', { name: 'Generated from' });
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, 'writeText');
  await user.click(within(block).getByRole('button', { name: 'Copy prompt' }));
  expect(write).toHaveBeenCalledWith(PROMPT);
});

it('a file without generations shows neither block', async () => {
  const api = install();
  render(
    <Providers>
      <DialogHost file={fileRecord()} />
    </Providers>,
  );
  await waitFor(() => expect(api.calls.some((c) => c.channel === 'generations:forFile')).toBe(true));
  expect(screen.queryByRole('region', { name: 'Generated from' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Results' })).toBeNull();
});

it('a source whose asset cannot be read still opens, without its asset', async () => {
  const inAsset = { ...SOURCE, assetId: nextId(), role: 'reference' as const };
  const made = generation();
  install({
    ...linkedHandlers(made),
    'files:measure': ({ fileId }) => (fileId === SOURCE.id ? inAsset : RESULT),
    'assets:get': () => {
      throw new Error('gone');
    },
  });
  render(
    <Providers>
      <DialogHost file={RESULT} />
    </Providers>,
  );
  const block = await screen.findByRole('region', { name: 'Generated from' });
  await userEvent.setup().click(within(block).getByRole('link', { name: 'oak.png' }));
  expect(await screen.findByRole('dialog', { name: 'oak.png' })).not.toBeNull();
  expect(within(block).queryByRole('alert')).toBeNull();
});

it('a source that cannot be read shows the fixed message beside its link', async () => {
  const made = generation();
  install({
    ...linkedHandlers(made),
    'files:measure': () => {
      throw new Error('unreadable');
    },
  });
  render(
    <Providers>
      <DialogHost file={RESULT} />
    </Providers>,
  );
  const block = await screen.findByRole('region', { name: 'Generated from' });
  await userEvent.setup().click(within(block).getByRole('link', { name: 'oak.png' }));
  expect((await within(block).findByRole('alert')).textContent).toBe('This file could not be opened');
  expect(screen.queryByRole('dialog', { name: 'oak.png' })).toBeNull();
});

it('a second Upscale 4× while the first start is in flight sends nothing', async () => {
  const file = fileRecord();
  const start = deferred<{ ok: true; generation: Generation }>();
  const api = install({ 'generations:start': () => start.promise });
  render(
    <Providers>
      <MenuHost file={file} />
    </Providers>,
  );
  await waitFor(() => expect(api.calls.some((c) => c.channel === 'providers:list')).toBe(true));
  let user = await openMenu();
  await user.click(screen.getByRole('menuitem', { name: 'Upscale 4×' }));
  user = await openMenu();
  await user.click(screen.getByRole('menuitem', { name: 'Upscale 4×' }));
  const starts = () => api.calls.filter((c) => c.channel === 'generations:start');
  expect(starts()).toHaveLength(1);
  await act(async () => start.resolve({ ok: true, generation: generation({ kind: 'upscale' }) }));
  // Once the first start answered, another one may go out.
  user = await openMenu();
  await user.click(screen.getByRole('menuitem', { name: 'Upscale 4×' }));
  await waitFor(() => expect(starts()).toHaveLength(2));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('Open in the studio shows the result in the file detail dialog', async () => {
  install(linkedHandlers(generation()));
  render(
    <Providers>
      <MenuHost file={SOURCE} />
    </Providers>,
  );
  const user = await openMenu();
  await user.click(screen.getByRole('menuitem', { name: 'Generate from image' }));
  await user.click(await screen.findByRole('button', { name: 'Open result' }));
  const dialog = await screen.findByRole('dialog', { name: 'oak edit 1.png' });
  expect(await within(dialog).findByRole('region', { name: 'Generated from' })).not.toBeNull();
});
