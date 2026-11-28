import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../../src/renderer/src/components/ConfirmDialog';
import { Dialog } from '../../src/renderer/src/components/Dialog';
import { Menu, type MenuItem } from '../../src/renderer/src/components/Menu';
import { Tabs } from '../../src/renderer/src/components/Tabs';
import { Link } from '../../src/renderer/src/components/Link';

function DialogHarness({ onClose, size }: { onClose(): void; size?: 'form' | 'detail' }) {
  const [open, setOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        New asset
      </button>
      <Dialog
        open={open}
        title="New asset"
        size={size}
        initialFocusRef={nameRef}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      >
        <input aria-label="Other" />
        <input aria-label="Name" ref={nameRef} />
      </Dialog>
    </>
  );
}

it('Esc closes the dialog and focus returns to the trigger', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<DialogHarness onClose={onClose} />);
  const trigger = screen.getByRole('button', { name: 'New asset' });
  await user.click(trigger);

  const dialog = document.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  const titleId = dialog.getAttribute('aria-labelledby');
  expect(titleId).not.toBeNull();
  expect(document.getElementById(titleId!)?.textContent).toBe('New asset');
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));

  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

it('the detail dialog follows the window size with an even margin; the form dialog keeps its size', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<DialogHarness onClose={() => {}} size="detail" />);
  await user.click(screen.getByRole('button', { name: 'New asset' }));
  let classes = document.querySelector('dialog')!.className.split(/\s+/);
  expect(classes).toEqual(
    expect.arrayContaining([
      'w-[calc(100vw-3rem)]',
      'h-[calc(100vh-3rem)]',
      'max-w-none',
      'max-h-none',
      'rounded-dialog',
    ]),
  );
  expect(classes.some((c) => /\d+px/.test(c))).toBe(false);
  unmount();

  render(<DialogHarness onClose={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'New asset' }));
  classes = document.querySelector('dialog')!.className.split(/\s+/);
  expect(classes).toContain('w-[min(92vw,32rem)]');
});

function menuItems(): { items: MenuItem[]; details: () => void; detach: () => void } {
  const details = vi.fn();
  const detach = vi.fn();
  return {
    items: [
      { label: 'Details', onSelect: details },
      { label: 'Detach', onSelect: detach },
    ],
    details,
    detach,
  };
}

it('the menu opens on Enter, moves with arrows, selects with Enter and returns focus', async () => {
  const user = userEvent.setup();
  const { items, details, detach } = menuItems();
  render(<Menu label="More" items={items} />);
  const trigger = screen.getByRole('button', { name: 'More' });
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');

  trigger.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('menu')).not.toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('true');

  await user.keyboard('{ArrowDown}{ArrowDown}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Detach' }));

  await user.keyboard('{Enter}');
  expect(detach).toHaveBeenCalledTimes(1);
  expect(details).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('Esc closes the menu without selecting', async () => {
  const user = userEvent.setup();
  const { items, details, detach } = menuItems();
  const outer = vi.fn();
  render(
    <div onKeyDown={outer}>
      <Menu label="More" items={items} />
    </div>,
  );
  const trigger = screen.getByRole('button', { name: 'More' });
  await user.click(trigger);
  await user.keyboard('{ArrowDown}');
  outer.mockClear();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(details).not.toHaveBeenCalled();
  expect(detach).not.toHaveBeenCalled();
  expect(outer).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});

it('menu navigation skips disabled items and Home/End jump to the ends', async () => {
  const user = userEvent.setup();
  const skipped = vi.fn();
  const items: MenuItem[] = [
    { label: 'Details', onSelect: vi.fn() },
    { label: 'Open externally', onSelect: skipped, disabled: true, title: 'Not available' },
    { label: 'Detach', onSelect: vi.fn() },
  ];
  render(<Menu label="More" items={items} />);
  await user.click(screen.getByRole('button', { name: 'More' }));
  await user.keyboard('{ArrowDown}{ArrowDown}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Detach' }));
  await user.keyboard('{Home}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Details' }));
  await user.keyboard('{End}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Detach' }));
  await user.keyboard('{ArrowUp}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Details' }));

  const disabled = screen.getByRole('menuitem', { name: 'Open externally' });
  expect(disabled.getAttribute('aria-disabled')).toBe('true');
  expect(disabled.getAttribute('title')).toBe('Not available');
  await user.click(disabled);
  expect(skipped).not.toHaveBeenCalled();
  expect(screen.getByRole('menu')).not.toBeNull();
});

it('Tab and an outside click close the menu', async () => {
  const user = userEvent.setup();
  render(
    <>
      <Menu label="More" items={menuItems().items} />
      <button type="button">Elsewhere</button>
    </>,
  );
  const trigger = screen.getByRole('button', { name: 'More' });
  await user.click(trigger);
  await user.keyboard('{Tab}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await user.click(trigger);
  expect(screen.getByRole('menu')).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
  expect(screen.queryByRole('menu')).toBeNull();
});

type TabId = 'files' | 'workflow' | 'projects';

function TabsHarness({ onChange }: { onChange(id: TabId): void }) {
  const [active, setActive] = useState<TabId>('files');
  return (
    <Tabs<TabId>
      label="Asset sections"
      tabs={[
        { id: 'files', label: 'Files', count: 4 },
        { id: 'workflow', label: 'Workflow' },
        { id: 'projects', label: 'Projects', count: null },
      ]}
      active={active}
      onChange={(id) => {
        onChange(id);
        setActive(id);
      }}
    >
      <p>Panel {active}</p>
    </Tabs>
  );
}

it('tabs switch with arrow keys and expose one tabpanel', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<TabsHarness onChange={onChange} />);
  expect(screen.getByRole('tablist', { name: 'Asset sections' })).not.toBeNull();
  const files = screen.getByRole('tab', { name: /Files/ });
  const workflow = screen.getByRole('tab', { name: 'Workflow' });
  const projects = screen.getByRole('tab', { name: 'Projects' });
  expect(files.textContent).toContain('4');

  files.focus();
  await user.keyboard('{ArrowRight}');
  expect(onChange).toHaveBeenLastCalledWith('workflow');
  expect(document.activeElement).toBe(workflow);
  expect(workflow.tabIndex).toBe(0);
  expect(files.tabIndex).toBe(-1);
  expect(projects.tabIndex).toBe(-1);
  expect(workflow.getAttribute('aria-selected')).toBe('true');

  const panels = screen.getAllByRole('tabpanel');
  expect(panels).toHaveLength(1);
  expect(panels[0]!.getAttribute('aria-labelledby')).toBe(workflow.id);
  expect(panels[0]!.tabIndex).toBe(0);
  expect(panels[0]!.textContent).toBe('Panel workflow');

  await user.keyboard('{End}');
  expect(onChange).toHaveBeenLastCalledWith('projects');
  expect(document.activeElement).toBe(projects);
  await user.keyboard('{ArrowRight}');
  expect(onChange).toHaveBeenLastCalledWith('files');
  await user.keyboard('{ArrowLeft}');
  expect(onChange).toHaveBeenLastCalledWith('projects');
  await user.keyboard('{Home}');
  expect(onChange).toHaveBeenLastCalledWith('files');
  expect(document.activeElement).toBe(files);
});

it('a link follows without navigating the document', async () => {
  const user = userEvent.setup();
  const onFollow = vi.fn();
  render(
    <Link onFollow={onFollow} title="Back to the gallery">
      Assets
    </Link>,
  );
  const link = screen.getByRole('link', { name: 'Assets' });
  expect(link.getAttribute('href')).toBe('#');
  expect(link.getAttribute('title')).toBe('Back to the gallery');
  await user.click(link);
  expect(onFollow).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe('');
});

it('a menu opens below and right-aligned by default, and honours start alignment and the top side', async () => {
  const user = userEvent.setup();
  const items: MenuItem[] = [{ label: 'One', onSelect: () => {} }];
  const { unmount } = render(<Menu label="Actions" items={items} />);
  await user.click(screen.getByRole('button', { name: 'Actions' }));
  let classes = screen.getByRole('menu').className.split(/\s+/);
  expect(classes).toEqual(expect.arrayContaining(['right-0', 'top-full', 'mt-1']));
  expect(classes).not.toContain('left-0');
  unmount();

  render(<Menu label="Actions" items={items} align="start" side="top" />);
  await user.click(screen.getByRole('button', { name: 'Actions' }));
  classes = screen.getByRole('menu').className.split(/\s+/);
  expect(classes).toEqual(expect.arrayContaining(['left-0', 'bottom-full', 'mb-1']));
  expect(classes).not.toContain('right-0');
  expect(classes).not.toContain('top-full');
});

it('the form dialog title stays on one line and carries the full text', () => {
  render(
    <Dialog open title="New asset" onClose={() => {}}>
      <p>Body</p>
    </Dialog>,
  );
  const form = screen.getByRole('heading', { name: 'New asset' });
  expect(form.getAttribute('title')).toBe('New asset');
  expect(form.className.split(/\s+/)).toContain('truncate');
});

it('the detail dialog is named by its title and leaves header and body to its content, unpadded', () => {
  const title = 'a-very-long-file-name.png | A very long asset name';
  render(
    <Dialog open title={title} onClose={() => {}} size="detail">
      <p>Body</p>
    </Dialog>,
  );
  expect(screen.getByRole('dialog', { name: title })).toBeTruthy();
  expect(screen.queryByRole('heading')).toBeNull();
  const body = screen.getByText('Body').parentElement!;
  expect(body.className.split(/\s+/)).toContain('h-full');
  expect(body.className.split(/\s+/).some((c) => /^p[xy]?-/.test(c))).toBe(false);
});

it('ConfirmDialog focuses Cancel, confirms, cancels on Esc and disables both buttons while busy', async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = (busy: boolean) => (
    <ConfirmDialog
      open
      title="Delete 2 files permanently?"
      confirmLabel="Delete permanently"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
  const { rerender } = render(view(false));
  const dialog = screen.getByRole('dialog', { name: 'Delete 2 files permanently?' });
  // The title is the only text besides the two buttons.
  const buttons = screen.getAllByRole('button').map((b) => b.textContent);
  expect(buttons).toEqual(['Delete permanently', 'Cancel']);
  expect(dialog.textContent).toBe('Delete 2 files permanently?Delete permanentlyCancel');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

  await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  screen.getByRole('button', { name: 'Cancel' }).focus();
  await user.keyboard('{Escape}');
  expect(onCancel).toHaveBeenCalledTimes(2);

  rerender(view(true));
  expect((screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
});
