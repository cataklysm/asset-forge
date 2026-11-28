// The texts of the projects list: the page, its filters and the table.

/** The page title and the grid's name. */
export const PROJECTS_TITLE = 'Projects';
/** The tooltip of the count beside the title. */
export const PROJECTS_COUNT_TITLE = 'Projects in the workspace';
/** The button that opens the new-project dialog. */
export const NEW_PROJECT_LABEL = 'New project';
/** The label and placeholder of the search field. */
export const SEARCH_PROJECTS_LABEL = 'Search projects';
/** The name of the status filter. */
export const PROJECT_STATUS_FILTER_LABEL = 'Status';
/** The status filter's option that matches every status. */
export const ALL_PROJECT_STATUSES_LABEL = 'All statuses';
/** The tooltip of the tag filter. */
export const PROJECT_TAG_FILTER_TITLE =
  'Projects with one member asset that carries all these tags, on the asset or on one of its files';
/** The empty list with a filter applied. */
export const NO_MATCHING_PROJECTS = 'No matching projects';
/** The empty list without a filter. */
export const NO_PROJECTS = 'No projects';

/** The project name column. */
export const PROJECT_COLUMN = 'Project';
/** The project status column. */
export const PROJECT_STATUS_COLUMN = 'Status';
/** The member count column. */
export const PROJECT_ASSETS_COLUMN = 'Assets';
/** The column shown with a tag filter. */
export const PROJECT_MATCHING_TAGS_COLUMN = 'Matching tags';
/** The name of the row action column. */
export const PROJECT_ACTIONS_COLUMN = 'Actions';
/** A row's button that opens the project. */
export const OPEN_PROJECT_BUTTON = 'Open';

// The result count of the filter bar.
export { projectCount } from './counts';

/**
 * The accessible name of a row's Open button.
 *
 * @param name the project name
 * @returns `Open <name>`
 */
export function openProjectLabel(name: string): string {
  return `Open ${name}`;
}
