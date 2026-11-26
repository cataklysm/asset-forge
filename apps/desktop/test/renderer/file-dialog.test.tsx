import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import type { ViewerList } from '../../src/renderer/src/components/FileBrowser';
import { FileDetailDialog } from '../../src/renderer/src/components/FileDetailDialog';
import type { FileActionContext } from '../../src/renderer/src/file-actions';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { fileRecord, nextId, tagOf } from './fixtures';

const ASSET = { id: nextId(), name: 'Oak tree', tags: [tagOf('Nature')] };
const ACTIONS: FileActionContext = { cover: null, onDetails: () => {} };

function Harness(props: {
  file: FileRecord;
  asset?: typeof ASSET | null;
  onOpenAsset?(id: string): void;
  onMeasured?(file: FileRecord): void;
  actions?: FileActionContext;
  list?: ViewerList | null;
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
          roleControl={<span>role control</span>}
          onFileChange={setFile}
          onMeasured={(record) => {
            props.onMeasured?.(record);
            setFile(record);
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
  expect(screen.getByText('Oak tree')).toBeTruthy();
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

it('Dimensions follow Type and show the stored size, or a dash while unknown', async () => {
  install();
  const { unmount } = render(<Harness file={fileRecord({ width: 1600, height: 2000 })} asset={null} />);
  await openDialog();
  expect(detailValue('Dimensions')).toBe('1600 × 2000 px');
  const labels = [...screen.getByRole('region', { name: 'Details' }).querySelectorAll('dt')].map((dt) => dt.textContent);
  expect(labels.slice(0, 4)).toEqual(['Name', 'Type', 'Dimensions', 'Size']);
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
  await waitFor(() => expect(onMeasured).toHaveBeenCalledWith(measured));
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
      file={fileRecord({ originalName: 'notes.txt', mimeType: 'text/plain', previewable: false, openable: true, kind: 'document' })}
      asset={null}
    />,
  );
  await openDialog();
  expect(screen.getByText('TXT')).toBeTruthy();
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

const fileList = (count: number) => Array.from({ length: count }, (_, i) => fileRecord({ originalName: `File ${i}.png` }));

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
  const text = fileRecord({ originalName: 'notes.txt', mimeType: 'text/plain', previewable: false, openable: true, kind: 'document' });
  const files = [fileRecord({ originalName: 'File 0.png' }), text];
  render(<Harness file={text} asset={null} list={listOf(files, 1)} />);
  await openDialog();
  expect(screen.getByText('2 / 2')).toBeTruthy();
  expect(screen.getByText('TXT')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Image' })).toBeNull();
});

it('without a list there is no counter and no arrows', async () => {
  install();
  render(<Harness file={fileRecord()} asset={null} />);
  await openDialog();
  expect(screen.queryByText(/^\d+ \/ \d+$/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Previous file (←)' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Next file (→)' })).toBeNull();
});
