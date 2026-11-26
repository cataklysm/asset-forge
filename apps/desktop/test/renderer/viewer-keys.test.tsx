import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { expect, it, vi } from 'vitest';
import { useViewerKeys, type ViewerKeyActions } from '../../src/renderer/src/hooks/useViewerKeys';

function actionsMock(): ViewerKeyActions {
  return {
    previous: vi.fn(),
    next: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fit: vi.fn(),
    actual: vi.fn(),
    rotate: vi.fn(),
    fullscreen: vi.fn(),
  };
}

function Probe({ actions, expanded = false }: { actions: ViewerKeyActions; expanded?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useViewerKeys(root, actions);
  return (
    <div ref={root}>
      <button type="button">Target</button>
      <button type="button" aria-expanded={expanded}>
        Menu
      </button>
      <input aria-label="Tag" />
    </div>
  );
}

const MAP: [string, keyof ViewerKeyActions][] = [
  ['{ArrowLeft}', 'previous'],
  ['{ArrowRight}', 'next'],
  ['+', 'zoomIn'],
  ['=', 'zoomIn'],
  ['-', 'zoomOut'],
  ['0', 'fit'],
  ['1', 'actual'],
  ['r', 'rotate'],
  ['R', 'rotate'],
  ['f', 'fullscreen'],
  ['F', 'fullscreen'],
];

it.each(MAP)('%s calls %s exactly once', async (key, name) => {
  const actions = actionsMock();
  render(<Probe actions={actions} />);
  const user = userEvent.setup();
  screen.getByRole('button', { name: 'Target' }).focus();
  await user.keyboard(key);
  for (const [other, fn] of Object.entries(actions)) expect(fn).toHaveBeenCalledTimes(other === name ? 1 : 0);
});

function nothingCalled(actions: ViewerKeyActions) {
  for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
}

it('ignores keys typed in a text field', async () => {
  const actions = actionsMock();
  render(<Probe actions={actions} />);
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Tag' }), '{ArrowRight}r');
  nothingCalled(actions);
});

it('ignores keys while a popup is open', async () => {
  const actions = actionsMock();
  render(<Probe actions={actions} expanded />);
  const user = userEvent.setup();
  screen.getByRole('button', { name: 'Target' }).focus();
  await user.keyboard('{ArrowRight}');
  nothingCalled(actions);
});

it('ignores keys with Ctrl held', async () => {
  const actions = actionsMock();
  render(<Probe actions={actions} />);
  const user = userEvent.setup();
  screen.getByRole('button', { name: 'Target' }).focus();
  await user.keyboard('{Control>}{ArrowRight}{/Control}');
  nothingCalled(actions);
});

it('prevents the default of a handled key only', () => {
  render(<Probe actions={actionsMock()} />);
  const target = screen.getByRole('button', { name: 'Target' });
  const handled = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  target.dispatchEvent(handled);
  expect(handled.defaultPrevented).toBe(true);
  const other = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
  target.dispatchEvent(other);
  expect(other.defaultPrevented).toBe(false);
});
