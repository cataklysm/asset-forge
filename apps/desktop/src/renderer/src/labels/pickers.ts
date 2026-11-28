// The search-driven pickers: the asset picker, the project picker and the project filter of the gallery.

/** The input of the asset picker. */
export const SEARCH_ASSETS_PICKER_LABEL = 'Search assets';
/** The result list of the asset picker. */
export const ASSET_RESULTS_LABEL = 'Assets';
/** The asset picker without a match. */
export const NO_ASSET_RESULTS = 'No assets';

/** The input of the project picker on the asset screen. */
export const ADD_TO_PROJECT_LABEL = 'Add to project';
/** The input of the project filter in the gallery. */
export const PROJECT_FILTER_LABEL = 'Project';
/** The result list of a project picker. */
export const PROJECT_RESULTS_LABEL = 'Projects';
/** A project picker without a match. */
export const NO_PROJECT_RESULTS = 'No projects';
/** The tooltip of the project filter. */
export const PROJECT_FILTER_TITLE = 'Assets assigned to this project';

/**
 * The remove button of the chosen project in the gallery filter.
 *
 * @param name the project's name
 * @returns the accessible name
 */
export function removeProjectFilterLabel(name: string): string {
  return `Remove project ${name}`;
}
