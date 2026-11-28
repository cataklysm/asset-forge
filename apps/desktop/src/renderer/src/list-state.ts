import type { AssetStatus, FileKind, FileRole, FileScope, IpcRequest, ProjectStatus } from '@assetforge/contracts';
import { renameInLabels, renameInNames, type TagLabels, type TagRename } from './tag-rename';

// The list states the shell keeps across navigation: filters, scroll offsets and selections, their keys and
// the queries they turn into, and the gallery view remembered on the device.

/** How the asset gallery shows its items. */
export type AssetView = 'grid' | 'table';

/** '' = all. */
export type Choice<T extends string> = T | '';

/** '' and [] = all. */
export interface AssetFilters {
  /** The asset type. */
  typeId: string;
  /** The asset status. */
  status: Choice<AssetStatus>;
  /** A project the asset is assigned to. */
  projectId: string;
  /** The search text. */
  query: string;
  /** Tags the asset or one of its files must carry, all of them. */
  tagNames: string[];
  /** The display names of `tagNames` as chosen; never part of the key or the query. */
  tagLabels?: TagLabels;
  /** A role one of the asset's files must have. */
  fileRole: Choice<FileRole>;
  /** A kind one of the asset's files must have. */
  fileKind: Choice<FileKind>;
}

/** The asset gallery's kept state. */
export interface AssetListState {
  /** The filters as typed. */
  filters: AssetFilters;
  /** The scroll offset of the view. */
  scrollOffset: number;
  /** The index of the asset opened last; null when the gallery was left another way. */
  openedIndex: number | null;
  /** The asset shown in the Selection column. */
  selectedId: string | null;
}

/** '' and [] = all. */
export interface FileFilters {
  /** The search text. */
  query: string;
  /** The file role. */
  role: Choice<FileRole>;
  /** The file kind. */
  kind: Choice<FileKind>;
  /** Tags the file must carry itself, all of them. */
  tagNames: string[];
  /** The display names of `tagNames` as chosen; never part of the key or the query. */
  tagLabels?: TagLabels;
}

/** The inbox's kept state. */
export interface InboxListState {
  /** The filters as typed. */
  filters: FileFilters;
  /** The scroll offset of the file list. */
  scrollOffset: number;
}

/** The trash list: the same as the inbox's, kept by the shell so that it survives navigation. */
export type TrashListState = InboxListState;

/** '' and [] = all. */
export interface ProjectFilters {
  /** The search text. */
  query: string;
  /** The project status. */
  status: Choice<ProjectStatus>;
  /** Tags one member asset must carry, all of them. */
  tagNames: string[];
  /** The display names of `tagNames` as chosen; never part of the key or the query. */
  tagLabels?: TagLabels;
}

/** The projects list's kept state. */
export interface ProjectListState {
  /** The filters as typed. */
  filters: ProjectFilters;
  /** The scroll offset of the list. */
  scrollOffset: number;
  /** The index of the project opened last; null when the list was left another way. */
  openedIndex: number | null;
  /** The project shown in the details. */
  selectedId: string | null;
}

/** The tabs of the asset screen. */
export type AssetTab = 'files' | 'workflow' | 'projects' | 'relations';

/** The asset filters that match every asset. */
export const NO_FILTERS: AssetFilters = {
  typeId: '',
  status: '',
  projectId: '',
  query: '',
  tagNames: [],
  fileRole: '',
  fileKind: '',
};

/** The file filters that match every file. */
export const NO_FILE_FILTERS: FileFilters = { query: '', role: '', kind: '', tagNames: [] };

/** The project filters that match every project. */
export const NO_PROJECT_FILTERS: ProjectFilters = { query: '', status: '', tagNames: [] };

type AnyFilters = AssetFilters | FileFilters | ProjectFilters;

/**
 * JSON of the fields sorted by name, tag names sorted, plus `extra` (e.g. the scope): equal
 * filters give equal keys and values containing any character stay unambiguous.
 *
 * @param filters the filters
 * @param extra more that belongs to the key
 * @returns the key
 */
export function listKey(filters: AnyFilters, extra?: string): string {
  const entries = Object.entries(restricting(filters))
    .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
    .map(([name, value]) => [name, Array.isArray(value) ? [...(value as string[])].sort() : value]);
  return JSON.stringify([extra ?? null, entries]);
}

/**
 * The filters with the renamed tag in `tagNames` and its display name in `tagLabels`.
 *
 * @param filters the filters
 * @param change the rename
 * @returns the changed filters; the same object when the filter does not hold the tag
 */
export function renameInFilters<F extends { tagNames: string[]; tagLabels?: TagLabels }>(
  filters: F,
  change: TagRename,
): F {
  const tagNames = renameInNames(filters.tagNames, change);
  const labels = filters.tagLabels ?? NO_LABELS;
  const tagLabels = renameInLabels(labels, tagNames, change);
  if (tagNames === filters.tagNames && tagLabels === labels) return filters;
  return { ...filters, tagNames: [...tagNames], tagLabels };
}

/** No display names. */
const NO_LABELS: TagLabels = {};

/**
 * The filter fields that restrict a list: everything but the display names.
 *
 * @param filters the filters
 * @returns the fields without `tagLabels`
 */
function restricting<F extends AnyFilters>(filters: F): Omit<F, 'tagLabels'> {
  const { tagLabels: _labels, ...rest } = filters;
  return rest;
}

/**
 * Whether a filter value restricts anything.
 *
 * @param value a text or a list
 * @returns true for a text that is not blank or a list that is not empty
 */
function isSet(value: string | readonly string[]): boolean {
  return typeof value === 'string' ? value.trim() !== '' : value.length > 0;
}

/**
 * Whether any filter restricts the list.
 *
 * @param filters the filters
 * @returns true when one value is set
 */
export function hasFilters(filters: AnyFilters): boolean {
  return Object.values(restricting(filters)).some((value: string | string[]) => isSet(value));
}

/**
 * The set values of `values`: text trimmed, '' and [] dropped.
 *
 * @param values the filters
 * @returns only the values that restrict the list
 */
function setValues<T extends object>(values: T): Partial<{ [K in keyof T]: Exclude<T[K], ''> }> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values) as [string, string | string[]][]) {
    const clean = typeof value === 'string' ? value.trim() : value;
    if (isSet(clean)) result[name] = clean;
  }
  return result as Partial<{ [K in keyof T]: Exclude<T[K], ''> }>;
}

/**
 * The `assets:list` filter of the gallery's filters.
 *
 * @param filters the filters
 * @returns the request without paging
 */
export function toAssetQuery(filters: AssetFilters): Omit<IpcRequest<'assets:list'>, 'limit' | 'offset'> {
  return setValues(restricting(filters));
}

/**
 * The `files:list` filter of a file list's filters.
 *
 * @param scope the list's scope
 * @param filters the filters
 * @returns the request without paging
 */
export function toFileQuery(
  scope: FileScope,
  filters: FileFilters,
): Omit<IpcRequest<'files:list'>, 'limit' | 'offset'> {
  return { scope, ...setValues(restricting(filters)) };
}

/**
 * The `projects:list` filter of the projects list's filters.
 *
 * @param filters the filters
 * @returns the request without paging
 */
export function toProjectQuery(filters: ProjectFilters): Omit<IpcRequest<'projects:list'>, 'limit' | 'offset'> {
  return setValues(restricting(filters));
}

/** Where the gallery view is remembered on the device. */
export const VIEW_STORAGE_KEY = 'assetforge.assets.view';

/**
 * The gallery view remembered on the device.
 *
 * @param storage the device storage; null when it cannot be reached
 * @returns the remembered view; the grid when none is or it cannot be read
 */
export function readView(storage: Pick<Storage, 'getItem'> | null): AssetView {
  try {
    return storage?.getItem(VIEW_STORAGE_KEY) === 'table' ? 'table' : 'grid';
  } catch {
    return 'grid';
  }
}

/**
 * Remembers the gallery view on the device, best effort.
 *
 * @param storage the device storage; null when it cannot be reached
 * @param view the chosen view
 */
export function writeView(storage: Pick<Storage, 'setItem'> | null, view: AssetView): void {
  try {
    storage?.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Storage may be unavailable or full; the choice just is not remembered.
  }
}
