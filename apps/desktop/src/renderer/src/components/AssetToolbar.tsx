import { LayoutGrid, List, type LucideIcon } from 'lucide-react';
import { AssetStatusSchema, type AssetType } from '@assetforge/contracts';
import { distinct } from '../format';
import { ANALYSE_ASSETS_TITLE, FILE_KIND_OPTIONS, label } from '../labels';
import { hasFilters, NO_FILTERS, type AssetFilters, type AssetView } from '../list-state';
import { ROLES, roleOptions } from '../role-options';
import { ALERT, ICON_BUTTON, SELECT } from '../ui';
import { AnalyseAllButton } from './AnalysisDialogs';
import { FilterBar } from './FilterBar';
import { ProjectFilter } from './ProjectFilter';
import { ResultStrip } from './ResultStrip';
import { SearchField } from './SearchField';
import { TagFilter } from './TagFilter';

// The toolbar of the asset gallery: the two filter rows, Analyse all, the view switch, errors and the start strip.

const STATUSES = AssetStatusSchema.options;
const KINDS = FILE_KIND_OPTIONS;

const VIEWS = [
  { view: 'grid', tooltip: 'Show as tiles', icon: LayoutGrid },
  { view: 'table', tooltip: 'Show as table', icon: List },
] satisfies { view: AssetView; tooltip: string; icon: LucideIcon }[];

/** The props of the first filter row. */
interface SearchRowProps {
  /** The filters as typed (the query not debounced). */
  filters: AssetFilters;
  /** Changes some filters; the list starts at the top. */
  onFilterChange(change: Partial<AssetFilters>): void;
  /** The asset types for the type filter. */
  types: readonly AssetType[];
  /** Why Analyse all is blocked; null when it is not. */
  analysisBlocked: string | null;
  /** Starts the analysis of the assets the filters match. */
  onAnalyseAll(): void;
  /** The shown view. */
  view: AssetView;
  /** Switches to another view. */
  onSwitchView(view: AssetView): void;
}

/** The props of the toolbar. */
interface Props extends SearchRowProps {
  /** The number of matching assets; null until known. */
  total: number | null;
  /** The load failures of the types and projects. */
  errors: readonly string[];
  /** The title of the last analysis start; null when none is shown. */
  started: string | null;
  /** Hides the start strip. */
  onDismissStarted(): void;
}

/**
 * The gallery toolbar.
 *
 * @param props the filters, the lists they choose from, the view, the total, the errors and the start strip
 * @returns the toolbar
 */
export function AssetToolbar(props: Props) {
  const { filters, onFilterChange, total, errors, started } = props;
  return (
    <div className="flex flex-col gap-3">
      <FilterBar
        resultCount={total === null ? null : `${total} ${total === 1 ? 'asset' : 'assets'}`}
        onClear={hasFilters(filters) ? () => onFilterChange(NO_FILTERS) : null}
      >
        <SearchRow {...props} />
        <FileRow filters={filters} onFilterChange={onFilterChange} />
      </FilterBar>
      {distinct(errors).map((message) => (
        <p key={message} role="alert" className={ALERT}>
          {message}
        </p>
      ))}
      {started !== null && <ResultStrip title={started} failures={[]} onDismiss={props.onDismissStarted} />}
    </div>
  );
}

/**
 * Search, type, status and project, then Analyse all and the view switch.
 *
 * @param props the filters, the types and projects, the analysis and the view
 * @returns the row's controls
 */
function SearchRow({
  filters,
  onFilterChange,
  types,
  analysisBlocked,
  onAnalyseAll,
  view,
  onSwitchView,
}: SearchRowProps) {
  return (
    <>
      <SearchField
        label="Search assets"
        placeholder="Search assets"
        value={filters.query}
        onChange={(text) => onFilterChange({ query: text })}
      />
      <select
        className={SELECT}
        aria-label="Type"
        value={filters.typeId}
        onChange={(event) => onFilterChange({ typeId: event.target.value })}
      >
        <option value="">All types</option>
        {types.map((type) => (
          <option key={type.id} value={type.id}>
            {type.name}
          </option>
        ))}
      </select>
      <select
        className={SELECT}
        aria-label="Status"
        value={filters.status}
        onChange={(event) => onFilterChange({ status: STATUSES.find((status) => status === event.target.value) ?? '' })}
      >
        <option value="">All statuses</option>
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {label(status)}
          </option>
        ))}
      </select>
      <ProjectFilter projectId={filters.projectId} onChange={(projectId) => onFilterChange({ projectId })} />
      <div className="ml-auto flex items-center gap-2">
        <AnalyseAllButton blocked={analysisBlocked} title={ANALYSE_ASSETS_TITLE} onClick={onAnalyseAll} />
        {VIEWS.map(({ view: option, tooltip, icon: Icon }) => (
          <button
            key={option}
            type="button"
            className={ICON_BUTTON}
            title={tooltip}
            aria-label={tooltip}
            aria-pressed={view === option}
            onClick={() => onSwitchView(option)}
          >
            <Icon size={16} aria-hidden />
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * Tags, file role and file kind.
 *
 * @param props the filters and their change
 * @returns the row's controls
 */
function FileRow({ filters, onFilterChange }: Pick<SearchRowProps, 'filters' | 'onFilterChange'>) {
  return (
    <>
      <TagFilter
        value={filters.tagNames}
        labels={filters.tagLabels}
        title="Assets that carry all these tags, on the asset or on one of its files"
        onChange={(tagNames, tagLabels) => onFilterChange({ tagNames, tagLabels })}
      />
      <select
        className={SELECT}
        aria-label="Role"
        title="Assets with a file in this role"
        value={filters.fileRole}
        onChange={(event) => onFilterChange({ fileRole: ROLES.find((role) => role === event.target.value) ?? '' })}
      >
        <option value="">All roles</option>
        {roleOptions()}
      </select>
      <select
        className={SELECT}
        aria-label="File type"
        title="Assets with a file of this type"
        value={filters.fileKind}
        onChange={(event) =>
          onFilterChange({ fileKind: KINDS.find((option) => option.kind === event.target.value)?.kind ?? '' })
        }
      >
        <option value="">All file types</option>
        {KINDS.map((option) => (
          <option key={option.kind} value={option.kind}>
            {option.title}
          </option>
        ))}
      </select>
    </>
  );
}
