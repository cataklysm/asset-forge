import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ProjectStatusSchema, type ProjectSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { Dialog } from '../components/Dialog';
import { FilterBar } from '../components/FilterBar';
import { Page } from '../components/Page';
import { ProjectDetails } from '../components/ProjectDetails';
import { ProjectTable, type ProjectTableProps } from '../components/ProjectTable';
import { SearchField } from '../components/SearchField';
import { TagFilter } from '../components/TagFilter';
import { pagesForRows } from '../gallery';
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
import { ALERT, BUTTON, INPUT, MUTED, SELECT } from '../ui';

const STATUSES = ProjectStatusSchema.options;
const SKELETON_ROWS = 6;

interface Props {
  state: ProjectListState;
  onStateChange(next: ProjectListState): void;
  onOpen(id: string): void;
  onOpenAsset(id: string): void;
  onShowAssets(filters: Pick<AssetFilters, 'projectId' | 'tagNames'>): void;
}

export function ProjectsScreen({ state, onStateChange, onOpen, onOpenAsset, onShowAssets }: Props) {
  const [creating, setCreating] = useState(false);
  // The title shows the number of all projects, independent of the filters.
  const all = useLoad(() => call('projects:list', { limit: 1, offset: 0 }), []);

  const { filters } = state;
  // Only the text is debounced; status and tags apply at once. Trimmed before it enters the key.
  const query = useDebouncedValue(filters.query.trim(), SEARCH_DEBOUNCE_MS);
  const effective: ProjectFilters = { ...filters, query };
  const key = listKey(effective);

  // Where the next mounted table starts; read once by each table when it mounts.
  const restore = useRef<ViewRestore>({ scrollOffset: state.scrollOffset, index: null, focus: false });
  const position = useRef<{ viewKey: string; get(): ViewPosition } | null>(null);
  const [rows, setRows] = useState<(VisibleRows & { viewKey: string }) | null>(null);

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
  const nextWanted =
    total === null
      ? [0]
      : rows !== null && rows.viewKey === viewKey
        ? pagesForRows(rows.firstRow, rows.lastRow, rows.columns, total)
        : [];
  if (nextWanted.join(',') !== wanted.join(',')) setWanted(nextWanted);

  // Leaving the screen another way than by opening a project still keeps the position.
  const opened = useRef(false);
  const latest = useRef({ state, onStateChange, viewKey });
  latest.current = { state, onStateChange, viewKey };
  useEffect(
    () => () => {
      const current = latest.current;
      if (opened.current || position.current?.viewKey !== current.viewKey) return;
      current.onStateChange({ ...current.state, scrollOffset: position.current.get().scrollOffset });
    },
    [],
  );

  // The selected project as last seen, for when no loaded page holds it (any more).
  const lastSelected = useRef<ProjectSummary | null>(null);
  const loadedSelection = findLoaded(paged.state, state.selectedId);
  if (loadedSelection !== null) lastSelected.current = loadedSelection.item;
  const selectedProject =
    loadedSelection?.item ?? (lastSelected.current?.id === state.selectedId ? lastSelected.current : null);

  function setFilter(change: Partial<ProjectFilters>) {
    restore.current = { scrollOffset: 0, index: null, focus: false };
    onStateChange({ ...state, filters: { ...filters, ...change }, scrollOffset: 0 });
  }

  const onRows = useCallback(
    (visible: VisibleRows) =>
      setRows((old) =>
        old !== null &&
        old.viewKey === viewKey &&
        old.firstRow === visible.firstRow &&
        old.lastRow === visible.lastRow &&
        old.columns === visible.columns
          ? old
          : { ...visible, viewKey },
      ),
    [viewKey],
  );

  function select(project: ProjectSummary) {
    lastSelected.current = project;
    if (state.selectedId !== project.id) onStateChange({ ...state, selectedId: project.id });
  }

  function openProject(project: ProjectSummary, scrollOffset: number) {
    opened.current = true;
    lastSelected.current = project;
    onStateChange({ ...state, scrollOffset, selectedId: project.id });
    onOpen(project.id);
  }

  const failedPage =
    total === null ? ([...paged.state.pages].find(([, entry]) => entry.status === 'failed')?.[0] ?? null) : null;
  // The Matching tags column follows the displayed list (whose items carry `matchedTags` only
  // when it was filtered by tags), not a tag filter whose results are still loading.
  const tagged = [...paged.state.pages.values()].some(
    (entry) => entry.status === 'loaded' && entry.items[0]?.matchedTags !== undefined,
  );
  const tableProps: ProjectTableProps | null =
    total === null || total === 0
      ? null
      : {
          viewKey,
          paged: paged.state,
          total,
          restore: restore.current,
          tagged,
          selectedId: state.selectedId,
          onSelect: select,
          onOpen: openProject,
          onRows,
          onRetry: paged.retry,
          positionRef: position,
        };

  const toolbar = (
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
            onChange={(e) => setFilter({ status: STATUSES.find((s) => s === e.target.value) ?? '' })}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
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
      {all.error !== null && (
        <p role="alert" className={ALERT}>
          {all.error}
        </p>
      )}
    </div>
  );

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
      toolbar={toolbar}
      detail={
        <ProjectDetails
          project={selectedProject}
          tagNames={filters.tagNames}
          onOpenAsset={onOpenAsset}
          onShowAll={() => {
            if (selectedProject !== null) onShowAssets({ projectId: selectedProject.id, tagNames: [...filters.tagNames] });
          }}
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col" aria-busy={paged.pending || undefined}>
        {failedPage !== null ? (
          <div>
            <button type="button" className={BUTTON} onClick={() => paged.retry(failedPage)}>
              Retry
            </button>
          </div>
        ) : total === null ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <div key={i} data-skeleton="" className="h-10 animate-pulse rounded-control bg-raised" />
            ))}
          </div>
        ) : tableProps === null ? (
          <p className={MUTED}>{hasFilters(effective) ? 'No matching projects' : 'No projects'}</p>
        ) : (
          <ProjectTable key={viewKey} {...tableProps} />
        )}
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

interface DialogProps {
  open: boolean;
  onClose(): void;
  onCreated(id: string): void;
}

/** Creates a project from a name and an optional description. */
function NewProjectDialog({ open, onClose, onCreated }: DialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();

  function close() {
    setName('');
    setDescription('');
    setError(null);
    onClose();
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (creating || trimmed === '') return;
    setCreating(true);
    setError(null);
    try {
      const text = description.trim();
      const project = await call('projects:create', { name: trimmed, ...(text !== '' && { description: text }) });
      setName('');
      setDescription('');
      onCreated(project.id);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} title="New project" initialFocusRef={nameRef} onClose={close}>
      <form className="space-y-3" onSubmit={(e) => void create(e)}>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <input
          ref={nameRef}
          aria-label="Project name"
          placeholder="Project name"
          maxLength={200}
          className={`w-full ${INPUT}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          aria-label="Description"
          placeholder="Description"
          maxLength={5000}
          rows={3}
          className={`h-auto w-full py-1.5 ${INPUT}`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={close}>
            Cancel
          </button>
          <button type="submit" className={BUTTON} disabled={creating || trimmed === ''}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}
