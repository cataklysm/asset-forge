import { Plus } from 'lucide-react';
import { useState } from 'react';
import { ProjectStatusSchema } from '@assetforge/contracts';
import { call } from '../api';
import { FilterBar } from '../components/FilterBar';
import { Page } from '../components/Page';
import { ListRetry } from '../components/PageFailure';
import { ProjectDetails } from '../components/ProjectDetails';
import { ProjectTable, type ProjectTableProps } from '../components/ProjectTable';
import { SearchField } from '../components/SearchField';
import { TagFilter } from '../components/TagFilter';
import { useLoad } from '../hooks/useLoad';
import {
  ALL_PROJECT_STATUSES_LABEL,
  label,
  NEW_PROJECT_LABEL,
  NO_MATCHING_PROJECTS,
  NO_PROJECTS,
  projectCount,
  PROJECT_STATUS_FILTER_LABEL,
  PROJECT_TAG_FILTER_TITLE,
  PROJECTS_COUNT_TITLE,
  PROJECTS_TITLE,
  SEARCH_PROJECTS_LABEL,
} from '../labels';
import { hasFilters, NO_PROJECT_FILTERS, type AssetFilters, type ProjectFilters } from '../list-state';
import { failedFirstEntry } from '../paged-view';
import { ALERT, BUTTON, MUTED, SELECT } from '../ui';
import { NewProjectDialog } from './NewProjectDialog';
import { useProjectsScreen, type ProjectsScreenInput } from './use-projects-screen';

/** The project statuses of the status filter. */
const STATUSES = ProjectStatusSchema.options;
/** The skeleton rows while the first page loads. */
const SKELETON_ROWS = 6;

/** The props of `ProjectsScreen`. */
interface Props extends ProjectsScreenInput {
  onOpenAsset(id: string): void;
  /** Shows the gallery with these filters. */
  onShowAssets(filters: Pick<AssetFilters, 'projectId' | 'tagNames'>): void;
}

/**
 * The projects screen: search, status and tag filters, the virtualised table and the details column.
 *
 * @param props the list state and the navigation callbacks
 * @returns the page
 */
export function ProjectsScreen(props: Props) {
  const { state, onOpen, onOpenAsset, onShowAssets } = props;
  // The title shows the number of all projects, independent of the filters.
  const all = useLoad(() => call('projects:list', { limit: 1, offset: 0 }), []);
  const { paged, effective, viewKey, tableProps, selectedProject, setFilter } = useProjectsScreen(props);
  const { filters } = state;
  const total = paged.state.total;
  return (
    <Page
      title={PROJECTS_TITLE}
      count={all.data?.total ?? null}
      countTitle={PROJECTS_COUNT_TITLE}
      actions={<NewProjectAction onOpen={onOpen} />}
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
          failedPage={failedFirstEntry(paged.state)}
          total={total}
          tableProps={tableProps}
          filtered={hasFilters(effective)}
          viewKey={viewKey}
          onRetry={paged.retry}
        />
      </div>
    </Page>
  );
}

/**
 * The New project button with its dialog; a created project opens at once.
 *
 * @param props the opener of a project
 * @returns the button and the dialog
 */
function NewProjectAction({ onOpen }: Pick<Props, 'onOpen'>) {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <button type="button" className={BUTTON} onClick={() => setCreating(true)}>
        <Plus size={16} aria-hidden />
        {NEW_PROJECT_LABEL}
      </button>
      <NewProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          onOpen(id);
        }}
      />
    </>
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
        resultCount={total === null ? null : projectCount(total)}
        onClear={hasFilters(filters) ? () => setFilter(NO_PROJECT_FILTERS) : null}
      >
        <>
          <SearchField
            label={SEARCH_PROJECTS_LABEL}
            placeholder={SEARCH_PROJECTS_LABEL}
            value={filters.query}
            onChange={(text) => setFilter({ query: text })}
          />
          <StatusFilter value={filters.status} onChange={(status) => setFilter({ status })} />
          <TagFilter
            value={filters.tagNames}
            title={PROJECT_TAG_FILTER_TITLE}
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

/**
 * The project status filter; the empty value stands for all statuses.
 *
 * @param props the chosen status and its setter
 * @returns the select
 */
function StatusFilter({
  value,
  onChange,
}: {
  value: ProjectFilters['status'];
  onChange(status: ProjectFilters['status']): void;
}) {
  return (
    <select
      className={SELECT}
      aria-label={PROJECT_STATUS_FILTER_LABEL}
      value={value}
      onChange={(event) => onChange(STATUSES.find((status) => status === event.target.value) ?? '')}
    >
      <option value="">{ALL_PROJECT_STATUSES_LABEL}</option>
      {STATUSES.map((status) => (
        <option key={status} value={status}>
          {label(status)}
        </option>
      ))}
    </select>
  );
}

/** The props of `ProjectListBody`. */
interface ListBodyProps {
  /** The failed first page with its failure text, which takes the place of the list. */
  failedPage: { page: number; message: string | null } | null;
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
  if (failedPage !== null) return <ListRetry failed={failedPage} onRetry={onRetry} />;
  if (total === null) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <div key={index} data-skeleton="" className="h-10 animate-pulse rounded-control bg-raised" />
        ))}
      </div>
    );
  }
  if (tableProps === null) return <p className={MUTED}>{filtered ? NO_MATCHING_PROJECTS : NO_PROJECTS}</p>;
  return <ProjectTable key={viewKey} {...tableProps} />;
}
