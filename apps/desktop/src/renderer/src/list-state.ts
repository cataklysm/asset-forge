import type {
  AssetStatus,
  FileKind,
  FileRole,
  FileScope,
  IpcRequest,
  ProjectStatus,
} from '@assetforge/contracts';
import { renameInNames, type TagRename } from './tag-rename';

export type AssetView = 'grid' | 'table';

/** '' = all. */
export type Choice<T extends string> = T | '';

/** '' and [] = all. */
export interface AssetFilters {
  typeId: string;
  status: Choice<AssetStatus>;
  projectId: string;
  query: string;
  tagNames: string[];
  fileRole: Choice<FileRole>;
  fileKind: Choice<FileKind>;
}

export interface AssetListState {
  filters: AssetFilters;
  scrollOffset: number;
  openedIndex: number | null;
  selectedId: string | null;
}

export interface FileFilters {
  query: string;
  role: Choice<FileRole>;
  kind: Choice<FileKind>;
  tagNames: string[];
}

export interface InboxListState {
  filters: FileFilters;
  scrollOffset: number;
}

/** The trash list: the same as the inbox's, kept by the shell so that it survives navigation. */
export type TrashListState = InboxListState;

export interface ProjectFilters {
  query: string;
  status: Choice<ProjectStatus>;
  tagNames: string[];
}

export interface ProjectListState {
  filters: ProjectFilters;
  scrollOffset: number;
  selectedId: string | null;
}

export type AssetTab = 'files' | 'workflow' | 'projects' | 'relations';

export const NO_FILTERS: AssetFilters = {
  typeId: '',
  status: '',
  projectId: '',
  query: '',
  tagNames: [],
  fileRole: '',
  fileKind: '',
};

export const NO_FILE_FILTERS: FileFilters = { query: '', role: '', kind: '', tagNames: [] };

export const NO_PROJECT_FILTERS: ProjectFilters = { query: '', status: '', tagNames: [] };

type AnyFilters = AssetFilters | FileFilters | ProjectFilters;

/**
 * JSON of the fields sorted by name, tag names sorted, plus `extra` (e.g. the scope): equal
 * filters give equal keys and values containing any character stay unambiguous.
 */
export function listKey(filters: AnyFilters, extra?: string): string {
  const entries = Object.entries(filters)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => [name, Array.isArray(value) ? [...(value as string[])].sort() : value]);
  return JSON.stringify([extra ?? null, entries]);
}

/** The filters with the renamed tag in `tagNames`; the same object when the filter does not hold it. */
export function renameInFilters<F extends { tagNames: string[] }>(filters: F, change: TagRename): F {
  const tagNames = renameInNames(filters.tagNames, change);
  return tagNames === filters.tagNames ? filters : { ...filters, tagNames: [...tagNames] };
}

function isSet(value: string | readonly string[]): boolean {
  return typeof value === 'string' ? value.trim() !== '' : value.length > 0;
}

export function hasFilters(filters: AnyFilters): boolean {
  return Object.values(filters).some((value: string | string[]) => isSet(value));
}

/** The set values of `values`: text trimmed, '' and [] dropped. */
function setValues<T extends object>(values: T): Partial<{ [K in keyof T]: Exclude<T[K], ''> }> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values) as [string, string | string[]][]) {
    const clean = typeof value === 'string' ? value.trim() : value;
    if (isSet(clean)) result[name] = clean;
  }
  return result as Partial<{ [K in keyof T]: Exclude<T[K], ''> }>;
}

export function toAssetQuery(f: AssetFilters): Omit<IpcRequest<'assets:list'>, 'limit' | 'offset'> {
  return setValues(f);
}

export function toFileQuery(scope: FileScope, f: FileFilters): Omit<IpcRequest<'files:list'>, 'limit' | 'offset'> {
  return { scope, ...setValues(f) };
}

export function toProjectQuery(f: ProjectFilters): Omit<IpcRequest<'projects:list'>, 'limit' | 'offset'> {
  return setValues(f);
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
