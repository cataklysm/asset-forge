import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { ImportProgress } from '@assetforge/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImportProgressView } from '../../src/renderer/src/components/ImportProgressView';
import {
  IMPORT_POLL_MS,
  IMPORT_RELOAD_MS,
  importProgressValue,
  useImportProgress,
  useImportReload,
} from '../../src/renderer/src/import-progress';
import { importTitle } from '../../src/renderer/src/import-result';
import { deferred, fakeError, importResultOf, installFakeApi } from './fake-api';
import { fileRecord } from './fixtures';

function progressOf(p: Partial<ImportProgress> = {}): ImportProgress {
  return { done: 0, total: 1, currentBytes: 0, currentSize: null, cancelling: false, ...p };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function Probe({ onReload }: { onReload?(): void }) {
  const [active, setActive] = useState(false);
  const { progress, cancel, cancelRequested } = useImportProgress(active);
  useImportReload(active, progress, onReload ?? (() => {}));
  return (
    <div>
      <button type="button" onClick={() => setActive((a) => !a)}>
        Toggle
      </button>
      <button type="button" onClick={cancel}>
        Stop
      </button>
      <output aria-label="Progress">{progress === null ? 'none' : JSON.stringify(progress)}</output>
      <output aria-label="Requested">{String(cancelRequested)}</output>
    </div>
  );
}

const shown = () => screen.getByRole('status', { name: 'Progress' }).textContent;
const requested = () => screen.getByRole('status', { name: 'Requested' }).textContent;
const toggle = () => act(async () => fireEvent.click(screen.getByRole('button', { name: 'Toggle' })));
const stop = () => act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop' })));
const callsOf = (api: ReturnType<typeof installFakeApi>, channel: string) =>
  api.calls.filter((c) => c.channel === channel);

it('polls every 500 ms only while active and resets to null when inactive', async () => {
  let done = 0;
  const api = installFakeApi({ 'files:importProgress': () => progressOf({ done, total: 4 }) });
  render(<Probe />);
  await advance(IMPORT_POLL_MS * 4);
  expect(callsOf(api, 'files:importProgress')).toHaveLength(0);

  await toggle();
  await advance(IMPORT_POLL_MS);
  expect(callsOf(api, 'files:importProgress')).toEqual([{ channel: 'files:importProgress', request: {} }]);
  expect(JSON.parse(shown()!)).toMatchObject({ done: 0, total: 4 });
  done = 2;
  await advance(IMPORT_POLL_MS);
  expect(callsOf(api, 'files:importProgress')).toHaveLength(2);
  expect(JSON.parse(shown()!)).toMatchObject({ done: 2 });

  await toggle();
  expect(shown()).toBe('none');
  await advance(IMPORT_POLL_MS * 4);
  expect(callsOf(api, 'files:importProgress')).toHaveLength(2);
});

it('asks one request at a time and applies every answer', async () => {
  const first = deferred<ImportProgress | null>();
  let count = 0;
  const api = installFakeApi({
    'files:importProgress': () => {
      count += 1;
      return count === 1 ? first.promise : progressOf({ done: count });
    },
  });
  render(<Probe />);
  await toggle();
  await advance(IMPORT_POLL_MS * 5);
  expect(callsOf(api, 'files:importProgress')).toHaveLength(1);
  first.resolve(progressOf({ done: 1, total: 9 }));
  await advance(0);
  expect(JSON.parse(shown()!)).toMatchObject({ done: 1, total: 9 });
  await advance(IMPORT_POLL_MS);
  expect(callsOf(api, 'files:importProgress')).toHaveLength(2);
  expect(JSON.parse(shown()!)).toMatchObject({ done: 2 });
});

it('a failed request keeps the last value and polling continues', async () => {
  let fail = false;
  const api = installFakeApi({
    'files:importProgress': () => {
      if (fail) throw fakeError('internal_error');
      return progressOf({ done: 3, total: 5 });
    },
  });
  render(<Probe />);
  await toggle();
  await advance(IMPORT_POLL_MS);
  expect(JSON.parse(shown()!)).toMatchObject({ done: 3 });
  fail = true;
  await advance(IMPORT_POLL_MS);
  expect(JSON.parse(shown()!)).toMatchObject({ done: 3 });
  await advance(IMPORT_POLL_MS);
  expect(callsOf(api, 'files:importProgress')).toHaveLength(3);
  expect(JSON.parse(shown()!)).toMatchObject({ done: 3 });
});

it('cancel calls files:cancelImport, marks the progress cancelling and resets on the next import', async () => {
  const api = installFakeApi({
    'files:importProgress': () => progressOf({ done: 1, total: 3 }),
    'files:cancelImport': () => ({ cancelling: true }),
  });
  render(<Probe />);
  // Inactive: nothing to cancel.
  await stop();
  expect(callsOf(api, 'files:cancelImport')).toHaveLength(0);
  expect(requested()).toBe('false');

  await toggle();
  await advance(IMPORT_POLL_MS);
  await stop();
  expect(callsOf(api, 'files:cancelImport')).toEqual([{ channel: 'files:cancelImport', request: {} }]);
  expect(requested()).toBe('true');
  expect(JSON.parse(shown()!)).toMatchObject({ cancelling: true });

  // Still true after the import ended, until the next one starts.
  await toggle();
  expect(requested()).toBe('true');
  await toggle();
  expect(requested()).toBe('false');
});

it('a poll already in flight does not undo the cancelling state', async () => {
  const pending = deferred<ImportProgress | null>();
  let count = 0;
  installFakeApi({
    'files:importProgress': () => {
      count += 1;
      return count === 1 ? progressOf({ done: 1 }) : count === 2 ? pending.promise : progressOf({ done: 2 });
    },
    'files:cancelImport': () => ({ cancelling: true }),
  });
  render(<Probe />);
  await toggle();
  await advance(IMPORT_POLL_MS * 2);
  await stop();
  pending.resolve(progressOf({ done: 2, cancelling: false }));
  await advance(0);
  expect(JSON.parse(shown()!)).toMatchObject({ done: 2, cancelling: true });
  await advance(IMPORT_POLL_MS);
  expect(JSON.parse(shown()!)).toMatchObject({ done: 2, cancelling: true });
});

it('a poll that resolves after the hook was deactivated leaves the progress null', async () => {
  const pending = deferred<ImportProgress | null>();
  installFakeApi({ 'files:importProgress': () => pending.promise });
  render(<Probe />);
  await toggle();
  await advance(IMPORT_POLL_MS);
  await toggle();
  pending.resolve(progressOf({ done: 5 }));
  await advance(0);
  expect(shown()).toBe('none');
});

it('a cancel that was refused or failed is not counted as requested', async () => {
  let answer: () => { cancelling: boolean } = () => ({ cancelling: false });
  installFakeApi({
    'files:importProgress': () => progressOf(),
    'files:cancelImport': () => answer(),
  });
  render(<Probe />);
  await toggle();
  await stop();
  await advance(0);
  expect(requested()).toBe('false');
  answer = () => {
    throw fakeError('internal_error');
  };
  await stop();
  await advance(0);
  expect(requested()).toBe('false');
});

it('reloads at most every 3 s while active, and only when done has changed', async () => {
  let done = 0;
  installFakeApi({ 'files:importProgress': () => progressOf({ done, total: 10 }) });
  const onReload = vi.fn();
  render(<Probe onReload={onReload} />);
  await toggle();
  // done is still 0: nothing to reload.
  await advance(IMPORT_RELOAD_MS);
  expect(onReload).not.toHaveBeenCalled();

  done = 1;
  await advance(IMPORT_POLL_MS);
  done = 2;
  await advance(IMPORT_POLL_MS);
  expect(onReload).not.toHaveBeenCalled();
  await advance(IMPORT_RELOAD_MS - 2 * IMPORT_POLL_MS);
  expect(onReload).toHaveBeenCalledTimes(1);

  // Unchanged: no reload.
  await advance(IMPORT_RELOAD_MS);
  expect(onReload).toHaveBeenCalledTimes(1);
  done = 5;
  await advance(IMPORT_POLL_MS);
  await advance(IMPORT_RELOAD_MS - IMPORT_POLL_MS);
  expect(onReload).toHaveBeenCalledTimes(2);

  await toggle();
  done = 9;
  await advance(IMPORT_RELOAD_MS * 2);
  expect(onReload).toHaveBeenCalledTimes(2);
});

it('the bar value adds the fraction of the current file and stays finite between 0 and 1', () => {
  expect(importProgressValue(progressOf({ done: 1, total: 4 }))).toBe(0.25);
  expect(importProgressValue(progressOf({ done: 1, total: 4, currentBytes: 50, currentSize: 100 }))).toBe(0.375);
  // More bytes than the declared size: the fraction is capped at 1.
  expect(importProgressValue(progressOf({ done: 1, total: 4, currentBytes: 500, currentSize: 100 }))).toBe(0.5);
  // A size of 0 or unknown: no fraction.
  expect(importProgressValue(progressOf({ done: 2, total: 4, currentBytes: 0, currentSize: 0 }))).toBe(0.5);
  expect(importProgressValue(progressOf({ done: 2, total: 4, currentBytes: 30, currentSize: null }))).toBe(0.5);
  expect(importProgressValue(progressOf({ done: 0, total: 0 }))).toBe(0);
  expect(importProgressValue(progressOf({ done: 4, total: 4, currentBytes: 9, currentSize: 10 }))).toBe(1);
});

it('the view shows "<done> of <total>", the bar value and a Cancel button disabled once cancelling', () => {
  const onCancel = vi.fn();
  const { rerender } = render(
    <ImportProgressView
      progress={progressOf({ done: 3, total: 8, currentBytes: 1, currentSize: 2 })}
      onCancel={onCancel}
    />,
  );
  expect(screen.getByText('3 of 8')).toBeTruthy();
  const bar = screen.getByRole('progressbar');
  expect(bar.getAttribute('aria-valuemin')).toBe('0');
  expect(bar.getAttribute('aria-valuemax')).toBe('100');
  expect(bar.getAttribute('aria-valuenow')).toBe('44');
  expect(bar.getAttribute('aria-valuetext')).toBe('3 of 8');
  const button = screen.getByRole('button', { name: 'Cancel' });
  expect(button.getAttribute('title')).toBe('Stops after the current file');
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button);
  expect(onCancel).toHaveBeenCalledTimes(1);

  rerender(<ImportProgressView progress={progressOf({ done: 3, total: 8, cancelling: true })} onCancel={onCancel} />);
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
});

it('the import title ends with ", cancelled" after a cancel', () => {
  const results = [importResultOf('C:\\in\\a.png', { file: fileRecord() })];
  expect(importTitle(results, { duplicates: false, cancelled: true })).toBe('1 imported, 0 failed, cancelled');
  expect(importTitle(results, { duplicates: true, cancelled: true })).toBe(
    '1 imported, 0 failed, 0 duplicates, cancelled',
  );
  expect(importTitle(results, { duplicates: false, cancelled: false })).toBe('1 imported, 0 failed');
  expect(importTitle(results, { duplicates: false })).toBe('1 imported, 0 failed');
});
