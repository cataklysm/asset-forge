import type { ProjectSummary } from '@assetforge/contracts';
import { call } from '../api';
import { NO_PROJECT_RESULTS, PROJECT_RESULTS_LABEL } from '../labels';
import { SearchPicker } from './SearchPicker';

// A search field that picks one project.

interface Props {
  /** The accessible name and placeholder of the input. */
  label: string;
  /** The tooltip of the input. */
  title?: string;
  /** Projects that are never offered. */
  excludeIds?: readonly string[];
  /** Receives the picked project; a second pick waits until it has settled. */
  onPick(project: ProjectSummary): unknown;
  /** Stretches the search input to the width of its container. */
  fullWidth?: boolean;
}

/**
 * The first page of projects matching a search text.
 *
 * @param term the rested search text, '' for none
 * @param limit the page size
 * @returns the page
 */
function searchProjects(term: string, limit: number) {
  return call('projects:list', { limit, offset: 0, ...(term !== '' && { query: term }) });
}

/**
 * A combobox that finds a project through the project search.
 *
 * @param props the label, the tooltip, the excluded projects, the pick callback and the width
 * @returns the combobox
 */
export function ProjectPicker({ label, title, excludeIds, onPick, fullWidth }: Props) {
  return (
    <SearchPicker
      label={label}
      listLabel={PROJECT_RESULTS_LABEL}
      emptyText={NO_PROJECT_RESULTS}
      title={title}
      search={searchProjects}
      excludeIds={excludeIds}
      onPick={onPick}
      fullWidth={fullWidth}
    />
  );
}
