// The start screen without an open workspace (WorkspaceScreen, WorkspaceTable, CreateWorkspaceDialog).

/** The heading of the start screen. */
export const APP_NAME = 'AssetForge';
/** The heading of the list of known workspaces. */
export const WORKSPACES_TITLE = 'Workspaces';
/** The button that opens an existing workspace folder. */
export const OPEN_FOLDER_LABEL = 'Open folder';
/** The button that opens the New workspace dialog. */
export const NEW_WORKSPACE_LABEL = 'New workspace';

/** The name column of the workspace table. */
export const WORKSPACE_NAME_COLUMN = 'Name';
/** The location column. */
export const WORKSPACE_LOCATION_COLUMN = 'Location';
/** The last-opened column. */
export const WORKSPACE_LAST_OPENED_COLUMN = 'Last opened';
/** A row's button that opens the workspace. */
export const OPEN_WORKSPACE_BUTTON = 'Open';
/** A row's menu item that removes the workspace from the list. */
export const REMOVE_WORKSPACE_LABEL = 'Remove';
/** The tooltip of the remove item. */
export const REMOVE_WORKSPACE_TITLE = 'Remove this workspace from AssetForge; asks before anything is removed';

/** The name field of the New workspace dialog. */
export const WORKSPACE_NAME_LABEL = 'Workspace name';
/** The location button before a location was chosen. */
export const CHOOSE_LOCATION_LABEL = 'Choose location';
/** The location button after a location was chosen. */
export const CHANGE_LOCATION_LABEL = 'Change location';
/** The tooltip of the location button. */
export const CHOOSE_LOCATION_TITLE = 'A folder named after the workspace is created inside the chosen location';
/** The tooltip of the chosen location. */
export const CREATE_LOCATION_TITLE = 'Folder the workspace will be created in';
/** The dialog's confirm button. */
export const CREATE_WORKSPACE_LABEL = 'Create';

// The count beside the list of known workspaces.
export { workspaceCount } from './counts';

/**
 * The accessible name of a row's Open button: 'Open workspace Old'.
 *
 * @param name the workspace name
 * @returns the accessible name
 */
export const openWorkspaceLabel = (name: string) => `Open workspace ${name}`;

/**
 * The accessible name of a row's menu: 'Actions for Old'.
 *
 * @param name the workspace name
 * @returns the accessible name
 */
export const workspaceActionsLabel = (name: string) => `Actions for ${name}`;
