/** The start screen without an open workspace (WorkspaceScreen, WorkspaceTable, CreateWorkspaceDialog). */
export const APP_NAME = 'AssetForge';
export const WORKSPACES_TITLE = 'Workspaces';
export const OPEN_FOLDER_LABEL = 'Open folder';
export const NEW_WORKSPACE_LABEL = 'New workspace';

/** The columns and the row of the workspace table. */
export const WORKSPACE_NAME_COLUMN = 'Name';
export const WORKSPACE_LOCATION_COLUMN = 'Location';
export const WORKSPACE_LAST_OPENED_COLUMN = 'Last opened';
export const OPEN_WORKSPACE_BUTTON = 'Open';
export const REMOVE_WORKSPACE_LABEL = 'Remove';
export const REMOVE_WORKSPACE_TITLE = 'Remove this workspace from AssetForge; asks before anything is removed';

/** The New workspace dialog. */
export const WORKSPACE_NAME_LABEL = 'Workspace name';
export const CHOOSE_LOCATION_LABEL = 'Choose location';
export const CHANGE_LOCATION_LABEL = 'Change location';
export const CHOOSE_LOCATION_TITLE = 'A folder named after the workspace is created inside the chosen location';
export const CREATE_LOCATION_TITLE = 'Folder the workspace will be created in';
export const CREATE_WORKSPACE_LABEL = 'Create';

/**
 * '1 workspace' / '3 workspaces'.
 *
 * @param count the number of workspaces
 * @returns the count with the noun in singular or plural
 */
export const workspaceCount = (count: number) => (count === 1 ? '1 workspace' : `${count} workspaces`);

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
