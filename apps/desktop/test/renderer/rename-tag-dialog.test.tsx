import { normalizeTagName, type TagRenameResult, type TagUsage } from '@assetforge/contracts';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RenameTagDialog } from '../../src/renderer/src/components/RenameTagDialog';
import { SEARCH_DEBOUNCE_MS } from '../../src/renderer/src/hooks/useDebouncedValue';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const usage = (name: string, displayName: string, files: number, assets: number): TagUsage => ({
  exists: true,
  name,
  displayName,
  files,
  assets,
});

/** Tags known to the fake `tags:usage`; any other valid text is free. */
function usageTable(): Map<string, TagUsage> {
  return new Map([
    ['front view', usage('front view', 'Front View', 42, 3)],
    ['front', usage('front', 'Front', 118, 5)],
    ['oak', usage('oak', 'Oak', 1, 1)],
  ]);
}

function lookup(table: Map<string, TagUsage>, text: string): TagUsage {
  const name = normalizeTagName(text);
  if (name === null) return { exists: false, name: '', displayName: '', files: 0, assets: 0 };
  return table.get(name) ?? { exists: false, name, displayName: '', files: 0, assets: 0 };
}

function setup(
  handlers: FakeHandlers = {},
  tag: { name: string; displayName: string } = { name: 'front view', displayName: 'Front View' },
) {
  const table = usageTable();
  const api = installFakeApi({ 'tags:usage': ({ name }) => lookup(table, name), ...handlers });
  const onClose = vi.fn();
  const onRenamed = vi.fn();
  render(<RenameTagDialog tag={tag} onClose={onClose} onRenamed={onRenamed} />);
  return { api, table, onClose, onRenamed };
}

const field = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
const confirmButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /^(Rename|Merge)$/ });
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
/** Lets the debounce run out and the fake answers arrive. */
const settle = (ms: number = SEARCH_DEBOUNCE_MS) => act(() => vi.advanceTimersByTimeAsync(ms));
const usageRequests = (api: ReturnType<typeof setup>['api']) =>
  api.calls.filter((c) => c.channel === 'tags:usage').map((c) => c.request);
const renameRequests = (api: ReturnType<typeof setup>['api']) =>
  api.calls.filter((c) => c.channel === 'tags:rename').map((c) => c.request);

it('opens with the display name selected and the usage of the tag', async () => {
  const { api } = setup();
  expect(screen.getByRole('dialog', { name: 'Rename tag' })).not.toBeNull();
  const input = field();
  expect(input.value).toBe('Front View');
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe('Front View'.length);
  await settle(0);
  expect(screen.getByText('Front View · 42 files · 3 assets')).not.toBeNull();
  expect(usageRequests(api)).toEqual([{ name: 'front view' }]);
  expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeNull();
});

it('the usage line uses the singular for one file and one asset', async () => {
  setup({}, { name: 'oak', displayName: 'Oak' });
  await settle(0);
  expect(screen.getByText('Oak · 1 file · 1 asset')).not.toBeNull();
});

it('confirm is disabled for an unchanged, empty or invalid name, and an invalid one is not looked up', async () => {
  const { api } = setup();
  await settle(0);
  expect(confirmButton().disabled).toBe(true);
  type('  Front   View ');
  await settle();
  expect(confirmButton().disabled).toBe(true);
  type('');
  await settle();
  expect(confirmButton().disabled).toBe(true);
  type('!!!');
  await settle();
  expect(confirmButton().disabled).toBe(true);
  expect(usageRequests(api)).toEqual([{ name: 'front view' }]);
});

it('a free name is looked up once after 250 ms and confirm waits for the answer', async () => {
  const answer = deferred<TagUsage>();
  const { api } = setup({
    'tags:usage': ({ name }) => (name === 'side' ? answer.promise : lookup(usageTable(), name)),
    'tags:rename': () => ({ name: 'side', displayName: 'Side', merged: false }),
  });
  await settle(0);
  type('S');
  type('Si');
  type('Side');
  await settle(SEARCH_DEBOUNCE_MS - 1);
  expect(usageRequests(api)).toEqual([{ name: 'front view' }]);
  await settle(1);
  expect(usageRequests(api)).toEqual([{ name: 'front view' }, { name: 'side' }]);
  expect(confirmButton().textContent).toBe('Rename');
  expect(confirmButton().disabled).toBe(true);

  await act(async () => answer.resolve({ exists: false, name: 'side', displayName: '', files: 0, assets: 0 }));
  expect(confirmButton().disabled).toBe(false);
  expect(confirmButton().textContent).toBe('Rename');
  expect(screen.queryByText(/^Merges with/)).toBeNull();

  fireEvent.click(confirmButton());
  await settle(0);
  expect(renameRequests(api)).toEqual([{ from: 'front view', to: 'Side', merge: false }]);
});

it('the name of another tag shows the merge line and confirms a merge', async () => {
  const { api } = setup({ 'tags:rename': () => ({ name: 'front', displayName: 'Front', merged: true }) });
  await settle(0);
  type('  front ');
  await settle();
  expect(screen.getByText('Merges with Front · 118 files · 5 assets')).not.toBeNull();
  expect(confirmButton().textContent).toBe('Merge');
  expect(confirmButton().disabled).toBe(false);
  fireEvent.click(confirmButton());
  await settle(0);
  expect(renameRequests(api)).toEqual([{ from: 'front view', to: 'front', merge: true }]);
});

it('another spelling of the same tag is a plain rename without a lookup', async () => {
  const { api } = setup(
    { 'tags:rename': () => ({ name: 'front', displayName: 'Front', merged: false }) },
    { name: 'front', displayName: 'front' },
  );
  await settle(0);
  type('Front');
  expect(confirmButton().textContent).toBe('Rename');
  expect(confirmButton().disabled).toBe(false);
  await settle();
  expect(screen.queryByText(/^Merges with/)).toBeNull();
  expect(usageRequests(api)).toEqual([{ name: 'front' }]);
  fireEvent.click(confirmButton());
  await settle(0);
  expect(renameRequests(api)).toEqual([{ from: 'front', to: 'Front', merge: false }]);
});

it('a stale lookup answer is dropped', async () => {
  const first = deferred<TagUsage>();
  setup({
    'tags:usage': ({ name }) => (name === 'oak' ? first.promise : lookup(usageTable(), name)),
  });
  await settle(0);
  type('oak');
  await settle();
  type('side');
  await settle();
  expect(confirmButton().textContent).toBe('Rename');
  expect(confirmButton().disabled).toBe(false);
  await act(async () => first.resolve(usage('oak', 'Oak', 1, 1)));
  expect(screen.queryByText(/^Merges with/)).toBeNull();
  expect(confirmButton().textContent).toBe('Rename');
  expect(confirmButton().disabled).toBe(false);
});

it('success reports the response values and then closes', async () => {
  const { onRenamed, onClose } = setup({
    'tags:rename': (): TagRenameResult => ({ name: 'front', displayName: 'Front', merged: true }),
  });
  await settle(0);
  type('FRONT');
  await settle();
  fireEvent.click(confirmButton());
  await settle(0);
  expect(onRenamed).toHaveBeenCalledWith({ from: 'front view', name: 'front', displayName: 'Front' });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onRenamed.mock.invocationCallOrder[0]!).toBeLessThan(onClose.mock.invocationCallOrder[0]!);
});

it('a target that appeared meanwhile shows the message, looks up again and offers the merge', async () => {
  let table = usageTable();
  const { api, onClose } = setup({
    'tags:usage': ({ name }) => lookup(table, name),
    'tags:rename': ({ merge }) => {
      if (!merge) {
        table = new Map([...table, ['side', usage('side', 'Side', 2, 1)]]);
        throw fakeError('invalid_operation', 'A tag with this name already exists');
      }
      return { name: 'side', displayName: 'Side', merged: true };
    },
  });
  await settle(0);
  type('Side');
  await settle();
  expect(confirmButton().textContent).toBe('Rename');
  fireEvent.click(confirmButton());
  await settle(0);
  expect(screen.getByRole('alert').textContent).toBe('A tag with this name already exists');
  expect(usageRequests(api).filter((r) => (r as { name: string }).name === 'side')).toHaveLength(2);
  expect(screen.getByText('Merges with Side · 2 files · 1 asset')).not.toBeNull();
  expect(confirmButton().textContent).toBe('Merge');
  expect(confirmButton().disabled).toBe(false);
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(confirmButton());
  await settle(0);
  expect(renameRequests(api).at(-1)).toEqual({ from: 'front view', to: 'Side', merge: true });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('a vanished tag shows the message and leaves only closing', async () => {
  const { onClose, onRenamed } = setup({
    'tags:rename': () => {
      throw fakeError('not_found', 'Tag front view does not exist');
    },
  });
  await settle(0);
  type('Side');
  await settle();
  fireEvent.click(confirmButton());
  await settle(0);
  expect(screen.getByRole('alert').textContent).toBe('This item no longer exists.');
  expect(field().disabled).toBe(true);
  expect(confirmButton().disabled).toBe(true);
  expect(onRenamed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('Enter confirms only when confirm is enabled and a second activation sends nothing', async () => {
  const pending = deferred<TagRenameResult>();
  const { api, onClose } = setup({ 'tags:rename': () => pending.promise });
  await settle(0);
  fireEvent.keyDown(field(), { key: 'Enter' });
  await settle(0);
  expect(renameRequests(api)).toEqual([]);

  type('Side');
  await settle();
  fireEvent.keyDown(field(), { key: 'Enter' });
  fireEvent.keyDown(field(), { key: 'Enter' });
  fireEvent.click(confirmButton());
  await settle(0);
  expect(renameRequests(api)).toEqual([{ from: 'front view', to: 'Side', merge: false }]);

  await act(async () => pending.resolve({ name: 'side', displayName: 'Side', merged: false }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
