import { LayoutGrid, List, Sparkles, type LucideIcon } from 'lucide-react';
import { FileRoleSchema } from '@assetforge/contracts';
import { FILE_KIND_OPTIONS, label, PROPOSALS_BLOCK_ANALYSE_ALL, PROPOSALS_LABEL, PROPOSALS_TITLE } from '../labels';
import type { AssetView, FileFilters } from '../list-state';
import { MAX_SELECTION } from '../selection';
import { BUTTON, ICON_BUTTON, SELECT } from '../ui';
import { AnalyseAllButton } from './AnalysisDialogs';
import { FilterBar } from './FilterBar';
import { SearchField } from './SearchField';
import { TagFilter } from './TagFilter';

// The filter bar of the file browser: search, role, file type, the proposal filter, "Analyse all", the view switch
// and the image tag filter.

const ROLES = FileRoleSchema.options;
const KINDS = FILE_KIND_OPTIONS;

const VIEWS = [
  { view: 'grid', tooltip: 'Show as tiles', icon: LayoutGrid },
  { view: 'table', tooltip: 'Show as table', icon: List },
] satisfies { view: AssetView; tooltip: string; icon: LucideIcon }[];

/** What the toolbar shows and whom it tells about a change. */
export interface FileBrowserToolbarProps {
  /** The number of files in the list; null while unknown. */
  total: number | null;
  filters: FileFilters;
  showRoleFilter: boolean;
  view: AssetView;
  /** Whether "Clear filters" is offered. */
  canClear: boolean;
  onClear(): void;
  onFilter(change: Partial<FileFilters>): void;
  onSwitchView(view: AssetView): void;
  /** The proposal filter and "Analyse all"; absent where the host offers no analysis. */
  analysis?: {
    /** Whether only files with a tag proposal are shown. */
    proposals: boolean;
    onToggleProposals(): void;
    /** Disables "Analyse all" with this tooltip; null enables it. */
    blocked: string | null;
    onAnalyseAll(): void;
  };
}

/**
 * The filter bar of the file browser.
 *
 * @param props the filters, the view and the handlers
 * @returns the filter bar
 */
export function FileBrowserToolbar(props: FileBrowserToolbarProps) {
  const { total, filters, analysis } = props;
  return (
    <FilterBar
      resultCount={total === null ? null : `${total} ${total === 1 ? 'file' : 'files'}`}
      countTitle={
        total !== null && total > MAX_SELECTION ? `At most ${MAX_SELECTION} files can be selected` : undefined
      }
      onClear={props.canClear ? props.onClear : null}
    >
      <>
        <SearchField
          label="Search files"
          placeholder="Search files"
          value={filters.query}
          onChange={(text) => props.onFilter({ query: text })}
        />
        {props.showRoleFilter && <RoleSelect filters={filters} onFilter={props.onFilter} />}
        <KindSelect filters={filters} onFilter={props.onFilter} />
        {analysis !== undefined && (
          <button
            type="button"
            className={BUTTON}
            aria-pressed={analysis.proposals}
            title={PROPOSALS_TITLE}
            onClick={analysis.onToggleProposals}
          >
            <Sparkles size={16} aria-hidden className="text-ai" />
            {PROPOSALS_LABEL}
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {analysis !== undefined && (
            <AnalyseAllButton
              blocked={analysis.proposals ? PROPOSALS_BLOCK_ANALYSE_ALL : analysis.blocked}
              onClick={analysis.onAnalyseAll}
            />
          )}
          {VIEWS.map(({ view, tooltip, icon: Icon }) => (
            <button
              key={view}
              type="button"
              className={ICON_BUTTON}
              title={tooltip}
              aria-label={tooltip}
              aria-pressed={props.view === view}
              onClick={() => props.onSwitchView(view)}
            >
              <Icon size={16} aria-hidden />
            </button>
          ))}
        </div>
      </>
      <TagFilter value={filters.tagNames} title="Image tags" onChange={(tagNames) => props.onFilter({ tagNames })} />
    </FilterBar>
  );
}

/** The props of a filter select. */
interface FilterSelectProps {
  filters: FileFilters;
  onFilter(change: Partial<FileFilters>): void;
}

/**
 * The Role filter.
 *
 * @param props the filters and the change handler
 * @returns the select
 */
function RoleSelect({ filters, onFilter }: FilterSelectProps) {
  return (
    <select
      className={SELECT}
      aria-label="Role"
      value={filters.role}
      onChange={(event) => onFilter({ role: ROLES.find((role) => role === event.target.value) ?? '' })}
    >
      <option value="">All roles</option>
      {ROLES.map((role) => (
        <option key={role} value={role}>
          {label(role)}
        </option>
      ))}
    </select>
  );
}

/**
 * The file type filter.
 *
 * @param props the filters and the change handler
 * @returns the select
 */
function KindSelect({ filters, onFilter }: FilterSelectProps) {
  return (
    <select
      className={SELECT}
      aria-label="File type"
      value={filters.kind}
      onChange={(event) => onFilter({ kind: KINDS.find((option) => option.kind === event.target.value)?.kind ?? '' })}
    >
      <option value="">All file types</option>
      {KINDS.map((option) => (
        <option key={option.kind} value={option.kind}>
          {option.title}
        </option>
      ))}
    </select>
  );
}
