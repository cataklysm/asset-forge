import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { expect, it, vi } from 'vitest';
import { call } from '../../src/renderer/src/api';
import { AppShell } from '../../src/renderer/src/components/AppShell';
import { fakeError, installFakeApi } from './fake-api';

type Section = 'assets' | 'projects' | 'inbox';

function shell(
  props: { section?: Section | null; busy?: boolean; onNavigate?(s: Section): void; onClose?(): void },
  child = <p>content</p>,
) {
  return (
    <AppShell
      workspaceName="Studio"
      rootPath="D:/work/studio"
      section={props.section === undefined ? 'assets' : props.section}
      busy={props.busy ?? false}
      onNavigate={props.onNavigate ?? (() => {})}
      onClose={props.onClose ?? (() => {})}
    >
      {child}
    </AppShell>
  );
}

it('shows the name, the path with a title and Workspaces closes', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(shell({ onClose }));
  expect(screen.getByRole('heading', { name: 'Studio' })).toBeTruthy();
  expect(screen.getByTitle('D:/work/studio').textContent).toBe('D:/work/studio');
  await user.click(screen.getByRole('button', { name: /Workspaces/ }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('the active section is marked and nav is disabled while busy', async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  const { rerender } = render(shell({ section: 'projects', onNavigate, onClose }));
  expect(screen.getByRole('link', { name: /Projects/ }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: /Assets/ }).getAttribute('aria-current')).toBeNull();
  await user.click(screen.getByRole('link', { name: /Inbox/ }));
  expect(onNavigate).toHaveBeenCalledWith('inbox');

  onNavigate.mockClear();
  rerender(shell({ section: 'projects', busy: true, onNavigate, onClose }));
  const assets = screen.getByRole('link', { name: /Assets/ });
  expect(assets.getAttribute('aria-disabled')).toBe('true');
  expect(assets.getAttribute('title')).toBe('Import in progress');
  await user.click(assets);
  await user.click(screen.getByRole('button', { name: /Workspaces/ }));
  expect(onNavigate).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /Workspaces/ }).getAttribute('aria-disabled')).toBe('true');
});

it('a storage_unreachable failure shows the banner and Retry remounts the page', async () => {
  const user = userEvent.setup();
  let attempts = 0;
  installFakeApi({
    'assets:list': () => {
      attempts += 1;
      if (attempts === 1) throw fakeError('storage_unreachable');
      return { items: [], total: 0 };
    },
  });
  let mounts = 0;
  function Child() {
    useEffect(() => {
      mounts += 1;
      void call('assets:list', { limit: 1, offset: 0 }).catch(() => {});
    }, []);
    return <p>child</p>;
  }
  render(shell({}, <Child />));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('cannot be reached');
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(mounts).toBe(2));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('Ctrl+F focuses the page search field', async () => {
  const user = userEvent.setup();
  render(shell({}, <input aria-label="Search" data-search-field="" />));
  await user.keyboard('{Control>}f{/Control}');
  expect(document.activeElement).toBe(screen.getByLabelText('Search'));
});
