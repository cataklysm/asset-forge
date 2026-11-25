import type { TagAssignment, TagSuggestion } from '@assetforge/contracts';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { ApiError } from '../../src/renderer/src/api';
import { TagChip } from '../../src/renderer/src/components/TagChip';
import { TagCombobox } from '../../src/renderer/src/components/TagCombobox';
import { TagFilter } from '../../src/renderer/src/components/TagFilter';
import { TagList } from '../../src/renderer/src/components/TagList';
import { TagRow } from '../../src/renderer/src/components/TagRow';
import { deferred, installFakeApi } from './fake-api';
import { tagOf } from './fixtures';

const INVALID = 'Tags need a letter or digit and at most 64 characters.';

function RowHarness(props: {
  initial: TagAssignment[];
  onAdd?(displayName: string): Promise<void>;
  onRemove?(name: string): Promise<void>;
}) {
  const [tags, setTags] = useState(props.initial);
  return (
    <TagRow
      label="Asset tags"
      kind="asset"
      tags={tags}
      onAdd={async (displayName) => {
        await props.onAdd?.(displayName);
        setTags((current) => [...current, tagOf(displayName)]);
      }}
      onRemove={async (name) => {
        await props.onRemove?.(name);
        setTags((current) => current.filter((t) => t.name !== name));
      }}
    />
  );
}

it('Enter adds the typed tag', async () => {
  installFakeApi({ 'tags:suggest': () => [] });
  const user = userEvent.setup();
  const onAdd = vi.fn(async () => {});
  render(<RowHarness initial={[]} onAdd={onAdd} />);
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Add asset tag' });
  expect(input.placeholder).toBe('+ Add tag');
  await user.type(input, '  Oak ');
  await user.keyboard('{Enter}');
  expect(onAdd).toHaveBeenCalledWith('Oak');
  expect(input.value).toBe('');
  expect(screen.getByRole('button', { name: 'Remove Oak' })).not.toBeNull();
  expect(screen.getByRole('group', { name: 'Asset tags' })).not.toBeNull();
});

it('Backspace in the empty input focuses the last chip and Delete removes it keeping focus in the row', async () => {
  installFakeApi({ 'tags:suggest': () => [] });
  const user = userEvent.setup();
  const onRemove = vi.fn(async () => {});
  render(<RowHarness initial={[tagOf('oak'), tagOf('bark')]} onRemove={onRemove} />);
  const input = screen.getByRole('combobox', { name: 'Add asset tag' });
  await user.click(input);
  await user.keyboard('{Backspace}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove bark' }));

  await user.keyboard('{Delete}');
  expect(onRemove).toHaveBeenCalledWith('bark');
  expect(screen.queryByRole('button', { name: 'Remove bark' })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove oak' }));

  await user.keyboard('{Backspace}');
  expect(onRemove).toHaveBeenLastCalledWith('oak');
  expect(document.activeElement).toBe(input);
});

it('removing a chip moves focus to the next chip', async () => {
  installFakeApi({ 'tags:suggest': () => [] });
  const user = userEvent.setup();
  render(<RowHarness initial={[tagOf('oak'), tagOf('bark'), tagOf('moss')]} />);
  screen.getByRole('button', { name: 'Remove oak' }).focus();
  await user.keyboard('{Delete}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove bark' }));
});

it('invalid tag text sends nothing and shows an alert', async () => {
  installFakeApi({ 'tags:suggest': () => [] });
  const user = userEvent.setup();
  const onAdd = vi.fn(async () => {});
  render(<RowHarness initial={[]} onAdd={onAdd} />);
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Add asset tag' });

  await user.type(input, '!!!{Enter}');
  expect(onAdd).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe(INVALID);
  expect(input.value).toBe('!!!');

  await user.clear(input);
  expect(screen.queryByRole('alert')).toBeNull();
  await user.click(input);
  await user.paste('a'.repeat(65));
  await user.keyboard('{Enter}');
  expect(onAdd).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe(INVALID);
  expect(input.value).toBe('a'.repeat(65));
});

it('a rejected add or remove shows the error inline', async () => {
  installFakeApi({ 'tags:suggest': () => [] });
  const user = userEvent.setup();
  const gone = new ApiError('not_found', 'Asset x does not exist');
  render(
    <RowHarness
      initial={[tagOf('oak')]}
      onAdd={() => Promise.reject(gone)}
      onRemove={() => Promise.reject(gone)}
    />,
  );
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Add asset tag' });
  await user.type(input, 'Bark{Enter}');
  expect(screen.getByRole('alert').textContent).toBe('This item no longer exists.');
  expect(input.value).toBe('Bark');

  const remove = screen.getByRole('button', { name: 'Remove oak' });
  await user.click(remove);
  expect(screen.getByRole('alert').textContent).toBe('This item no longer exists.');
  expect(screen.getByRole('button', { name: 'Remove oak' })).not.toBeNull();
});

function ComboHarness({ onCommit }: { onCommit(text: string): void }) {
  const [value, setValue] = useState('');
  return (
    <TagCombobox value={value} onValueChange={setValue} onCommit={onCommit} placeholder="Tags" label="Tags" />
  );
}

it('the combobox shows suggestions and a superseded answer is dropped', async () => {
  const first = deferred<TagSuggestion[]>();
  const api = installFakeApi({
    'tags:suggest': ({ prefix }) => (prefix === 'o' ? first.promise : [{ name: 'oak', displayName: 'Oak' }]),
  });
  const user = userEvent.setup();
  const onCommit = vi.fn();
  render(<ComboHarness onCommit={onCommit} />);
  const input = screen.getByRole('combobox', { name: 'Tags' });
  expect(input.getAttribute('aria-expanded')).toBe('false');
  expect(input.getAttribute('aria-autocomplete')).toBe('list');

  await user.type(input, 'Oa');
  await screen.findByRole('option', { name: 'Oak' });
  await act(async () => {
    first.resolve([{ name: 'olive', displayName: 'Olive' }]);
    await first.promise;
  });
  expect(screen.queryByRole('option', { name: 'Olive' })).toBeNull();
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(api.calls.filter((c) => c.channel === 'tags:suggest').map((c) => c.request)).toEqual([
    { prefix: 'o', limit: 8 },
    { prefix: 'oa', limit: 8 },
  ]);

  const listbox = screen.getByRole('listbox');
  expect(input.getAttribute('aria-expanded')).toBe('true');
  expect(input.getAttribute('aria-controls')).toBe(listbox.id);

  await user.keyboard('{ArrowDown}');
  const option = screen.getByRole('option', { name: 'Oak' });
  expect(input.getAttribute('aria-activedescendant')).toBe(option.id);
  expect(option.getAttribute('aria-selected')).toBe('true');

  await user.keyboard('{Enter}');
  expect(onCommit).toHaveBeenCalledWith('Oak');
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('Esc closes the suggestion list first and is left to the caller afterwards', async () => {
  installFakeApi({ 'tags:suggest': () => [{ name: 'oak', displayName: 'Oak' }] });
  const user = userEvent.setup();
  const onKeyDown = vi.fn();
  const onCommit = vi.fn();
  function Harness() {
    const [value, setValue] = useState('');
    return (
      <TagCombobox
        value={value}
        onValueChange={setValue}
        onCommit={onCommit}
        onKeyDown={(e) => onKeyDown(e.key)}
        placeholder="Tags"
        label="Tags"
      />
    );
  }
  render(<Harness />);
  await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'o');
  await screen.findByRole('option', { name: 'Oak' });
  onKeyDown.mockClear();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(onKeyDown).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(onKeyDown).toHaveBeenCalledWith('Escape');

  await user.keyboard('{Enter}');
  expect(onCommit).toHaveBeenCalledWith('o');
});

it('clicking a suggestion commits it', async () => {
  installFakeApi({ 'tags:suggest': () => [{ name: 'oak', displayName: 'Oak' }] });
  const user = userEvent.setup();
  const onCommit = vi.fn();
  render(<ComboHarness onCommit={onCommit} />);
  await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'o');
  await user.click(await screen.findByRole('option', { name: 'Oak' }));
  expect(onCommit).toHaveBeenCalledWith('Oak');
});

it('file tag lists start with one image icon; asset tag lists do not', () => {
  render(
    <>
      <TagList kind="file" tags={[tagOf('bark'), tagOf('moss')]} max={3} />
      <TagList kind="asset" tags={[tagOf('oak')]} max={3} />
    </>,
  );
  expect(screen.getAllByLabelText('Image tags')).toHaveLength(1);
  expect(screen.getByLabelText('Asset tags').querySelector('svg')).toBeNull();
  expect(screen.getByText('bark')).not.toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

it('overflow shows +n with all names in the title', () => {
  const tags = ['a', 'b', 'c', 'd', 'e'].map((n) => tagOf(n));
  render(<TagList kind="asset" tags={tags} max={3} matched={new Set(['b'])} />);
  const more = screen.getByText('+2');
  expect(more.getAttribute('title')).toBe('a, b, c, d, e');
  expect(screen.queryByText('d')).toBeNull();
  const list = screen.getByLabelText('Asset tags');
  expect(list.querySelectorAll('[data-matched]')).toHaveLength(1);
});

it('a chip carries its origin and a filter chip uses the filter look', () => {
  render(
    <>
      <TagChip tag={tagOf('oak', 'ai')} />
      <TagChip tag={{ name: 'bark', displayName: 'bark' }} filter onRemove={() => {}} />
    </>,
  );
  expect(screen.getByText('oak').closest('[data-origin]')?.getAttribute('data-origin')).toBe('ai');
  expect(screen.getByText('bark').closest('span[class*="border-accent"]')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Remove bark' })).not.toBeNull();
});

function FilterHarness({ onChange }: { onChange(names: string[]): void }) {
  const [value, setValue] = useState<string[]>([]);
  return (
    <TagFilter
      value={value}
      title="Image tags"
      onChange={(names) => {
        onChange(names);
        setValue(names);
      }}
    />
  );
}

it('the tag filter stops at 10 tags', async () => {
  installFakeApi({ 'tags:suggest': () => [] });
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<FilterHarness onChange={onChange} />);
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Tags' });
  expect(input.title).toBe('Image tags');

  await user.type(input, 'Oak{Enter}');
  expect(onChange).toHaveBeenLastCalledWith(['oak']);
  expect(input.value).toBe('');
  await user.type(input, 'OAK {Enter}');
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(input.value).toBe('');

  for (let i = 1; i < 10; i += 1) await user.type(input, `t${i}{Enter}`);
  expect(onChange).toHaveBeenLastCalledWith(['oak', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']);
  expect(input.disabled).toBe(true);
  expect(input.title).toBe('At most 10 tags');

  await user.click(screen.getByRole('button', { name: 'Remove oak' }));
  expect(onChange).toHaveBeenLastCalledWith(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']);
  expect(input.disabled).toBe(false);
  expect(document.activeElement).toBe(input);
});
