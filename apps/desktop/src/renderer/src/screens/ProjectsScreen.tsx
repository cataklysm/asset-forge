import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ProjectStatusSchema, type ProjectSummary } from '@assetforge/contracts';
import { call } from '../api';
import { FilterBar } from '../components/FilterBar';
import { Page } from '../components/Page';
import { ProjectDetails } from '../components/ProjectDetails';
import { ProjectTable, type ProjectTableProps } from '../components/ProjectTable';
import { SearchField } from '../components/SearchField';
import { TagFilter } from '../components/TagFilter';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { useLoad } from '../hooks/useLoad';
import { usePagedList } from '../hooks/usePagedList';
import type { ViewPosition, ViewRestore, VisibleRows } from '../hooks/useVirtualRows';
import { label } from '../labels';
import {
  hasFilters,
  listKey,
  NO_PROJECT_FILTERS,
  toProjectQuery,
  type AssetFilters,
  type ProjectFilters,
  type ProjectListState,
} from '../list-state';
import { findLoaded } from '../paged-list';
import { useTags } from '../tags-context';
import { ALERT, BUTTON, MUTED, SELECT } from '../ui';
import { NewProjectDialog } from './NewProjectDialog';
import { failedFirstPage, hasMatchedTags, nextRows, wantedPages, type ReportedRows } from './projects-list';

/** The project statuses of the status filter. */
const STATUSES = ProjectStatusSchema.options;
/** The skeleton rows while the first page loads. */
const SKELETON_ROWS = 6;

/** The props of `ProjectsScreen`. */
interface Props {
  /** The filters, selection and scroll offset kept across navigation. */
  state: ProjectListState;
  onStateChange(next: ProjectListState): void;
  onOpen(id: string): void;
  onOpenAsset(id: string): void;
  /** Shows the gallery with these filters. */
  onShowAssets(filters: Pick<AssetFilters, 'projectId' | 'tagNames'>): void;
}

/** The source of the scroll position of the mounted table. */
type PositionRef = RefObject<{ viewKey: string; get(): ViewPosition } | null>;

/**
 * Leaving the screen another way than by opening a project still keeps the position.
 *
 * @param opened set once a project was opened
 * @param position the source of the current position
 * @param state the list state
 * @param onStateChange stores the list state
 * @param viewKey the key of the displayed list
 */
function useKeepPositionOnLeave(
  opened: RefObject<boolean>,
  position: PositionRef,
  state: ProjectListState,
  onStateChange: Props['onStateChange'],
  viewKey: string,
) {
  const latest = useRef({ state, onStateChange, viewKey });
  latest.current = { state, onStateChange, viewKey };
  useEffect(
    () => () => {
      const current = latest.current;
      if (opened.current || position.current?.viewKey !== current.viewKey) return;
      current.onStateChange({ ...current.state, scrollOffset: position.current.get().scrollOffset, openedIndex: null });
    },
    [],
  );
}

/**
 * The projects screen: search, status and tag filters, the virtualised table and the details column.
 *
 * @param props the list state and the navigation callbacks
 * @returns the page
 */
export function ProjectsScreen({ state, onStateChange, onOpen, onOpenAsset, onShowAssets }: Props) {
  const [creating, setCreating] = useState(false);
  // The title shows the number of all projects, independent of the filters.
  const all = useLoad(() => call('projects:list', { limit: 1, offset: 0 }), []);

  const { filters } = state;
  // Only the text is debounced; status and tags apply at once. Trimmed before it enters the key.
  const query = useDebouncedValue(filters.query.trim(), SEARCH_DEBOUNCE_MS);
  const effective: ProjectFilters = { ...filters, query };
  // A tag rename changes which projects match and their matching tags: the list reloads.
  const { renameToken } = useTags();
  const key = listKey(effective, String(renameToken));

  // Where the next mounted table starts; read once by each table when it mounts.
  // Back from a project, its row takes the focus again.
  const restore = useRef<ViewRestore>({
    scrollOffset: state.scrollOffset,
    index: state.openedIndex,
    focus: state.openedIndex !== null,
  });
  const position = useRef<{ viewKey: string; get(): ViewPosition } | null>(null);
  const lastToken = useRef(renameToken);
  const [rows, setRows] = useState<ReportedRows | null>(null);

  const fetchPage = useCallback(
    (offset: number, limit: number) => call('projects:list', { limit, offset, ...toProjectQuery(effective) }),
    // `key` encodes every filter value used above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const [wanted, setWanted] = useState<readonly number[]>([0]);
  const paged = usePagedList<ProjectSummary>(key, fetchPage, wanted);
  const total = paged.state.total;
  // Keyed by the displayed list: while a new search loads, the old table stays mounted where it was.
  const viewKey = paged.state.key;
  // The table reloaded after a rename starts where the displayed one is now.
  if (lastToken.current !== renameToken) {
    lastToken.current = renameToken;
    const current = position.current?.viewKey === viewKey ? position.current.get() : null;
    restore.current = { scrollOffset: current?.scrollOffset ?? 0, index: null, focus: false };
  }
  const nextWanted = wantedPages(total, rows, viewKey);
  if (nextWanted.join(',') !== wanted.join(',')) setWanted(nextWanted);

  const opened = useRef(false);
  useKeepPositionOnLeave(opened, position, state, onStateChange, viewKey);

  // The selected project as last seen, for when no loaded page holds it (any more).
  const lastSelected = useRef<ProjectSummary | null>(null);
  const loadedSelection = findLoaded(paged.state, state.selectedId);
  if (loadedSelection !== null) lastSelected.current = loadedSelection.item;
  const selectedProject =
    loadedSelection?.item ?? (lastSelected.current?.id === state.selectedId ? lastSelected.current : null);

  function setFilter(change: Partial<ProjectFilters>) {
    restore.current = { scrollOffset: 0, index: null, focus: false };
    onStateChange({ ...state, filters: { ...filters, ...change }, scrollOffset: 0, openedIndex: null });
  }

  const onRows = useCallback((visible: VisibleRows) => setRows((old) => nextRows(old, visible, viewKey)), [viewKey]);

  function select(project: ProjectSummary) {
    lastSelected.current = project;
    if (state.selectedId !== project.id) onStateChange({ ...state, selectedId: project.id });
  }

  function openProject(project: ProjectSummary, scrollOffset: number, index: number) {
    opened.current = true;
    lastSelected.current = project;
    onStateChange({ ...state, scrollOffset, openedIndex: index, selectedId: project.id });
    onOpen(project.id);
  }

  const tableProps: ProjectTableProps | null =
    total === null || total === 0
      ? null
      : {
          viewKey,
          paged: paged.state,
          total,
          restore: restore.current,
          // The Matching tags column follows the displayed list, not a tag filter whose results are still loading.
          tagged: hasMatchedTags(paged.state),
          selectedId: state.selectedId,
          onSelect: select,
          onOpen: openProject,
          onRows,
          onRetry: paged.retry,
          positionRef: position,
        };

  return (
    <Page
      title="Projects"
      count={all.data?.total ?? null}
      countTitle="Projects in the workspace"
      actions={
        <button type="button" className={BUTTON} onClick={() => setCreating(true)}>
          <Plus size={16} aria-hidden />
          New project
        </button>
      }
      toolbar={<ProjectsToolbar filters={filters} total={total} allError={all.error} setFilter={setFilter} />}
      detail={
        <ProjectDetails
          project={selectedProject}
          tagNames={filters.tagNames}
          onOpenAsset={onOpenAsset}
          onShowAll={() => {
            if (selectedProject !== null)
              onShowAssets({ projectId: selectedProject.id, tagNames: [...filters.tagNames] });
          }}
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col" aria-busy={paged.pending || undefined}>
        <ProjectListBody
          failedPage={failedFirstPage(paged.state)}
          total={total}
          tableProps={tableProps}
          filtered={hasFilters(effective)}
          viewKey={viewKey}
          onRetry={paged.retry}
        />
      </div>
      <NewProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          onOpen(id);
        }}
      />
    </Page>
  );
}

/** The props of `ProjectsToolbar`. */
interface ToolbarProps {
  filters: ProjectFilters;
  total: number | null;
  /** The message of the failed count of all projects. */
  allError: string | null;
  setFilter(change: Partial<ProjectFilters>): void;
}

/**
 * The search, status and tag filters with the result count and Clear filters.
 *
 * @param props the filters, the total, the count error and the filter setter
 * @returns the toolbar
 */
function ProjectsToolbar({ filters, total, allError, setFilter }: ToolbarProps) {
  return (
    <div className="flex flex-col gap-3">
      <FilterBar
        resultCount={total === null ? null : `${total} ${total === 1 ? 'project' : 'projects'}`}
        onClear={hasFilters(filters) ? () => setFilter(NO_PROJECT_FILTERS) : null}
      >
        <>
          <SearchField
            label="Search projects"
            placeholder="Search projects"
            value={filters.query}
            onChange={(text) => setFilter({ query: text })}
          />
          <select
            className={SELECT}
            aria-label="Status"
            value={filters.status}
            onChange={(event) => setFilter({ status: STATUSES.find((status) => status === event.target.value) ?? '' })}
          >
            <option value="">All statuses</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {label(status)}
              </option>
            ))}
          </select>
          <TagFilter
            value={filters.tagNames}
            title="Projects with one member asset that carries all these tags, on the asset or on one of its files"
            onChange={(tagNames) => setFilter({ tagNames })}
          />
        </>
      </FilterBar>
      {allError !== null && (
        <p role="alert" className={ALERT}>
          {allError}
        </p>
      )}
    </div>
  );
}

/** The props of `ProjectListBody`. */
interface ListBodyProps {
  /** The failed first page, which takes the place of the list. */
  failedPage: number | null;
  total: number | null;
  /** The table props, or null for an empty list. */
  tableProps: ProjectTableProps | null;
  /** Whether a filter is applied, for the empty text. */
  filtered: boolean;
  viewKey: string;
  onRetry(page: number): void;
}

/**
 * Retry, the skeleton, the empty text or the table.
 *
 * @param props the list state and the retry
 * @returns the list content
 */
function ProjectListBody({ failedPage, total, tableProps, filtered, viewKey, onRetry }: ListBodyProps) {
  if (failedPage !== null) {
    return (
      <div>
        <button type="button" className={BUTTON} onClick={() => onRetry(failedPage)}>
          Retry
        </button>
      </div>
    );
  }
  if (total === null) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <div key={index} data-skeleton="" className="h-10 animate-pulse rounded-control bg-raised" />
        ))}
      </div>
    );
  }
  if (tableProps === null) return <p className={MUTED}>{filtered ? 'No matching projects' : 'No projects'}</p>;
  return <ProjectTable key={viewKey} {...tableProps} />;
}
