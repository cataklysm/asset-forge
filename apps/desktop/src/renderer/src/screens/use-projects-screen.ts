import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ProjectSummary } from '@assetforge/contracts';
import { call } from '../api';
import type { ProjectTableProps } from '../components/ProjectTable';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { usePagedList, type PagedList } from '../hooks/usePagedList';
import type { ViewPosition, ViewRestore, VisibleRows } from '../hooks/useVirtualRows';
import { listKey, toProjectQuery, type ProjectFilters, type ProjectListState } from '../list-state';
import { findLoaded, type PagedState } from '../paged-list';
import { useTags } from '../tags-context';
import { hasMatchedTags, nextRows, wantedPages, type ReportedRows } from './projects-list';

// The state of the projects screen: the filtered list, where its table starts, the selection and the handlers.

/** The source of the scroll position of the mounted table. */
type PositionRef = RefObject<{ viewKey: string; get(): ViewPosition } | null>;

/** What the projects screen hands to `useProjectsScreen`. */
export interface ProjectsScreenInput {
  /** The filters, selection and scroll offset kept across navigation. */
  state: ProjectListState;
  onStateChange(next: ProjectListState): void;
  onOpen(id: string): void;
}

/** What the projects screen renders. */
export interface ProjectsScreenModel {
  /** The displayed list. */
  paged: PagedList<ProjectSummary>;
  /** The filters in effect, with the debounced text. */
  effective: ProjectFilters;
  /** The key of the displayed list. */
  viewKey: string;
  /** The table props, or null while the list is empty or its total unknown. */
  tableProps: ProjectTableProps | null;
  /** The project of the details column. */
  selectedProject: ProjectSummary | null;
  /** Changes filters; the new list starts at the top. */
  setFilter(change: Partial<ProjectFilters>): void;
}

/**
 * Leaving the screen another way than by opening a project still keeps the position.
 *
 * @param opened set once a project was opened
 * @param position the source of the current position
 * @param input the list state and its setter
 * @param viewKey the key of the displayed list
 */
function useKeepPositionOnLeave(
  opened: RefObject<boolean>,
  position: PositionRef,
  input: ProjectsScreenInput,
  viewKey: string,
) {
  const latest = useRef({ state: input.state, onStateChange: input.onStateChange, viewKey });
  useLayoutEffect(() => {
    latest.current = { state: input.state, onStateChange: input.onStateChange, viewKey };
  });
  useEffect(
    () => () => {
      const current = latest.current;
      if (opened.current || position.current?.viewKey !== current.viewKey) return;
      current.onStateChange({ ...current.state, scrollOffset: position.current.get().scrollOffset, openedIndex: null });
    },
    // Both refs are stable; the cleanup runs once, on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}

/**
 * Where the next mounted table starts; each table reads it once when it mounts. At first it is the kept
 * position, and back from a project its row takes the focus again unless the user put the focus elsewhere
 * first. After a tag rename the reloaded table starts where the displayed one is now.
 *
 * @param state the list state kept across navigation
 * @param renameToken the rename signal of the tags context
 * @param position the source of the position of the mounted table
 * @param viewKey the key of the displayed list
 * @returns the start and its setter
 */
function useTableRestore(
  state: ProjectListState,
  renameToken: number,
  position: PositionRef,
  viewKey: string,
): [ViewRestore, (restore: ViewRestore) => void] {
  const [restore, setRestore] = useState<ViewRestore>(() => ({
    scrollOffset: state.scrollOffset,
    index: state.openedIndex,
    focus: state.openedIndex !== null,
    focusFrom: document.activeElement,
    // The opened project, wherever it is now: a rename while it was open may have moved it.
    focusId: state.selectedId,
  }));
  const lastToken = useRef(renameToken);
  // The reloaded table mounts once its first page arrived, so a commit later is still in time.
  useLayoutEffect(() => {
    if (lastToken.current === renameToken) return;
    lastToken.current = renameToken;
    const current = position.current?.viewKey === viewKey ? position.current.get() : null;
    setRestore({ scrollOffset: current?.scrollOffset ?? 0, index: null, focus: false });
  }, [renameToken, position, viewKey]);
  return [restore, setRestore];
}

/**
 * The filtered project list with the pages the table shows. Only the text is debounced; status and tags
 * apply at once, and a tag rename reloads the list because it changes which projects match.
 *
 * @param filters the typed filters
 * @param renameToken the rename signal of the tags context
 * @returns the paged list, the filters in effect, the key of the displayed list and the row reporter
 */
function useProjectList(filters: ProjectFilters, renameToken: number) {
  // Trimmed before it enters the key.
  const query = useDebouncedValue(filters.query.trim(), SEARCH_DEBOUNCE_MS);
  const effective: ProjectFilters = { ...filters, query };
  const key = listKey(effective, String(renameToken));
  const fetchPage = useCallback(
    (offset: number, limit: number) => call('projects:list', { limit, offset, ...toProjectQuery(effective) }),
    // `key` encodes every filter value used above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const [rows, setRows] = useState<ReportedRows | null>(null);
  const [wanted, setWanted] = useState<readonly number[]>([0]);
  const paged = usePagedList<ProjectSummary>(key, fetchPage, wanted);
  // Keyed by the displayed list: while a new search loads, the old table stays mounted where it was.
  const viewKey = paged.state.key;
  const nextWanted = wantedPages(paged.state.total, rows, viewKey);
  if (nextWanted.join(',') !== wanted.join(',')) setWanted(nextWanted);
  const onRows = useCallback((visible: VisibleRows) => setRows((old) => nextRows(old, visible, viewKey)), [viewKey]);
  return { paged, effective, viewKey, onRows };
}

/**
 * The selected project: from the loaded pages, else as last seen while no loaded page holds it (any more).
 *
 * @param paged the displayed list
 * @param selectedId the selected project id
 * @returns the project (null without one) and the setter of the project last seen
 */
function useSelectedProject(
  paged: PagedState<ProjectSummary>,
  selectedId: string | null,
): { project: ProjectSummary | null; remember(project: ProjectSummary): void } {
  const [remembered, setRemembered] = useState<ProjectSummary | null>(null);
  const loaded = findLoaded(paged, selectedId)?.item ?? null;
  // Adjusting state while rendering: React renders again at once, before anything is committed.
  if (loaded !== null && loaded !== remembered) setRemembered(loaded);
  return { project: loaded ?? (remembered?.id === selectedId ? remembered : null), remember: setRemembered };
}

/** What the handlers of the projects screen work on. */
interface HandlerContext extends ProjectsScreenInput {
  /** Keeps a project as the one last seen selected. */
  remember(project: ProjectSummary): void;
  /** Lets the next mounted table start at the top. */
  restart(): void;
  /** Set once a project was opened. */
  opened: RefObject<boolean>;
}

/**
 * The filter, select and open handlers of the projects screen.
 *
 * @param context the list state, its setter and the callbacks
 * @returns the handlers
 */
function projectHandlers({ state, onStateChange, onOpen, remember, restart, opened }: HandlerContext) {
  /**
   * Changes filters; the new list starts at the top.
   *
   * @param change the changed filters
   */
  function setFilter(change: Partial<ProjectFilters>) {
    restart();
    onStateChange({ ...state, filters: { ...state.filters, ...change }, scrollOffset: 0, openedIndex: null });
  }
  /**
   * Selects a project for the details column.
   *
   * @param project the project
   */
  function select(project: ProjectSummary) {
    remember(project);
    if (state.selectedId !== project.id) onStateChange({ ...state, selectedId: project.id });
  }
  /**
   * Opens a project and keeps where its row was.
   *
   * @param project the project
   * @param scrollOffset the scroll offset of the table
   * @param index the index of its row
   */
  function openProject(project: ProjectSummary, scrollOffset: number, index: number) {
    opened.current = true;
    remember(project);
    onStateChange({ ...state, scrollOffset, openedIndex: index, selectedId: project.id });
    onOpen(project.id);
  }
  return { setFilter, select, openProject };
}

/**
 * The state of the projects screen.
 *
 * @param input the list state, its setter and the opener of a project
 * @returns what the screen renders
 */
export function useProjectsScreen(input: ProjectsScreenInput): ProjectsScreenModel {
  const { renameToken } = useTags();
  const position = useRef<{ viewKey: string; get(): ViewPosition } | null>(null);
  const { paged, effective, viewKey, onRows } = useProjectList(input.state.filters, renameToken);
  const [restore, setRestore] = useTableRestore(input.state, renameToken, position, viewKey);
  const opened = useRef(false);
  useKeepPositionOnLeave(opened, position, input, viewKey);
  const selected = useSelectedProject(paged.state, input.state.selectedId);
  const restart = () => setRestore({ scrollOffset: 0, index: null, focus: false });
  const handlers = projectHandlers({ ...input, remember: selected.remember, restart, opened });
  const total = paged.state.total;
  const tableProps: ProjectTableProps | null =
    total === null || total === 0
      ? null
      : {
          viewKey,
          paged: paged.state,
          total,
          restore,
          // The Matching tags column follows the displayed list, not a tag filter whose results are still loading.
          tagged: hasMatchedTags(paged.state),
          selectedId: input.state.selectedId,
          onSelect: handlers.select,
          onOpen: handlers.openProject,
          onRows,
          onRetry: paged.retry,
          positionRef: position,
        };
  return { paged, effective, viewKey, tableProps, selectedProject: selected.project, setFilter: handlers.setFilter };
}
