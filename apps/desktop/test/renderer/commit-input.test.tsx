import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CommitInput } from '../../src/renderer/src/components/CommitInput';

it('Enter followed by blur saves once while the reload has not arrived yet', async () => {
  const user = userEvent.setup();
  const onCommit = vi.fn(async () => true);
  render(<CommitInput value="Oak" onCommit={onCommit} label="Name" maxLength={50} />);
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });

  await user.clear(input);
  await user.type(input, 'Pine{Enter}');
  await act(async () => {
    fireEvent.blur(input);
  });

  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenCalledWith('Pine');
});

it('a reload arriving after more typing keeps the typed text', async () => {
  const user = userEvent.setup();
  const onCommit = vi.fn(async () => true);
  const { rerender } = render(<CommitInput value="Oak" onCommit={onCommit} label="Name" maxLength={50} />);
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });

  await user.clear(input);
  await user.type(input, 'Pine{Enter}');
  await user.type(input, ' cone');
  rerender(<CommitInput value="Pine" onCommit={onCommit} label="Name" maxLength={50} />);

  expect(input.value).toBe('Pine cone');
});

it('a new value replaces an untouched or just saved draft', async () => {
  const user = userEvent.setup();
  const onCommit = vi.fn(async () => true);
  const { rerender } = render(<CommitInput value="Oak" onCommit={onCommit} label="Name" maxLength={50} />);
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });

  rerender(<CommitInput value="Elm" onCommit={onCommit} label="Name" maxLength={50} />);
  expect(input.value).toBe('Elm');

  await user.clear(input);
  await user.type(input, 'pine{Enter}');
  // The main process may store the text in another form than typed.
  rerender(<CommitInput value="Pine" onCommit={onCommit} label="Name" maxLength={50} />);
  expect(input.value).toBe('Pine');
});

it('a failed save shows the saved value again', async () => {
  const user = userEvent.setup();
  const onCommit = vi.fn(async () => false);
  render(<CommitInput value="Oak" onCommit={onCommit} label="Name" maxLength={50} />);
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });

  await user.clear(input);
  await user.type(input, 'Pine{Enter}');

  expect(input.value).toBe('Oak');
});
