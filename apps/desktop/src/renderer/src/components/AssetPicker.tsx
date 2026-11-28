import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Asset } from '@assetforge/contracts';
import { call } from '../api';
import { useLoad } from '../hooks/useLoad';
import { ALERT, BORDER, INPUT, ITEM_HOVER, MUTED } from '../ui';

// A search field that picks one asset.

interface Props {
  /** Assets that are never offered. */
  excludeIds?: readonly string[];
  /** Receives the picked asset; a second pick waits until it has settled. */
  onPick(asset: Asset): void | Promise<void>;
  /** Stretches the search input to the width of its container. */
  fullWidth?: boolean;
}

/** The number of results shown. */
const RESULTS = 10;

/**
 * An ARIA 1.2 combobox that finds an asset by name: typing filters, ↓/↑ move through the
 * results, Enter or a click picks, Esc closes the list.
 *
 * @param props the excluded assets, the pick callback and the width
 * @returns the combobox
 */
export function AssetPicker({ excludeIds = [], onPick, fullWidth = false }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const term = query.trim();
  // A double activation must not fire the action twice while the first one is still running.
  const inFlight = useRef(false);

  const { data, error } = useLoad(
    () =>
      call('assets:list', {
        limit: Math.min(200, RESULTS + excludeIds.length),
        offset: 0,
        ...(term !== '' && { query: term }),
      }),
    [term, excludeIds.join(',')],
  );
  const items = (data?.items ?? []).filter((asset) => !excludeIds.includes(asset.id)).slice(0, RESULTS);
  const current = active >= 0 && active < items.length ? active : -1;
  const expanded = open && data !== null;

  /** Closes the list and hands the asset on, once at a time. */
  async function pick(asset: Asset) {
    if (inFlight.current) return;
    inFlight.current = true;
    setOpen(false);
    setActive(-1);
    try {
      await onPick(asset);
    } finally {
      inFlight.current = false;
    }
  }

  /** Arrow keys move the active result, Enter picks it, Esc closes the list. */
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length === 0) return;
      setOpen(true);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(current < 0 ? (step === 1 ? 0 : items.length - 1) : (current + step + items.length) % items.length);
    } else if (event.key === 'Enter') {
      const asset = items[current];
      if (!expanded || asset === undefined) return;
      event.preventDefault();
      void pick(asset);
    } else if (event.key === 'Escape') {
      if (!expanded) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  }

  const optionId = (index: number) => `${listId}-${index}`;

  return (
    <div className="relative space-y-2">
      <input
        className={fullWidth ? `${INPUT} w-full` : INPUT}
        role="combobox"
        aria-label="Search assets"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && current >= 0 ? optionId(current) : undefined}
        placeholder="Search assets"
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
      <div
        className={`absolute inset-x-0 top-10 z-50 min-w-0 rounded-control border bg-surface py-1 ${BORDER}`}
        hidden={!expanded}
      >
        {items.length === 0 && error === null && <p className={`px-3 py-1.5 ${MUTED}`}>No assets</p>}
        <ul id={listId} role="listbox" aria-label="Assets">
          {items.map((asset, index) => (
            <li
              key={asset.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === current}
              title={asset.name}
              className={`cursor-default truncate px-3 py-1.5 ${ITEM_HOVER} ${index === current ? 'bg-raised' : ''}`}
              // Keep the focus in the input; the click picks.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void pick(asset)}
            >
              {asset.name}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
