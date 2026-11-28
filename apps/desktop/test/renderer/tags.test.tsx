import type { TagAssignment, TagSuggestion } from '@assetforge/contracts';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ApiError } from '../../src/renderer/src/api';
import { TagChip } from '../../src/renderer/src/components/TagChip';
import { TagCombobox } from '../../src/renderer/src/components/TagCombobox';
import { TagFilter } from '../../src/renderer/src/components/TagFilter';
import { TagList } from '../../src/renderer/src/components/TagList';
import { TagRow } from '../../src/renderer/src/components/TagRow';
import { renameInTags, type TagRename } from '../../src/renderer/src/tag-rename';
import { TagsProvider, useRenamed } from '../../src/renderer/src/tags-context';
import { AI_CHIP, CHIP, FILTER_CHIP, MATCHED_CHIP } from '../../src/renderer/src/ui';
import { deferred, installFakeApi } from './fake-api';
import { tagOf } from './fixtures';
import { RenameTrigger, renameHandlers, renameThroughDialog } from './rename-flow';

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
    <RowHarness initial={[tagOf('oak')]} onAdd={() => Promise.reject(gone)} onRemove={() => Promise.reject(gone)} />,
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
  return <TagCombobox value={value} onValueChange={setValue} onCommit={onCommit} placeholder="Tags" label="Tags" />;
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

it('the combobox names its list only while the list is shown', async () => {
  installFakeApi({ 'tags:suggest': () => [{ name: 'oak', displayName: 'Oak' }] });
  const user = userEvent.setup();
  render(<ComboHarness onCommit={() => {}} />);
  const input = screen.getByRole('combobox', { name: 'Tags' });
  expect(input.hasAttribute('aria-controls')).toBe(false);
  await user.type(input, 'o');
  const listbox = await screen.findByRole('listbox');
  expect(input.getAttribute('aria-controls')).toBe(listbox.id);
  await user.keyboard('{Escape}');
  expect(input.hasAttribute('aria-controls')).toBe(false);
});

it('typing on drops the active suggestion before the new answer arrives', async () => {
  const later = deferred<TagSuggestion[]>();
  installFakeApi({
    'tags:suggest': ({ prefix }) => (prefix === 'o' ? [{ name: 'oak', displayName: 'Oak' }] : later.promise),
  });
  const user = userEvent.setup();
  const onCommit = vi.fn();
  render(<ComboHarness onCommit={onCommit} />);
  const input = screen.getByRole('combobox', { name: 'Tags' });
  await user.type(input, 'o');
  await screen.findByRole('option', { name: 'Oak' });
  await user.keyboard('{ArrowDown}');
  expect(input.hasAttribute('aria-activedescendant')).toBe(true);

  await user.keyboard('l');
  expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  await user.keyboard('{Enter}');
  expect(onCommit).toHaveBeenCalledWith('ol');
});

it('Enter that confirms an input method composition commits nothing', async () => {
  installFakeApi({ 'tags:suggest': () => [] });
  const user = userEvent.setup();
  const onCommit = vi.fn();
  render(<ComboHarness onCommit={onCommit} />);
  const input = screen.getByRole('combobox', { name: 'Tags' });
  await user.type(input, 'ka');
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onCommit).toHaveBeenCalledWith('ka');
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

it('without a limit every tag is shown and there is no +n chip', () => {
  const tags = ['a', 'b', 'c', 'd', 'e'].map((n) => tagOf(n));
  render(<TagList kind="asset" tags={tags} wrap />);
  expect(screen.getByLabelText('Asset tags').querySelectorAll('li')).toHaveLength(5);
  expect(screen.queryByText(/^\+/)).toBeNull();
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

const classesOf = (text: string) => (screen.getByText(text).parentElement as HTMLElement).className;

it('an AI chip uses the AI look, a title and a distinct remove label', () => {
  render(<TagChip tag={tagOf('Car', 'ai')} onRemove={() => {}} />);
  const chip = screen.getByText('Car').parentElement as HTMLElement;
  expect(chip.className).toContain(AI_CHIP);
  expect(chip.getAttribute('title')).toBe('AI tag');
  expect(screen.getByRole('button', { name: 'Remove AI tag Car' })).not.toBeNull();
});

it('manual, filter and matched chips keep their look and have no AI title', () => {
  render(
    <>
      <TagChip tag={tagOf('Car')} onRemove={() => {}} />
      <TagChip tag={tagOf('Filt', 'ai')} filter />
      <TagChip tag={tagOf('Match', 'ai')} matched />
    </>,
  );
  expect(classesOf('Car')).toContain(CHIP);
  expect(classesOf('Filt')).toContain(FILTER_CHIP);
  expect(classesOf('Match')).toContain(MATCHED_CHIP);
  for (const text of ['Car', 'Filt', 'Match'])
    expect((screen.getByText(text).parentElement as HTMLElement).hasAttribute('title')).toBe(false);
  expect(screen.getByRole('button', { name: 'Remove Car' })).not.toBeNull();
});

it('the AI colour has a contrast of at least 4.5 on the page and surface backgrounds', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/index.css'), 'utf8');
  const channels = (name: string) => {
    const m = css.match(new RegExp(`--color-${name}: *#([0-9a-f]{6});`, 'i'));
    if (!m) throw new Error(`token ${name} missing`);
    return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255);
  };
  const luminance = (name: string) => {
    const [r, g, b] = channels(name).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
      number,
      number,
      number,
    ];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  expect(contrast('ai', 'bg')).toBeGreaterThanOrEqual(4.5);
  expect(contrast('ai', 'surface')).toBeGreaterThanOrEqual(4.5);
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
  await user.type(input, '!!!{Enter}');
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Remove !!!' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toBe(INVALID);
  expect(input.value).toBe('!!!');
  await user.clear(input);
  expect(screen.queryByRole('alert')).toBeNull();

  for (let i = 1; i < 10; i += 1) await user.type(input, `t${i}{Enter}`);
  expect(onChange).toHaveBeenLastCalledWith(['oak', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']);
  expect(input.readOnly).toBe(true);
  // It looks disabled, since it takes no more names.
  expect(input.getAttribute('aria-disabled')).toBe('true');
  expect(input.title).toBe('At most 10 tags');
  // The input that added the tenth tag keeps the focus.
  expect(document.activeElement).toBe(input);
  await user.keyboard('x{Enter}');
  expect(onChange).toHaveBeenCalledTimes(10);
  expect(input.value).toBe('');

  await user.click(screen.getByRole('button', { name: 'Remove oak' }));
  expect(onChange).toHaveBeenLastCalledWith(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']);
  expect(input.readOnly).toBe(false);
  expect(input.getAttribute('aria-disabled')).toBeNull();
  expect(document.activeElement).toBe(input);
});

const TAG_USAGE = {
  'tags:usage': ({ name }: { name: string }) => ({
    exists: true,
    name,
    displayName: name,
    files: 1,
    assets: 0,
    prompts: 0,
  }),
};

it('a chip with onRename shows the pencil before the remove button; without it none', () => {
  render(
    <>
      <TagChip tag={tagOf('oak')} onRemove={() => {}} onRename={() => {}} />
      <TagChip tag={tagOf('bark')} onRemove={() => {}} />
    </>,
  );
  const pencil = screen.getByRole('button', { name: 'Rename oak' });
  expect(pencil.getAttribute('title')).toBe('Rename');
  expect(pencil.hasAttribute('data-rename')).toBe(true);
  const oakButtons = [...(screen.getByText('oak').parentElement as HTMLElement).querySelectorAll('button')];
  expect(oakButtons.map((b) => b.getAttribute('aria-label'))).toEqual(['Rename oak', 'Remove oak']);
  expect(oakButtons[1]!.hasAttribute('data-remove')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Rename bark' })).toBeNull();
});

it('a row inside a TagsProvider has a pencil per chip, none when disabled and none outside a provider', () => {
  installFakeApi({ 'tags:suggest': () => [], ...TAG_USAGE });
  const tags = [tagOf('oak'), tagOf('Car', 'ai')];
  const row = (disabled: boolean) => (
    <TagRow
      label="Asset tags"
      kind="asset"
      tags={tags}
      onAdd={async () => {}}
      onRemove={async () => {}}
      disabled={disabled}
    />
  );
  const { rerender, unmount } = render(<TagsProvider>{row(false)}</TagsProvider>);
  expect(screen.getByRole('button', { name: 'Rename oak' })).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Rename Car' })).not.toBeNull();
  rerender(<TagsProvider>{row(true)}</TagsProvider>);
  expect(screen.queryByRole('button', { name: /^Rename/ })).toBeNull();
  unmount();
  render(row(false));
  expect(screen.getByRole('button', { name: 'Remove oak' })).not.toBeNull();
  expect(screen.queryByRole('button', { name: /^Rename/ })).toBeNull();
});

it('clicking the pencil opens the rename dialog for that tag', async () => {
  installFakeApi({ 'tags:suggest': () => [], ...TAG_USAGE });
  const user = userEvent.setup();
  render(
    <TagsProvider>
      <RowHarness initial={[tagOf('oak'), tagOf('Car', 'ai')]} />
    </TagsProvider>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Rename Car' }));
  expect(screen.getByRole('dialog', { name: 'Rename tag' })).not.toBeNull();
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('Car');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Delete and Backspace on a focused pencil remove nothing; on the remove button they still remove', async () => {
  installFakeApi({ 'tags:suggest': () => [], ...TAG_USAGE });
  const user = userEvent.setup();
  const onRemove = vi.fn(async () => {});
  render(
    <TagsProvider>
      <RowHarness initial={[tagOf('oak'), tagOf('bark')]} onRemove={onRemove} />
    </TagsProvider>,
  );
  screen.getByRole('button', { name: 'Rename oak' }).focus();
  await user.keyboard('{Delete}');
  await user.keyboard('{Backspace}');
  expect(onRemove).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Remove oak' })).not.toBeNull();

  screen.getByRole('button', { name: 'Remove oak' }).focus();
  await user.keyboard('{Delete}');
  expect(onRemove).toHaveBeenCalledWith('oak');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove bark' }));
});

it('with pencils, Backspace in the empty input and a removal still focus remove buttons', async () => {
  installFakeApi({ 'tags:suggest': () => [], ...TAG_USAGE });
  const user = userEvent.setup();
  render(
    <TagsProvider>
      <RowHarness initial={[tagOf('oak'), tagOf('bark'), tagOf('moss')]} />
    </TagsProvider>,
  );
  await user.click(screen.getByRole('combobox', { name: 'Add asset tag' }));
  await user.keyboard('{Backspace}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove moss' }));
  await user.keyboard('{Backspace}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove bark' }));
  screen.getByRole('button', { name: 'Remove oak' }).focus();
  await user.keyboard('{Delete}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove bark' }));
});

/** A row whose tags follow every rename, at once or only when `release` is called (like a list reload). */
function RenamingRowHarness({
  initial,
  later = false,
  drop = false,
}: {
  initial: TagAssignment[];
  later?: boolean;
  drop?: boolean;
}) {
  const [tags, setTags] = useState(initial);
  const [held, setHeld] = useState<TagRename | null>(null);
  useRenamed((change) => {
    if (later) setHeld(change);
    else
      setTags((current) => (drop ? current.filter((t) => t.name !== change.from) : [...renameInTags(current, change)]));
  });
  return (
    <>
      <TagRow label="Asset tags" kind="asset" tags={tags} onAdd={async () => {}} onRemove={async () => {}} />
      <button
        type="button"
        onClick={() => {
          if (held !== null) setTags((current) => [...renameInTags(current, held)]);
          setHeld(null);
        }}
      >
        release
      </button>
    </>
  );
}

it('after a rename from a pencil the pencil of the renamed chip has focus', async () => {
  installFakeApi({ 'tags:suggest': () => [], ...renameHandlers({ oak: 'oak', bark: 'bark' }) });
  const user = userEvent.setup();
  render(
    <TagsProvider>
      <RenamingRowHarness initial={[tagOf('oak'), tagOf('bark')]} />
    </TagsProvider>,
  );
  await renameThroughDialog(user, 'oak', 'Side');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename Side' })));
});

it('after a merge from a pencil the pencil of the kept chip has focus', async () => {
  installFakeApi({ 'tags:suggest': () => [], ...renameHandlers({ oak: 'oak', bark: 'bark' }) });
  const user = userEvent.setup();
  render(
    <TagsProvider>
      <RenamingRowHarness initial={[tagOf('oak'), tagOf('bark')]} />
    </TagsProvider>,
  );
  await renameThroughDialog(user, 'oak', 'bark');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename bark' })));
  expect(screen.queryByRole('button', { name: 'Rename oak' })).toBeNull();
});

it('a rename that reaches the row only later still focuses the renamed chip', async () => {
  installFakeApi({ 'tags:suggest': () => [], ...renameHandlers({ oak: 'oak' }) });
  const user = userEvent.setup();
  render(
    <TagsProvider>
      <RenamingRowHarness initial={[tagOf('oak'), tagOf('bark')]} later />
    </TagsProvider>,
  );
  await renameThroughDialog(user, 'oak', 'Side');
  // Focus is back on the old pencil until the row's tags change.
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename oak' }));
  act(() => screen.getByRole('button', { name: 'release' }).click());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename Side' })));
});

it('when the renamed chip is not in the row afterwards the input has focus', async () => {
  installFakeApi({ 'tags:suggest': () => [], ...renameHandlers({ oak: 'oak' }) });
  const user = userEvent.setup();
  render(
    <TagsProvider>
      <RenamingRowHarness initial={[tagOf('oak'), tagOf('bark')]} drop />
    </TagsProvider>,
  );
  await renameThroughDialog(user, 'oak', 'Side');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Add asset tag' })));
});

it('a rename started elsewhere after a cancelled one moves no focus into the row', async () => {
  installFakeApi({ 'tags:suggest': () => [], ...renameHandlers({ oak: 'oak' }) });
  const user = userEvent.setup();
  render(
    <TagsProvider>
      <RenamingRowHarness initial={[tagOf('oak'), tagOf('bark')]} />
      <RenameTrigger tag={{ name: 'oak', displayName: 'oak' }} />
    </TagsProvider>,
  );
  await user.click(screen.getAllByRole('button', { name: 'Rename oak' })[0]!);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  const trigger = screen.getAllByRole('button', { name: 'Rename oak' })[1]!;
  await user.click(trigger);
  const field = screen.getByRole('textbox', { name: 'Name' });
  await user.clear(field);
  await user.type(field, 'Side');
  const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Rename' });
  await waitFor(() => expect(confirm.disabled).toBe(false));
  await user.click(confirm);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Side' })).not.toBeNull());
  expect(document.activeElement).toBe(trigger);
});
