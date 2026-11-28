import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AssignFileControl } from '../../src/renderer/src/components/FileRoleControls';
import { installFakeApi } from './fake-api';
import { assetSummary, fileRecord, pageOf } from './fixtures';

it('a second pick after the file was assigned sends no second request', async () => {
  const file = fileRecord({ id: 'f1', status: 'complete', assetId: null, role: null });
  const oak = assetSummary({ id: 'a1', name: 'Oak' });
  const pine = assetSummary({ id: 'a2', name: 'Pine' });
  const api = installFakeApi({
    'assets:list': () => pageOf([oak, pine]),
    'files:assign': (request) => ({ ...file, assetId: request.assetId, role: request.role }),
  });
  const onAssigned = vi.fn();
  const user = userEvent.setup();
  // The host has not removed the control yet: the file is still shown as an inbox file.
  render(<AssignFileControl file={file} onAssigned={onAssigned} />);
  await user.click(screen.getByRole('button', { name: 'Assign' }));
  await user.click(screen.getByRole('combobox', { name: 'Search assets' }));
  await user.click(await screen.findByRole('option', { name: 'Oak' }));
  await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));

  await user.click(screen.getByRole('combobox', { name: 'Search assets' }));
  await user.click(await screen.findByRole('option', { name: 'Pine' }));
  expect(api.calls.filter((c) => c.channel === 'files:assign')).toHaveLength(1);
  expect(onAssigned).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).toBeNull();
});
