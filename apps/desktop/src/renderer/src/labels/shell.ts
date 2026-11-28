// The texts of the application frame: the loading line, the header, the main navigation and the banners.

/** The line shown while something loads. */
export const LOADING_LABEL = 'Loading…';
/** The tooltip of the navigation (and of the dialogs' Settings) while an import runs. */
export const BUSY_TITLE = 'Import in progress';

/** The header button back to the workspaces. */
export const WORKSPACES_BUTTON = 'Workspaces';
/** The name of the main navigation. */
export const MAIN_NAV_LABEL = 'Main';
// The navigation entries without a label of their own subject; Settings uses `SETTINGS_LABEL`.
/** The navigation entry of the gallery. */
export const ASSETS_NAV_LABEL = 'Assets';
/** The navigation entry of the projects list. */
export const PROJECTS_NAV_LABEL = 'Projects';
/** The navigation entry of the inbox. */
export const INBOX_NAV_LABEL = 'Inbox';
/** The navigation entry of the Jobs screen. */
export const JOBS_NAV_LABEL = 'Jobs';

/**
 * The accessible name of a navigation entry with an active count: 'Jobs, 3 active'.
 *
 * @param label the visible label of the entry
 * @param count the active count
 * @returns the name
 */
export function activeNavLabel(label: string, count: number): string {
  return `${label}, ${count} active`;
}
