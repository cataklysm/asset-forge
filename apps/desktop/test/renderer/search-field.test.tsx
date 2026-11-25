import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { FilterBar } from '../../src/renderer/src/components/FilterBar';
import { SearchField } from '../../src/renderer/src/components/SearchField';
import { SelectionBar } from '../../src/renderer/src/components/SelectionBar';

function Harness({ outer }: { outer(key: string): void }) {
  const [value, setValue] = useState('');
  return (
    <div onKeyDown={(e) => outer(e.key)}>
      <SearchField value={value} onChange={setValue} placeholder="Search assets" label="Search assets" />
    </div>
  );
}

it('Esc clears the search field', async () => {
  const user = userEvent.setup();
  const outer = vi.fn();
  render(<Harness outer={outer} />);
  const input = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search assets' });
  expect(input.type).toBe('search');
  expect(input.title).toBe('Ctrl+F');
  expect(input.maxLength).toBe(200);
  expect(input.placeholder).toBe('Search assets');
  expect(input.hasAttribute('data-search-field')).toBe(true);
  expect(input.parentElement?.querySelector('svg')).not.toBeNull();

  await user.type(input, 'oak');
  outer.mockClear();
  await user.keyboard('{Escape}');
  expect(input.value).toBe('');
  expect(outer).not.toHaveBeenCalled();

  await user.keyboard('{Escape}');
  expect(outer).toHaveBeenCalledWith('Escape');
});

it('the filter bar shows the count and Clear filters only when clearing is possible', async () => {
  const user = userEvent.setup();
  const onClear = vi.fn();
  const { rerender } = render(
    <FilterBar resultCount="3 assets" onClear={onClear} countTitle="Capped">
      <input aria-label="Row one" />
    </FilterBar>,
  );
  expect(screen.getByText('3 assets').getAttribute('title')).toBe('Capped');
  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(onClear).toHaveBeenCalledTimes(1);

  rerender(
    <FilterBar resultCount={null} onClear={null}>
      <input aria-label="Row one" />
    </FilterBar>,
  );
  expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  expect(screen.queryByText('3 assets')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Row one' })).not.toBeNull();
});

it('the selection bar renders only with a selection', async () => {
  const user = userEvent.setup();
  const onClear = vi.fn();
  const { rerender } = render(
    <SelectionBar count={0} onClear={onClear}>
      <button type="button">Add tags</button>
    </SelectionBar>,
  );
  expect(screen.queryByText(/selected/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add tags' })).toBeNull();

  rerender(
    <SelectionBar count={3} onClear={onClear}>
      <button type="button">Add tags</button>
    </SelectionBar>,
  );
  expect(screen.getByText('3 selected')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Add tags' })).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'Clear selection' }));
  expect(onClear).toHaveBeenCalledTimes(1);
});
