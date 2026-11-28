import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type ReactNode } from 'react';
import type { FileRecord, Generation, IpcResponse } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import type { ViewerList } from '../../src/renderer/src/components/FileBrowser';
import { FileDetailDialog } from '../../src/renderer/src/components/FileDetailDialog';
import type { FileActionContext } from '../../src/renderer/src/file-actions';
import { useFileDialog } from '../../src/renderer/src/hooks/useFileDialog';
import { NO_FILE_FILTERS, type InboxListState } from '../../src/renderer/src/list-state';
import { InboxScreen } from '../../src/renderer/src/screens/InboxScreen';
import { TagsProvider } from '../../src/renderer/src/tags-context';
import { deferred, fakeError, fakeFileOrigins, installFakeApi, type FakeHandlers } from './fake-api';
import { formatDateTime } from '../../src/renderer/src/format';
import { fileRecord, nextId, tagOf, trashedRecord } from './fixtures';
import { renameHandlers, renameThroughDialog } from './rename-flow';

const ASSET = { id: nextId(), name: 'Oak tree', tags: [tagOf('Nature')] };
const ACTIONS: FileActionContext = { cover: null, onDetails: () => {} };

function Harness(props: {
  file: FileRecord;
  asset?: typeof ASSET | null;
  onOpenAsset?(id: string): void;
  onMeasured?(fileId: string, size: { width: number; height: number }): void;
  actions?: FileActionContext;
  list?: ViewerList | null;
  roleControl?: ReactNode;
}) {
  const [file, setFile] = useState(props.file);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Opener
      </button>
      {open && (
        <FileDetailDialog
          file={file}
          asset={props.asset === undefined ? ASSET : props.asset}
          actions={props.actions ?? ACTIONS}
          roleControl={props.roleControl === undefined ? <span>role control</span> : props.roleControl}
          onFileChange={setFile}
          onMeasured={(id, size) => {
            props.onMeasured?.(id, size);
            setFile((current) => (current.id === id ? { ...current, ...size } : current));
          }}
          onOpenAsset={props.onOpenAsset}
          list={props.list ?? null}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function install(handlers: FakeHandlers = {}) {
  return installFakeApi({ 'tags:suggest': () => [], ...handlers });
}

async function openDialog() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Opener' }));
  return user;
}

it('focus starts on Close; Esc closes and focus returns to the opener', async () => {
  install();
  render(<Harness file={fileRecord({ assetId: ASSET.id, role: 'reference' })} />);
  const user = await openDialog();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Close' })).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Opener' }));
});

it('adding an image tag calls files:addTag and shows the returned tags', async () => {
  const file = fileRecord({ assetId: ASSET.id, role: 'reference' });
  const api = install({ 'files:addTag': () => ({ ...file, tags: [tagOf('Bark', 'manual')] }) });
  render(<Harness file={file} />);
  const user = await openDialog();
  await user.type(screen.getByRole('combobox', { name: 'Add image tag' }), 'Bark{Enter}');
  await screen.findByRole('button', { name: 'Remove Bark' });
  expect(api.calls.find((c) => c.channel === 'files:addTag')?.request).toEqual({ fileId: file.id, name: 'Bark' });
});

it('asset tags are read-only and labelled separately from image tags', async () => {
  install();
  render(<Harness file={fileRecord({ assetId: ASSET.id, role: 'reference' })} />);
  await openDialog();
  const assetTags = screen.getByLabelText('Asset tags');
  expect(within(assetTags).queryByRole('button')).toBeNull();
  expect(within(assetTags).getByText('Nature')).not.toBeNull();
  expect(screen.getByRole('group', { name: 'Image tags' })).not.toBeNull();
  expect((screen.getByRole('combobox', { name: 'Add image tag' }) as HTMLInputElement).placeholder).toBe('+ Add tag');
});

it('a failed import shows its error and no tag row', async () => {
  install();
  render(<Harness file={fileRecord({ status: 'failed', error: 'Import failed', previewable: false })} asset={null} />);
  await openDialog();
  expect(screen.getByRole('alert').textContent).toBe('Import failed');
  expect(screen.queryByRole('group', { name: 'Image tags' })).toBeNull();
});

it('More offers Open externally only for openable complete files', async () => {
  const api = install({ 'files:openExternal': () => null });
  const { unmount } = render(<Harness file={fileRecord({ openable: true })} asset={null} />);
  let user = await openDialog();
  await user.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.queryByRole('menuitem', { name: 'Details' })).toBeNull();
  await user.click(screen.getByRole('menuitem', { name: 'Open externally' }));
  expect(api.calls.some((c) => c.channel === 'files:openExternal')).toBe(true);
  unmount();

  render(<Harness file={fileRecord({ openable: false })} asset={null} />);
  user = await openDialog();
  await user.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.queryByRole('menuitem', { name: 'Open externally' })).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Show in folder' })).not.toBeNull();
});

it('a failing shell action shows the error inline', async () => {
  install({
    'files:showInFolder': () => {
      throw new Error('x');
    },
  });
  render(<Harness file={fileRecord()} asset={null} />);
  const user = await openDialog();
  await user.click(screen.getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('menuitem', { name: 'Show in folder' }));
  await screen.findByRole('alert');
});

it('More offers the studio entries the host passes; a failing upscale shows its message in the dialog', async () => {
  install();
  const studio = {
    open: vi.fn(),
    openFile: vi.fn(),
    upscale: vi.fn(async () => {
      throw new Error('The provider could not be reached');
    }),
    blocked: null,
    openPrompt: vi.fn(),
    recallVariable: () => undefined,
    rememberVariables: () => {},
  };
  const file = fileRecord();
  render(<Harness file={file} asset={null} actions={{ ...ACTIONS, studio }} />);
  const user = await openDialog();
  await user.click(screen.getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('menuitem', { name: 'Generate from image' }));
  expect(studio.open).toHaveBeenCalledWith(file);
  await user.click(screen.getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('menuitem', { name: 'Upscale 2×' }));
  expect(studio.upscale).toHaveBeenCalledWith(file, 2);
  expect((await screen.findByRole('alert')).textContent).toBe('The provider could not be reached');
});

it('without a role control the dialog shows no Role or Assign section', async () => {
  install();
  render(<Harness file={fileRecord()} asset={null} roleControl={null} />);
  await openDialog();
  expect(screen.queryByRole('heading', { name: 'Assign' })).toBeNull();
});

it('the asset link follows to the asset', async () => {
  install();
  const onOpenAsset = vi.fn();
  render(<Harness file={fileRecord({ assetId: ASSET.id, role: 'reference' })} onOpenAsset={onOpenAsset} />);
  const user = await openDialog();
  await user.click(screen.getByRole('link', { name: 'Oak tree' }));
  expect(onOpenAsset).toHaveBeenCalledWith(ASSET.id);
});

it('without a handler the asset name is plain text, not a link', async () => {
  install();
  render(<Harness file={fileRecord({ assetId: ASSET.id, role: 'reference' })} />);
  await openDialog();
  expect(screen.queryByRole('link', { name: 'Oak tree' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Asset' }).nextElementSibling?.textContent).toBe('Oak tree');
});

const headings = (level: number) => screen.getAllByRole('heading', { level }).map((h) => h.textContent);

it('the header shows the file name and the asset name; the dialog keeps its combined name', async () => {
  install();
  const file = fileRecord({ assetId: ASSET.id, role: 'reference', originalName: 'a-very-long-file-name.png' });
  const { unmount } = render(<Harness file={file} />);
  await openDialog();
  const title = 'a-very-long-file-name.png | Oak tree';
  expect(screen.getByRole('dialog', { name: title })).toBeTruthy();
  const heading = screen.getByRole('heading', { level: 2 });
  expect(heading.getAttribute('title')).toBe(title);
  expect(heading.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']));
  const parts = [...heading.children].filter((child) => child.textContent !== '');
  expect(parts.map((part) => part.textContent)).toEqual(['a-very-long-file-name.png', 'Oak tree']);
  for (const part of parts) expect(part.className.split(/\s+/)).toContain('truncate');
  expect(heading.parentElement!.contains(screen.getByRole('button', { name: 'Close' }))).toBe(true);
  unmount();

  render(<Harness file={file} asset={null} />);
  await openDialog();
  expect(screen.getByRole('dialog', { name: 'a-very-long-file-name.png' })).toBeTruthy();
  expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('a-very-long-file-name.png');
});

it('the details column shows its sections in order with one heading style', async () => {
  install();
  const { unmount } = render(
    <Harness file={fileRecord({ assetId: ASSET.id, role: 'reference' })} onOpenAsset={() => {}} />,
  );
  await openDialog();
  expect(headings(3)).toEqual(['Image details', 'Role', 'Image tags', 'Asset', 'Asset tags']);
  const styles = new Set(screen.getAllByRole('heading', { level: 3 }).map((h) => h.className));
  expect(styles.size).toBe(1);
  expect(screen.getByText('role control')).toBeTruthy();
  const more = screen.getByRole('button', { name: 'More' });
  expect(more.textContent).toBe('More');
  expect(more.querySelector('svg')).not.toBeNull();
  unmount();

  // An asset without tags has no "Asset tags" heading; the inbox shows "Assign" and no asset part.
  render(<Harness file={fileRecord({ assetId: ASSET.id, role: 'reference' })} asset={{ ...ASSET, tags: [] }} />);
  await openDialog();
  expect(headings(3)).toEqual(['Image details', 'Role', 'Image tags', 'Asset']);
});

it('the inbox shows Assign, and a non-image file is described as a file', async () => {
  install();
  const { unmount } = render(<Harness file={fileRecord()} asset={null} />);
  await openDialog();
  expect(headings(3)).toEqual(['Image details', 'Assign', 'Image tags']);
  unmount();

  const text = fileRecord({ originalName: 'notes.txt', mimeType: 'text/plain', previewable: false, kind: 'document' });
  render(<Harness file={text} asset={null} />);
  await openDialog();
  expect(headings(3)).toEqual(['File details', 'Assign', 'File tags']);
  expect(screen.getByRole('group', { name: 'File tags' })).toBeTruthy();
});

it('image tags sit below their heading, marked by the image icon, with the add input after the chips', async () => {
  install();
  const file = fileRecord({ assetId: ASSET.id, role: 'reference', tags: [tagOf('Bark', 'manual')] });
  render(<Harness file={file} />);
  await openDialog();
  const group = screen.getByRole('group', { name: 'Image tags' });
  const heading = screen.getByRole('heading', { name: 'Image tags' });
  expect(group.contains(heading)).toBe(false);
  expect(heading.parentElement!.querySelector('svg')).not.toBeNull();
  const input = within(group).getByRole('combobox', { name: 'Add image tag' });
  const chip = within(group).getByRole('button', { name: 'Remove Bark' });
  expect(chip.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(input.className.split(/\s+/)).not.toContain('w-40');
});

it('on-stage arrows step through the list like the header buttons', async () => {
  install();
  const files = fileList(3);
  const list = listOf(files, 0);
  const { unmount } = render(<Harness file={files[0]!} asset={null} list={list} />);
  const user = await openDialog();
  const previous = screen.getByRole('button', { name: 'Previous file' });
  const next = screen.getByRole('button', { name: 'Next file' });
  expect(previous.title).toBe('Previous file (←)');
  expect(next.title).toBe('Next file (→)');
  expect((previous as HTMLButtonElement).disabled).toBe(true);
  await user.click(next);
  expect(list.show).toHaveBeenCalledWith(1);
  // Overlays beside the scrolling stage, not inside it.
  expect(screen.getByRole('region', { name: 'Image' }).contains(next)).toBe(false);
  unmount();

  const last = listOf(files, 2);
  render(<Harness file={files[2]!} asset={null} list={last} />);
  await openDialog();
  expect((screen.getByRole('button', { name: 'Next file' }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Previous file' }));
  expect(last.show).toHaveBeenCalledWith(1);
});

it('cover and detach menu items carry their tooltips', async () => {
  install();
  const file = fileRecord({ assetId: ASSET.id, role: 'reference' });
  const actions: FileActionContext = {
    cover: { isEffective: false, isChosen: false },
    onDetails: () => {},
    onSetCover: () => {},
    onDetach: () => {},
  };
  render(<Harness file={file} actions={actions} />);
  const user = await openDialog();
  await user.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getByRole('menuitem', { name: 'Use as cover' }).getAttribute('title')).toBe(
    'Show this image as the asset cover',
  );
  expect(screen.getByRole('menuitem', { name: 'Detach' }).getAttribute('title')).toBe(
    'The file is kept and moves to the inbox',
  );
});

it('the chosen cover item offers the automatic cover with its tooltip', async () => {
  install();
  const file = fileRecord({ assetId: ASSET.id, role: 'reference' });
  const actions: FileActionContext = {
    cover: { isEffective: true, isChosen: true },
    onDetails: () => {},
    onSetCover: () => {},
  };
  render(<Harness file={file} actions={actions} />);
  const user = await openDialog();
  await user.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getByRole('menuitem', { name: 'Use automatic cover' }).getAttribute('title')).toBe(
    'Return to the first image as the cover',
  );
});

it('the More menu opens upwards from the left edge so it stays inside the panel', async () => {
  install();
  render(<Harness file={fileRecord({ assetId: ASSET.id, role: 'reference' })} />);
  const user = await openDialog();
  await user.click(screen.getByRole('button', { name: 'More' }));
  const classes = screen.getByRole('menu', { name: 'More' }).className.split(/\s+/);
  expect(classes).toEqual(expect.arrayContaining(['left-0', 'bottom-full']));
  expect(classes).not.toContain('right-0');
});

function detailValue(name: string): string | null | undefined {
  const details = screen.getByRole('region', { name: 'Details' });
  return within(details).getByText(name).nextElementSibling?.textContent;
}

const measureCalls = (api: ReturnType<typeof install>) => api.calls.filter((c) => c.channel === 'files:measure');

it('Dimensions follow Format and show the stored size, or a dash while unknown', async () => {
  install();
  const { unmount } = render(<Harness file={fileRecord({ width: 1600, height: 2000 })} asset={null} />);
  await openDialog();
  expect(detailValue('Dimensions')).toBe('1600 × 2000 px');
  const labels = [...screen.getByRole('region', { name: 'Details' }).querySelectorAll('dt')].map(
    (dt) => dt.textContent,
  );
  expect(labels).toEqual(['Filename', 'Format', 'Dimensions', 'Size', 'Imported']);
  expect(detailValue('Format')).toBe('PNG');
  const format = within(screen.getByRole('region', { name: 'Details' })).getByText('Format').nextElementSibling!;
  expect(format.getAttribute('title')).toBe('image/png');
  unmount();

  install({ 'files:measure': () => deferred<FileRecord>().promise });
  render(<Harness file={fileRecord()} asset={null} />);
  await openDialog();
  expect(detailValue('Dimensions')).toBe('–');
});

it('a previewable file without dimensions is measured once and handed to onMeasured', async () => {
  const file = fileRecord();
  const measured = { ...file, width: 1600, height: 2000 };
  const api = install({ 'files:measure': () => measured });
  const onMeasured = vi.fn();
  render(<Harness file={file} asset={null} onMeasured={onMeasured} />);
  await openDialog();
  await waitFor(() => expect(onMeasured).toHaveBeenCalledWith(file.id, { width: 1600, height: 2000 }));
  expect(detailValue('Dimensions')).toBe('1600 × 2000 px');
  expect(measureCalls(api).map((c) => c.request)).toEqual([{ fileId: file.id }]);
  expect(onMeasured).toHaveBeenCalledTimes(1);
});

it('a rejected measurement shows nothing and is not repeated', async () => {
  const file = fileRecord();
  const api = install({
    'files:measure': () => {
      throw fakeError('internal_error');
    },
    'files:addTag': () => ({ ...file, tags: [tagOf('Bark', 'manual')] }),
  });
  const onMeasured = vi.fn();
  render(<Harness file={file} asset={null} onMeasured={onMeasured} />);
  const user = await openDialog();
  await waitFor(() => expect(measureCalls(api)).toHaveLength(1));
  await user.type(screen.getByRole('combobox', { name: 'Add image tag' }), 'Bark{Enter}');
  await screen.findByRole('button', { name: 'Remove Bark' });
  expect(measureCalls(api)).toHaveLength(1);
  expect(onMeasured).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(detailValue('Dimensions')).toBe('–');
});

it('files with dimensions and non-image files are not measured; a non-image keeps the placeholder', async () => {
  const api = install();
  const { unmount } = render(<Harness file={fileRecord({ width: 1600, height: 2000 })} asset={null} />);
  await openDialog();
  expect(screen.getByRole('toolbar', { name: 'Viewer' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Image' })).toBeTruthy();
  unmount();

  render(
    <Harness
      file={fileRecord({
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        previewable: false,
        openable: true,
        kind: 'document',
      })}
      asset={null}
    />,
  );
  await openDialog();
  // Once as the format in the details, once in the placeholder.
  expect(detailValue('Format')).toBe('TXT');
  expect(screen.getAllByText('TXT')).toHaveLength(2);
  expect(screen.queryByRole('toolbar')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Image' })).toBeNull();
  expect(measureCalls(api)).toHaveLength(0);
});

function listOf(files: FileRecord[], index: number): ViewerList {
  return {
    total: files.length,
    index,
    slot: (i) => (files[i] === undefined ? { kind: 'placeholder' } : { kind: 'loaded', item: files[i] }),
    show: vi.fn(),
    want: vi.fn(),
  };
}

const fileList = (count: number) =>
  Array.from({ length: count }, (_, i) => fileRecord({ originalName: `File ${i}.png` }));

it('the header counts the position in the list and Next shows the following file', async () => {
  install();
  const files = fileList(14);
  const list = listOf(files, 1);
  render(<Harness file={files[1]!} asset={null} list={list} />);
  const user = await openDialog();
  expect(screen.getByText('2 / 14')).toBeTruthy();
  const previous = screen.getByRole('button', { name: 'Previous file (←)' });
  const next = screen.getByRole('button', { name: 'Next file (→)' });
  expect(previous.title).toBe('Previous file (←)');
  expect(next.title).toBe('Next file (→)');
  await user.click(next);
  expect(list.show).toHaveBeenCalledWith(2);
  await user.click(previous);
  expect(list.show).toHaveBeenCalledWith(0);
});

it('Previous is disabled on the first file and Next on the last', async () => {
  install();
  const files = fileList(3);
  const { unmount } = render(<Harness file={files[0]!} asset={null} list={listOf(files, 0)} />);
  await openDialog();
  expect(screen.getByText('1 / 3')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Previous file (←)' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Next file (→)' }) as HTMLButtonElement).disabled).toBe(false);
  unmount();

  render(<Harness file={files[2]!} asset={null} list={listOf(files, 2)} />);
  await openDialog();
  expect(screen.getByText('3 / 3')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Previous file (←)' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: 'Next file (→)' }) as HTMLButtonElement).disabled).toBe(true);
});

it('a text file in the list is shown with its placeholder', async () => {
  install();
  const text = fileRecord({
    originalName: 'notes.txt',
    mimeType: 'text/plain',
    previewable: false,
    openable: true,
    kind: 'document',
  });
  const files = [fileRecord({ originalName: 'File 0.png' }), text];
  render(<Harness file={text} asset={null} list={listOf(files, 1)} />);
  await openDialog();
  expect(screen.getByText('2 / 2')).toBeTruthy();
  // Once in the details, once in the placeholder, once in the film strip.
  expect(screen.getAllByText('TXT')).toHaveLength(3);
  expect(screen.queryByRole('region', { name: 'Image' })).toBeNull();
});

it('without a list there is no counter and no arrows', async () => {
  install();
  render(<Harness file={fileRecord()} asset={null} />);
  await openDialog();
  expect(screen.queryByText(/^\d+ \/ \d+$/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Previous file (←)' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Next file (→)' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Previous file' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Next file' })).toBeNull();
});

it('the viewer keys act on the dialog and do nothing for a file without a stage', async () => {
  install();
  const files = fileList(3);
  const list = listOf(files, 1);
  const { unmount } = render(<Harness file={files[1]!} asset={null} list={list} />);
  const user = await openDialog();
  await user.keyboard('{ArrowRight}');
  expect(list.show).toHaveBeenCalledWith(2);
  await user.keyboard('{ArrowLeft}');
  expect(list.show).toHaveBeenCalledWith(0);
  unmount();

  const text = fileRecord({ originalName: 'notes.txt', mimeType: 'text/plain', previewable: false, kind: 'document' });
  const fs = stubFullscreen();
  try {
    render(<Harness file={text} asset={null} />);
    const second = await openDialog();
    await second.keyboard('f+r');
    expect(fs.requestFullscreen).not.toHaveBeenCalled();
  } finally {
    fs.restore();
  }
});

function stubFullscreen() {
  let current: Element | null = null;
  const requestFullscreen = vi.fn(function (this: HTMLElement) {
    current = this;
    return Promise.resolve();
  });
  const exitFullscreen = vi.fn(() => {
    current = null;
    return Promise.resolve();
  });
  HTMLElement.prototype.requestFullscreen = requestFullscreen;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => current });
  document.exitFullscreen = exitFullscreen;
  return {
    requestFullscreen,
    exitFullscreen,
    changed: () => document.dispatchEvent(new Event('fullscreenchange')),
    restore: () => {
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      delete (document as { exitFullscreen?: unknown }).exitFullscreen;
    },
  };
}

it('the fullscreen button requests fullscreen on the wrapper and follows fullscreenchange', async () => {
  install();
  const fs = stubFullscreen();
  try {
    render(<Harness file={fileRecord()} asset={null} />);
    const user = await openDialog();
    const button = await screen.findByRole('button', { name: 'Fullscreen' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await user.click(button);
    expect(fs.requestFullscreen).toHaveBeenCalledTimes(1);
    const wrapper = fs.requestFullscreen.mock.contexts[0] as HTMLElement;
    expect(wrapper.contains(screen.getByRole('toolbar'))).toBe(true);
    fs.changed();
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'));
  } finally {
    fs.restore();
  }
});

it('Esc leaves fullscreen first and closes the dialog the second time', async () => {
  install();
  const fs = stubFullscreen();
  try {
    render(<Harness file={fileRecord()} asset={null} />);
    const user = await openDialog();
    await user.click(await screen.findByRole('button', { name: 'Fullscreen' }));
    fs.changed();
    await user.keyboard('{Escape}');
    expect(fs.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    fs.changed();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close' })).toBeNull());
    expect(fs.exitFullscreen).toHaveBeenCalledTimes(1);
  } finally {
    fs.restore();
  }
});

it('a rejected requestFullscreen leaves the button unpressed', async () => {
  install();
  const fs = stubFullscreen();
  fs.requestFullscreen.mockImplementation(() => Promise.reject(new Error('denied')));
  try {
    render(<Harness file={fileRecord()} asset={null} />);
    const user = await openDialog();
    const button = await screen.findByRole('button', { name: 'Fullscreen' });
    await user.click(button);
    expect(fs.requestFullscreen).toHaveBeenCalled();
    expect(button.getAttribute('aria-pressed')).toBe('false');
  } finally {
    fs.restore();
  }
});

it('typing ArrowRight in the image tag input or in the open More menu does not step on', async () => {
  install();
  const files = fileList(3);
  const list = listOf(files, 1);
  render(<Harness file={files[1]!} asset={null} list={list} />);
  const user = await openDialog();
  await user.type(screen.getByRole('combobox', { name: 'Add image tag' }), '{ArrowRight}');
  expect(list.show).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getByRole('menu', { name: 'More' })).toBeTruthy();
  await user.keyboard('{ArrowRight}');
  expect(list.show).not.toHaveBeenCalled();
});

/** A host as the file browsers wire it: the list delivers its own records, measured or not. */
function Browsing({ files }: { files: FileRecord[] }) {
  const container = useRef<HTMLDivElement>(null);
  const detail = useFileDialog(container);
  const [index, setIndex] = useState(0);
  const list: ViewerList = {
    total: files.length,
    index,
    slot: (i) => (files[i] === undefined ? { kind: 'placeholder' } : { kind: 'loaded', item: files[i] }),
    show: (i) => {
      const next = files[i];
      if (next === undefined) return;
      setIndex(i);
      detail.show(next);
    },
    want: () => {},
  };
  return (
    <div ref={container}>
      <button type="button" onClick={() => detail.open(files[0]!)}>
        Opener
      </button>
      {detail.file !== null && (
        <FileDetailDialog
          file={detail.file}
          asset={null}
          actions={ACTIONS}
          roleControl={<span>role control</span>}
          onFileChange={detail.update}
          onMeasured={detail.setDimensions}
          list={list}
          onClose={detail.close}
        />
      )}
    </div>
  );
}

it('a measured file keeps its dimensions when the viewer steps away and back', async () => {
  const a = fileRecord({ originalName: 'a.png' });
  const b = fileRecord({ originalName: 'b.png', width: 800, height: 600 });
  const api = install({ 'files:measure': (r) => ({ ...a, id: r.fileId, width: 1600, height: 2000 }) });
  render(<Browsing files={[a, b]} />);
  const user = await openDialog();
  await waitFor(() => expect(detailValue('Dimensions')).toBe('1600 × 2000 px'));
  await user.click(screen.getByRole('button', { name: 'Next file (→)' }));
  expect(detailValue('Dimensions')).toBe('800 × 600 px');
  await user.click(screen.getByRole('button', { name: 'Previous file (←)' }));
  expect(detailValue('Dimensions')).toBe('1600 × 2000 px');
  expect(screen.queryByRole('img', { name: 'Preview only' })).toBeNull();
  expect((screen.getByRole('button', { name: '100%' }) as HTMLButtonElement).disabled).toBe(false);
  expect(measureCalls(api).map((c) => c.request)).toEqual([{ fileId: a.id }]);
});

it('the dialog header is no banner landmark', async () => {
  install();
  render(<Browsing files={[fileRecord({ originalName: 'a.png', width: 10, height: 10 })]} />);
  await openDialog();
  expect(within(screen.getByRole('dialog')).queryByRole('banner')).toBeNull();
});

it('a focused Next that becomes disabled at the end hands the focus to the stage, so the keys keep working', async () => {
  const a = fileRecord({ originalName: 'a.png', width: 10, height: 10 });
  const b = fileRecord({ originalName: 'b.png', width: 10, height: 10 });
  install();
  render(<Browsing files={[a, b]} />);
  const user = await openDialog();
  for (const name of ['Next file (→)', 'Next file']) {
    await user.click(screen.getByRole('button', { name }));
    expect(screen.getByRole('heading', { name: 'b.png' })).toBeTruthy();
    const active = document.activeElement;
    expect(active === null || active === document.body).toBe(false);
    expect(screen.getByRole('dialog').contains(active)).toBe(true);
    expect((active as HTMLButtonElement).disabled ?? false).toBe(false);
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('heading', { name: 'a.png' })).toBeTruthy();
  }
});

/** A succeeded upscale of `source` with one output, as `generations:forFile` lists it among the results. */
function resultGeneration(source: FileRecord): Generation {
  return {
    id: nextId(),
    kind: 'upscale',
    status: 'succeeded',
    errorCode: null,
    providerId: nextId(),
    providerName: 'Venice',
    providerKind: 'venice',
    model: null,
    prompt: null,
    parameters: { v: 1, scale: 2 },
    jobId: nextId(),
    jobStatus: 'succeeded',
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    inputs: [{ fileId: source.id, name: source.originalName, sha256: 'a'.repeat(64), trashed: false }],
    outputs: [{ fileId: nextId(), name: 'a 2x.png', sha256: 'b'.repeat(64), trashed: false }],
    promptId: null,
    promptVersionId: null,
    promptTitle: null,
    promptVersionNumber: null,
    promptVariables: null,
  };
}

it('the details column shows the sources of the shown file above the generation blocks and loads them again after Next', async () => {
  const a = fileRecord({ originalName: 'a.png', width: 10, height: 10 });
  const b = fileRecord({ originalName: 'b.png', width: 10, height: 10 });
  const api = install({
    ...fakeFileOrigins({
      [a.id]: [{ id: nextId(), url: 'https://example.org/a.png', createdAt: '2026-11-27T08:00:00.000Z' }],
      [b.id]: [{ id: nextId(), url: 'https://example.org/b.png', createdAt: '2026-11-27T08:00:00.000Z' }],
    }).handlers,
    'generations:forFile': ({ fileId }) => ({ madeBy: null, results: fileId === a.id ? [resultGeneration(a)] : [] }),
  });
  render(<Browsing files={[a, b]} />);
  const user = await openDialog();
  expect(await screen.findByRole('link', { name: 'https://example.org/a.png' })).toBeTruthy();
  await screen.findByRole('heading', { level: 3, name: 'Results' });
  const order = headings(3);
  expect(order.indexOf('Source')).toBeGreaterThan(order.indexOf('Image tags'));
  expect(order.indexOf('Source')).toBe(order.indexOf('Results') - 1);
  await user.click(screen.getByRole('button', { name: 'Next file (→)' }));
  expect(await screen.findByRole('link', { name: 'https://example.org/b.png' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'https://example.org/a.png' })).toBeNull();
  expect(api.calls.filter((c) => c.channel === 'files:origins').map((c) => c.request)).toEqual([
    { fileId: a.id },
    { fileId: b.id },
  ]);
});

it('a trashed file shows its sources too', async () => {
  const file = trashedRecord({ originalName: 'gone.png' });
  install(
    fakeFileOrigins({
      [file.id]: [{ id: nextId(), url: 'https://example.org/gone.png', createdAt: '2026-11-27T08:00:00.000Z' }],
    }).handlers,
  );
  render(<Harness file={file} asset={null} roleControl={null} />);
  await openDialog();
  expect(await screen.findByRole('link', { name: 'https://example.org/gone.png' })).toBeTruthy();
});

it('a change made while the measurement is in flight is kept and gains the dimensions', async () => {
  const a = fileRecord({ originalName: 'a.png' });
  const measure = deferred<FileRecord>();
  install({
    'files:measure': () => measure.promise,
    'files:addTag': () => ({ ...a, tags: [tagOf('Bark', 'manual')] }),
  });
  render(<Browsing files={[a]} />);
  const user = await openDialog();
  await user.type(screen.getByRole('combobox', { name: 'Add image tag' }), 'Bark{Enter}');
  await screen.findByRole('button', { name: 'Remove Bark' });
  measure.resolve({ ...a, width: 1600, height: 2000 });
  await waitFor(() => expect(detailValue('Dimensions')).toBe('1600 × 2000 px'));
  expect(screen.getByRole('button', { name: 'Remove Bark' })).toBeTruthy();
});

/** The inbox as a real host of the viewer, whose `files:trashMany` removes files from the served list. */
function InboxHost() {
  const [state, setState] = useState<InboxListState>({ filters: NO_FILE_FILTERS, scrollOffset: 0 });
  return (
    <div className="flex h-[800px] flex-col">
      <InboxScreen state={state} onStateChange={setState} onBusyChange={() => {}} />
    </div>
  );
}

function installInbox(initial: FileRecord[], trash?: FakeHandlers['files:trashMany']) {
  let items = initial;
  const api = installFakeApi({
    'files:list': (r) => ({ items: items.slice(r.offset, r.offset + r.limit), total: items.length }),
    'tags:suggest': () => [],
    'assets:list': () => ({ items: [], total: 0 }),
    'files:trashMany':
      trash ??
      ((r) => {
        items = items.filter((f) => !r.fileIds.includes(f.id));
        return { items: r.fileIds.map((fileId) => ({ fileId, file: null, error: null })) };
      }),
  });
  return api;
}

async function openInInbox(name: string) {
  const user = userEvent.setup();
  const tile = (
    await within(await screen.findByRole('listbox', { name: 'Files' })).findByText(name)
  ).closest<HTMLElement>('[data-index]')!;
  await user.click(tile);
  await user.keyboard('{Enter}');
  return { user, dialog: await screen.findByRole('dialog', { name }) };
}

async function deleteInDialog(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
}

it('Delete in the More menu trashes the file and the dialog shows the next one', async () => {
  const a = fileRecord({ originalName: 'a.png' });
  const b = fileRecord({ originalName: 'b.png' });
  const api = installInbox([a, b]);
  render(<InboxHost />);
  const { user, dialog } = await openInInbox('a.png');
  await deleteInDialog(user, dialog);
  expect(await screen.findByRole('dialog', { name: 'b.png' })).toBeTruthy();
  expect(api.calls.filter((c) => c.channel === 'files:trashMany').map((c) => c.request)).toEqual([{ fileIds: [a.id] }]);
});

it('deleting the last file closes the dialog', async () => {
  const a = fileRecord({ originalName: 'a.png' });
  installInbox([a]);
  render(<InboxHost />);
  const { user, dialog } = await openInInbox('a.png');
  await deleteInDialog(user, dialog);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('a failing delete shows the message in the dialog', async () => {
  const a = fileRecord({ originalName: 'a.png' });
  installInbox([a], (r) => ({
    items: r.fileIds.map((fileId) => ({
      fileId,
      file: null,
      error: { code: 'invalid_operation', message: 'The file is still being imported' },
    })),
  }));
  render(<InboxHost />);
  const { user, dialog } = await openInInbox('a.png');
  await deleteInDialog(user, dialog);
  expect(await within(dialog).findByText('The file is still being imported')).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'a.png' })).toBe(dialog);
});

it('a trashed file shows its origin, read-only tags and only Restore and Delete permanently', async () => {
  install();
  const file = trashedRecord({
    originalName: 'hero.png',
    deletedAt: '2026-03-04T05:06:00.000Z',
    trashedAssetId: ASSET.id,
    trashedAssetName: 'Hero',
    trashedRole: 'texture',
    tags: [tagOf('Bark'), tagOf('Moss', 'ai')],
  });
  const actions: FileActionContext = {
    cover: { isEffective: false, isChosen: false },
    onDetails: () => {},
    onSetCover: () => {},
    onDetach: () => {},
    onAnalyse: () => {},
    onReviewTags: () => {},
    onImageToPrompt: () => {},
    onDelete: () => {},
    onRestore: () => {},
    onPurge: () => {},
  };
  render(<Harness file={{ ...file, hasProposal: true }} asset={null} actions={actions} roleControl={null} />);
  const user = await openDialog();
  expect(detailValue('Deleted')).toBe(formatDateTime(file.deletedAt!));
  expect(detailValue('Origin')).toBe('Hero');
  // Tags are shown, but cannot be changed.
  const tags = screen.getByRole('region', { name: 'Image tags' });
  expect(within(tags).getByText('Bark')).toBeTruthy();
  expect(within(tags).getByText('Moss')).toBeTruthy();
  expect(within(tags).queryByRole('button')).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Add image tag' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Assign' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Role' })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Restore', 'Delete permanently']);
});

it('a trashed file from the inbox names the inbox as its origin', async () => {
  install();
  render(<Harness file={trashedRecord({ originalName: 'loose.png' })} asset={null} roleControl={null} />);
  await openDialog();
  expect(detailValue('Origin')).toBe('Inbox');
});

it('renaming an image tag from the open dialog shows the new chip before the list reload answers', async () => {
  const a = fileRecord({ originalName: 'a.png', tags: [tagOf('Front View')] });
  const b = fileRecord({ originalName: 'b.png' });
  const api = installInbox([a, b]);
  const rename = renameHandlers({ 'front view': 'Front View' });
  api.set('tags:usage', rename['tags:usage']);
  api.set('tags:rename', (request) => {
    api.set('files:list', () => deferred<IpcResponse<'files:list'>>().promise);
    return rename['tags:rename'](request);
  });
  render(
    <TagsProvider>
      <InboxHost />
    </TagsProvider>,
  );
  const { user, dialog } = await openInInbox('a.png');
  const row = within(dialog).getByRole('group', { name: 'Image tags' });
  const before = api.calls.filter((c) => c.channel === 'files:list').length;
  await renameThroughDialog(user, 'Front View', 'Front');
  await waitFor(() => expect(api.calls.filter((c) => c.channel === 'files:list').length).toBeGreaterThan(before));
  await waitFor(() => expect(within(row).getByRole('button', { name: 'Remove Front' })).toBeTruthy());
  expect(within(row).queryByRole('button', { name: 'Remove Front View' })).toBeNull();
  expect(screen.getByRole('dialog', { name: 'a.png' })).toBe(dialog);
});
