import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ResultStrip, type ResultFailure } from '../../src/renderer/src/components/ResultStrip';

function failures(count: number): ResultFailure[] {
  return Array.from({ length: count }, (_, index) => ({
    key: String(index),
    name: `file-${index}.png`,
    message: 'This file cannot be read',
  }));
}

it('shows every failure line when there are at most 100', () => {
  render(<ResultStrip title="0 imported, 100 failed" failures={failures(100)} onDismiss={() => {}} />);
  const list = screen.getByRole('list');
  expect(within(list).getAllByRole('listitem')).toHaveLength(100);
  expect(screen.queryByText(/more failed/)).toBeNull();
});

it('shows at most 100 failure lines and a count line for the rest', () => {
  render(<ResultStrip title="0 imported, 5000 failed" failures={failures(5000)} onDismiss={() => {}} />);
  const list = screen.getByRole('list');
  expect(within(list).getAllByRole('listitem')).toHaveLength(100);
  expect(screen.getByText('file-99.png')).toBeTruthy();
  expect(screen.queryByText('file-100.png')).toBeNull();
  expect(screen.getByText('4900 more failed')).toBeTruthy();
});

it('keeps the failure lines in a scroll box of bounded height', () => {
  render(<ResultStrip title="0 imported, 3 failed" failures={failures(3)} onDismiss={() => {}} />);
  const list = screen.getByRole('list');
  expect(list.className).toMatch(/max-h-/);
  expect(list.className).toMatch(/overflow-y-auto/);
});
