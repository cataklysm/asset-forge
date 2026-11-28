import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { useLoad } from '../hooks/useLoad';
import { ALERT, BORDER, INPUT, ITEM_HOVER, MUTED } from '../ui';

// A search field that picks one entry of a list the main process searches: the asset picker, the project picker
// and the project filter of the gallery share it.

/** What a picker offers: an id and a name to show. */
export interface PickerEntry {
  id: string;
  name: string;
}

/** The props of `SearchPicker`. */
export interface SearchPickerProps<T extends PickerEntry> {
  /** The accessible name and placeholder of the input. */
  label: string;
  /** The accessible name of the result list. */
  listLabel: string;
  /** Shown in the open list when nothing matches. */
  emptyText: string;
  /** The tooltip of the input. */
  title?: string;
  /** Reads the first page of matches; '' for no search text. */
  search(term: string, limit: number): Promise<{ items: T[] }>;
  /** Entries that are never offered. */
  excludeIds?: readonly string[];
  /** Receives the picked entry; a second pick waits until it has settled. */
  onPick(entry: T): void | Promise<void>;
  /** Stretches the search input to the width of its container. */
  fullWidth?: boolean;
}

/** The number of results shown. */
export const PICKER_RESULTS = 10;

/**
 * The first page of matches of the rested search text: requests wait `SEARCH_DEBOUNCE_MS`, and only the answer of the
 * latest one counts.
 *
 * @param query the text as typed
 * @param search the request
 * @param excludeIds the entries that are never offered
 * @returns the offered entries (null until the first answer) and the error of the latest request
 */
function usePickerResults<T extends PickerEntry>(
  query: string,
  search: SearchPickerProps<T>['search'],
  excludeIds: readonly string[],
): { items: T[] | null; error: string | null } {
  const term = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const { data, error } = useLoad(
    () => search(term, Math.min(200, PICKER_RESULTS + excludeIds.length)),
    [term, excludeIds.join(',')],
  );
  if (data === null) return { items: null, error };
  const items = data.items.filter((entry) => !excludeIds.includes(entry.id)).slice(0, PICKER_RESULTS);
  return { items, error };
}

/**
 * The next active index for an arrow key.
 *
 * @param current the active index, -1 for none
 * @param step 1 for down, -1 for up
 * @param count the number of results
 * @returns the new index, wrapping around
 */
function moveActive(current: number, step: 1 | -1, count: number): number {
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

/**
 * An ARIA 1.2 combobox that finds an entry by name: typing searches, ↓/↑ move through the results, Enter or a click
 * picks, Esc closes the list.
 *
 * @param props the texts, the search, the excluded entries, the pick callback and the width
 * @returns the combobox
 */
export function SearchPicker<T extends PickerEntry>(props: SearchPickerProps<T>) {
  const { label, title, excludeIds = [], onPick, fullWidth = false } = props;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  // A double activation must not fire the action twice while the first one is still running.
  const inFlight = useRef(false);
  const { items, error } = usePickerResults(query, props.search, excludeIds);
  const shown = items ?? [];
  const current = active >= 0 && active < shown.length ? active : -1;
  const expanded = open && items !== null;

  /**
   * Closes the list and hands the entry on, once at a time.
   *
   * @param entry the picked entry
   */
  function pick(entry: T) {
    if (inFlight.current) return;
    inFlight.current = true;
    setOpen(false);
    setActive(-1);
    void Promise.resolve()
      .then(() => onPick(entry))
      .finally(() => {
        inFlight.current = false;
      });
  }

  /**
   * Arrow keys move the active result, Enter picks it, Esc closes the list.
   *
   * @param event the key press in the input
   */
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length === 0) return;
      setOpen(true);
      setActive(moveActive(current, event.key === 'ArrowDown' ? 1 : -1, shown.length));
    } else if (event.key === 'Enter') {
      const entry = shown[current];
      if (!expanded || entry === undefined) return;
      event.preventDefault();
      pick(entry);
    } else if (event.key === 'Escape') {
      if (!expanded) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    <div className="relative space-y-2">
      <input
        className={fullWidth ? `${INPUT} w-full` : INPUT}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && current >= 0 ? `${listId}-${current}` : undefined}
        placeholder={label}
        title={title}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      <PickerResults
        listId={listId}
        listLabel={props.listLabel}
        emptyText={error === null ? props.emptyText : null}
        items={shown}
        current={current}
        hidden={!expanded}
        onPick={pick}
      />
    </div>
  );
}

/** The props of `PickerResults`. */
interface PickerResultsProps<T extends PickerEntry> {
  listId: string;
  listLabel: string;
  /** Shown when there is no result; null shows nothing. */
  emptyText: string | null;
  items: readonly T[];
  /** The active index, -1 for none. */
  current: number;
  hidden: boolean;
  onPick(entry: T): void;
}

/**
 * The popup with the results of a picker.
 *
 * @param props the list's id and name, the results, the active one, whether it is hidden and the pick
 * @returns the popup
 */
function PickerResults<T extends PickerEntry>(props: PickerResultsProps<T>) {
  const { listId, items, current, emptyText, onPick } = props;
  return (
    <div
      className={`absolute inset-x-0 top-10 z-50 min-w-0 rounded-control border bg-surface py-1 ${BORDER}`}
      hidden={props.hidden}
    >
      {items.length === 0 && emptyText !== null && <p className={`px-3 py-1.5 ${MUTED}`}>{emptyText}</p>}
      <ul id={listId} role="listbox" aria-label={props.listLabel}>
        {items.map((entry, index) => (
          <li
            key={entry.id}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === current}
            title={entry.name}
            className={`cursor-default truncate px-3 py-1.5 ${ITEM_HOVER} ${index === current ? 'bg-raised' : ''}`}
            // Keep the focus in the input; the click picks.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(entry)}
          >
            {entry.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
