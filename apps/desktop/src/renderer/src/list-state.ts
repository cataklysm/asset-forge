export type AssetView = 'grid' | 'table';

/** '' = all. */
export interface AssetFilters {
  typeId: string;
  status: string;
  projectId: string;
  nameContains: string;
}

export const NO_FILTERS: AssetFilters = { typeId: '', status: '', projectId: '', nameContains: '' };

/** JSON of a fixed-order tuple: equal filters give equal keys and values containing any character stay unambiguous. */
export function filterKey(filters: AssetFilters): string {
  return JSON.stringify([filters.typeId, filters.status, filters.projectId, filters.nameContains]);
}

export interface AssetListState {
  filters: AssetFilters;
  scrollOffset: number;
  openedIndex: number | null;
}

export const VIEW_STORAGE_KEY = 'assetforge.assets.view';

export function readView(storage: Pick<Storage, 'getItem'> | null): AssetView {
  try {
    return storage?.getItem(VIEW_STORAGE_KEY) === 'table' ? 'table' : 'grid';
  } catch {
    return 'grid';
  }
}

export function writeView(storage: Pick<Storage, 'setItem'> | null, view: AssetView): void {
  try {
    storage?.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Storage may be unavailable or full; the choice just is not remembered.
  }
}
