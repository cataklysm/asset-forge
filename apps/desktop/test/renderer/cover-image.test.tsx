import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { expect, it } from 'vitest';
import { call } from '../../src/renderer/src/api';
import { AppShell } from '../../src/renderer/src/components/AppShell';
import { CoverImage } from '../../src/renderer/src/components/CoverImage';
import { StorageReturnContext, useStorageReturn } from '../../src/renderer/src/storage-context';
import { fakeError, installFakeApi } from './fake-api';

const FILE_ID = '00000000-0000-4000-8000-000000000001';

it('a failed cover shows the fallback until the storage counts as reachable again', () => {
  const { container, rerender } = render(
    <StorageReturnContext.Provider value={0}>
      <CoverImage fileId={FILE_ID} size="thumb" fallback="PNG" />
    </StorageReturnContext.Provider>,
  );
  fireEvent.error(container.querySelector('img')!);
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText('PNG')).toBeTruthy();

  rerender(
    <StorageReturnContext.Provider value={1}>
      <CoverImage fileId={FILE_ID} size="thumb" fallback="PNG" />
    </StorageReturnContext.Provider>,
  );
  expect(container.querySelector('img')?.getAttribute('src')).toContain(FILE_ID);
});

it('Retry on the storage banner raises the storage return counter', async () => {
  const user = userEvent.setup();
  let attempts = 0;
  installFakeApi({
    'assets:list': () => {
      attempts += 1;
      if (attempts === 1) throw fakeError('storage_unreachable');
      return { items: [], total: 0 };
    },
  });
  function Child() {
    const token = useStorageReturn();
    useEffect(() => {
      void call('assets:list', { limit: 1, offset: 0 }).catch(() => {});
    }, []);
    return <p>{`token ${token}`}</p>;
  }
  render(
    <AppShell
      workspaceName="W"
      rootPath="C:/w"
      section="assets"
      busy={false}
      activeJobs={0}
      onNavigate={() => {}}
      onClose={() => {}}
    >
      <Child />
    </AppShell>,
  );
  expect(await screen.findByText('token 0')).toBeTruthy();
  await screen.findByRole('alert');
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('token 1')).toBeTruthy();
});
