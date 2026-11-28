import type { Asset } from '@assetforge/contracts';
import { call } from '../api';
import { ASSET_RESULTS_LABEL, NO_ASSET_RESULTS, SEARCH_ASSETS_PICKER_LABEL } from '../labels';
import { SearchPicker } from './SearchPicker';

// A search field that picks one asset.

interface Props {
  /** Assets that are never offered. */
  excludeIds?: readonly string[];
  /** Receives the picked asset; a second pick waits until it has settled. */
  onPick(asset: Asset): void | Promise<void>;
  /** Stretches the search input to the width of its container. */
  fullWidth?: boolean;
}

/**
 * The first page of assets matching a search text.
 *
 * @param term the rested search text, '' for none
 * @param limit the page size
 * @returns the page
 */
function searchAssets(term: string, limit: number) {
  return call('assets:list', { limit, offset: 0, ...(term !== '' && { query: term }) });
}

/**
 * A combobox that finds an asset through the asset search.
 *
 * @param props the excluded assets, the pick callback and the width
 * @returns the combobox
 */
export function AssetPicker({ excludeIds, onPick, fullWidth }: Props) {
  return (
    <SearchPicker
      label={SEARCH_ASSETS_PICKER_LABEL}
      listLabel={ASSET_RESULTS_LABEL}
      emptyText={NO_ASSET_RESULTS}
      search={searchAssets}
      excludeIds={excludeIds}
      onPick={onPick}
      fullWidth={fullWidth}
    />
  );
}
