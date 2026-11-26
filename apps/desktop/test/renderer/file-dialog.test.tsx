import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { FileDetailDialog } from '../../src/renderer/src/components/FileDetailDialog';
import type { FileActionContext } from '../../src/renderer/src/file-actions';
import { installFakeApi, type FakeHandlers } from './fake-api';
import { fileRecord, nextId, tagOf } from './fixtures';

const ASSET = { id: nextId(), name: 'Oak tree', tags: [tagOf('Nature')] };
const ACTIONS: FileActionContext = { cover: null, onDetails: () => {} };

function Harness(props: {
  file: FileRecord;
  asset?: typeof ASSET | null;
  onOpenAsset?(id: string): void;
  actions?: FileActionContext;
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
          onOpenAsset={props.onOpenAsset}
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
