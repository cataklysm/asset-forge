import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import type { FileRecord, Generation, GenerationFile, ImageModel, JobSummary } from '@assetforge/contracts';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { FileDetailDialog } from '../../src/renderer/src/components/FileDetailDialog';
import { Menu } from '../../src/renderer/src/components/Menu';
import { fileMenuItems } from '../../src/renderer/src/file-actions';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import { CLOSE_LABEL, STUDIO_TITLE } from '../../src/renderer/src/labels';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { StudioProvider, useStudio } from '../../src/renderer/src/studio-context';
import { TagsProvider } from '../../src/renderer/src/tags-context';
import { fakeProviders, installFakeApi, providerView } from './fake-api';
import { fileRecord, nextId } from './fixtures';

// The real studio inside the real provider: whichever of the studio and the linked file dialog was
// requested last must call `showModal()` last, so that it sits on top of the other one.

const IDLE: JobSummary = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 0, paused: [], pausedHosts: [] };
const VENICE = providerView({ kind: 'venice', name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1', taggingModel: null, promptModel: null, editModel: 'mock-edit', hasApiKey: true });
const MODEL: ImageModel = { name: 'mock-edit', aspectRatios: null, resolutions: null, defaultResolution: null, promptCharacterLimit: null, price: null };
const SOURCE = fileRecord({ originalName: 'oak.png' });
const RESULT = fileRecord({ originalName: 'oak edit 1.png' });

function fileOf(record: FileRecord): GenerationFile {
  return { fileId: record.id, name: record.originalName, sha256: 'a'.repeat(64), trashed: false };
}

const MADE: Generation = {
  id: nextId(),
  kind: 'edit',
  status: 'succeeded',
  errorCode: null,
  providerId: VENICE.id,
  providerName: VENICE.name,
  providerKind: 'venice',
  model: 'mock-edit',
  prompt: 'Turn the tree',
  parameters: { v: 1, aspectRatio: null, resolution: null, safeMode: true },
  jobId: nextId(),
  jobStatus: 'succeeded',
  createdAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:01:00.000Z',
  inputs: [fileOf(SOURCE)],
  outputs: [fileOf(RESULT)],
  promptId: null,
  promptVersionId: null,
  promptTitle: null,
  promptVersionNumber: null,
  promptVariables: null,
};

let showModal: MockInstance<HTMLDialogElement['showModal']>;

beforeEach(() => {
  window.localStorage.clear();
  showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  installFakeApi({
    ...fakeProviders({ providers: [VENICE], lastUsedImageId: VENICE.id }).handlers,
    'providers:listImageModels': () => ({ ok: true, models: [MODEL] }),
    'jobs:summary': () => IDLE,
    'tags:suggest': () => [],
    'generations:recentPrompts': () => ({ prompts: [] }),
    'generations:forFile': ({ fileId }) =>
      fileId === RESULT.id ? { madeBy: MADE, results: [] } : fileId === SOURCE.id ? { madeBy: null, results: [MADE] } : { madeBy: null, results: [] },
    'files:measure': ({ fileId }) => {
      const record = [SOURCE, RESULT].find((f) => f.id === fileId);
      if (record === undefined) throw new Error('unknown file');
      return record;
    },
  });
});

afterEach(() => {
  showModal.mockRestore();
});

function Providers({ children, onOpenPrompt }: { children: ReactNode; onOpenPrompt?: (id: string) => Promise<boolean> }) {
  return (
    <JobsProvider>
      <ProviderSettingsProvider>
        <TagsProvider>
          <StudioProvider onOpenPrompt={onOpenPrompt}>{children}</StudioProvider>
        </TagsProvider>
      </ProviderSettingsProvider>
    </JobsProvider>
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

function MenuHost({ file }: { file: FileRecord }) {
  const studio = useStudio();
  return <Menu label="More" items={fileMenuItems(file, { cover: null, onDetails: () => {}, studio, onError: () => {} })} />;
}

/** The dialog element that called `showModal()` last. */
const lastShown = () => showModal.mock.contexts.at(-1);
const studioDialog = (file: FileRecord) => screen.getByRole('dialog', { name: `${STUDIO_TITLE} ${file.originalName}` });

async function generateFrom(user: ReturnType<typeof userEvent.setup>, scope: HTMLElement) {
  await user.click(within(scope).getByRole('button', { name: 'More' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Generate from image' }));
}

async function openResultFromStudio(user: ReturnType<typeof userEvent.setup>, studio: HTMLElement) {
  await user.click(await within(studio).findByRole('button', { name: RESULT.originalName }));
  await user.click(within(studio).getByRole('button', { name: 'Open' }));
}

it('a result opened from the studio raises the linked dialog that was already open below it', async () => {
  render(
    <Providers>
      <DialogHost file={RESULT} />
    </Providers>,
  );
  const user = userEvent.setup();
  const host = await screen.findByRole('dialog', { name: RESULT.originalName });
  const block = await within(host).findByRole('region', { name: 'Generated from' });
  await user.click(within(block).getByRole('link', { name: SOURCE.originalName }));
  const linked = await screen.findByRole('dialog', { name: SOURCE.originalName });
  expect(lastShown()).toBe(linked);

  await generateFrom(user, linked);
  const studio = await waitFor(() => studioDialog(SOURCE));
  expect(lastShown()).toBe(studio);

  await openResultFromStudio(user, studio);
  await waitFor(() => expect(screen.getAllByRole('dialog', { name: RESULT.originalName })).toHaveLength(2));
  const raised = screen.getAllByRole('dialog', { name: RESULT.originalName }).find((d) => d !== host)!;
  await waitFor(() => expect(lastShown()).toBe(raised));
  expect((studioDialog(SOURCE) as HTMLDialogElement).open).toBe(true);

  // Closing the raised dialog returns focus to the studio below it.
  await user.click(within(raised).getByRole('button', { name: CLOSE_LABEL }));
  await waitFor(() => expect(screen.getAllByRole('dialog', { name: RESULT.originalName })).toHaveLength(1));
  expect(studioDialog(SOURCE).contains(document.activeElement)).toBe(true);
});

it('Generate from image in the linked dialog raises the studio that was already open below it', async () => {
  render(
    <Providers>
      <MenuHost file={SOURCE} />
    </Providers>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'More' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Generate from image' }));
  const studio = await waitFor(() => studioDialog(SOURCE));
  expect(lastShown()).toBe(studio);

  await openResultFromStudio(user, studio);
  const linked = await screen.findByRole('dialog', { name: RESULT.originalName });
  expect(lastShown()).toBe(linked);

  await generateFrom(user, linked);
  const raised = await waitFor(() => studioDialog(RESULT));
  await waitFor(() => expect(lastShown()).toBe(raised));
  expect((screen.getByRole('dialog', { name: RESULT.originalName }) as HTMLDialogElement).open).toBe(true);

  // Closing the raised studio returns focus to the linked dialog below it.
  await user.click(within(raised).getByRole('button', { name: CLOSE_LABEL }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: `${STUDIO_TITLE} ${RESULT.originalName}` })).toBeNull());
  expect(screen.getByRole('dialog', { name: RESULT.originalName }).contains(document.activeElement)).toBe(true);
});

async function openPromptFromLinked(onOpenPrompt: (id: string) => Promise<boolean>) {
  const made = { ...MADE, promptId: 'prompt-1', promptTitle: 'Turnaround', promptVersionNumber: 3, promptVariables: {} };
  installFakeApi({
    ...fakeProviders({ providers: [VENICE], lastUsedImageId: VENICE.id }).handlers,
    'providers:listImageModels': () => ({ ok: true, models: [MODEL] }),
    'jobs:summary': () => IDLE,
    'tags:suggest': () => [],
    'generations:recentPrompts': () => ({ prompts: [] }),
    'generations:forFile': ({ fileId }) => (fileId === RESULT.id ? { madeBy: made, results: [] } : { madeBy: null, results: [MADE] }),
    'files:measure': ({ fileId }) => [SOURCE, RESULT].find((f) => f.id === fileId)!,
  });
  render(
    <Providers onOpenPrompt={onOpenPrompt}>
      <MenuHost file={SOURCE} />
    </Providers>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'More' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Generate from image' }));
  const studio = await waitFor(() => studioDialog(SOURCE));
  await openResultFromStudio(user, studio);
  const linked = await screen.findByRole('dialog', { name: RESULT.originalName });
  const block = await within(linked).findByRole('region', { name: 'Generated from' });
  await user.click(within(block).getByRole('link', { name: 'Turnaround v3' }));
}

it('opening the library prompt closes the studio and the linked dialog once the navigation proceeds', async () => {
  const onOpenPrompt = vi.fn(() => Promise.resolve(true));
  await openPromptFromLinked(onOpenPrompt);
  expect(onOpenPrompt).toHaveBeenCalledWith('prompt-1');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('a declined leave guard keeps the studio and the linked dialog open', async () => {
  const onOpenPrompt = vi.fn(() => Promise.resolve(false));
  await openPromptFromLinked(onOpenPrompt);
  await waitFor(() => expect(onOpenPrompt).toHaveBeenCalledWith('prompt-1'));
  await act(async () => {});
  expect(studioDialog(SOURCE)).toBeTruthy();
  expect(screen.getByRole('dialog', { name: RESULT.originalName })).toBeTruthy();
});
