import { useState } from 'react';
import type { Asset } from '@assetforge/contracts';
import { call } from '../api';
import { useLoad } from '../hooks/useLoad';
import { ALERT, BUTTON, INPUT, MUTED } from '../ui';

interface Props {
  excludeIds?: readonly string[];
  onPick(asset: Asset): void;
}

const RESULTS = 10;

export function AssetPicker({ excludeIds = [], onPick }: Props) {
  const [query, setQuery] = useState('');
  const term = query.trim();
  const { data, error } = useLoad(
    () =>
      call('assets:list', {
        limit: Math.min(200, RESULTS + excludeIds.length),
        offset: 0,
        ...(term !== '' && { nameContains: term }),
      }),
    [term, excludeIds.join(',')],
  );
  const items = (data?.items ?? [])
    .filter((asset) => !excludeIds.includes(asset.id))
    .slice(0, RESULTS);

  return (
    <div className="space-y-2">
      <input
        className={INPUT}
        aria-label="Search assets"
        placeholder="Search assets"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      {data !== null && items.length === 0 && error === null && <p className={MUTED}>No assets</p>}
      <ul className="flex flex-wrap gap-2">
        {items.map((asset) => (
          <li key={asset.id}>
            <button type="button" className={BUTTON} onClick={() => onPick(asset)}>
              {asset.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
