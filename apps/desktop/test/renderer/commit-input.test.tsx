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

/**
 * A promise with the functions that settle it.
 *
 * @returns the promise, its resolve and its reject function
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/**
 * A commit callback whose first call waits for the given promise and whose later calls succeed.
 *
 * @param first the answer of the first call
 * @returns the mocked callback
 */
function firstCallWaits(first: Promise<boolean>) {
  let calls = 0;
  return vi.fn((_value: string) => {
    calls += 1;
    return calls === 1 ? first : Promise.resolve(true);
  });
}

it('text committed while a save runs is saved after the save succeeded', async () => {
  const user = userEvent.setup();
  const first = deferred<boolean>();
  const onCommit = firstCallWaits(first.promise);
  render(<CommitInput value="Oak" onCommit={onCommit} label="Name" maxLength={50} />);
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });

  await user.clear(input);
  await user.type(input, 'Pine{Enter}');
  await user.type(input, ' cone');
  await act(async () => {
    fireEvent.blur(input);
  });
  expect(onCommit).toHaveBeenCalledTimes(1);

  await act(async () => {
    first.resolve(true);
  });

  expect(onCommit).toHaveBeenCalledTimes(2);
  expect(onCommit).toHaveBeenLastCalledWith('Pine cone');
});

it('text committed while a save runs is saved after the save failed', async () => {
  const user = userEvent.setup();
  const first = deferred<boolean>();
  const onCommit = firstCallWaits(first.promise);
  render(<CommitInput value="Oak" onCommit={onCommit} label="Name" maxLength={50} />);
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });

  await user.clear(input);
  await user.type(input, 'Pine{Enter}');
  await user.type(input, ' cone');
  await act(async () => {
    fireEvent.blur(input);
  });

  await act(async () => {
    first.reject(new Error('offline'));
  });

  expect(onCommit).toHaveBeenCalledTimes(2);
  expect(onCommit).toHaveBeenLastCalledWith('Pine cone');
  expect(input.value).toBe('Pine cone');
});
