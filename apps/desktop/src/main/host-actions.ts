import type { WorkspaceSummary } from '@assetforge/contracts';

// What the handlers ask of the host (Electron): its dialogs and the actions only it can perform. Tests fake both.

/** How the user chose to remove a workspace. */
export type RemoveChoice = 'cancel' | 'forget' | 'forget_and_trash_folder';

/** The native dialogs the handlers open. */
export interface Dialogs {
  /**
   * Lets the user choose a directory.
   *
   * @returns its path, or null when cancelled
   */
  pickDirectory(): Promise<string | null>;
  /**
   * Lets the user choose files to import.
   *
   * @returns their paths; none when cancelled
   */
  pickFiles(): Promise<string[]>;
  /**
   * Asks the user how to remove a workspace; the renderer cannot answer this itself.
   *
   * @param workspace the workspace to remove
   * @returns the user's choice
   */
  confirmRemoveWorkspace(workspace: WorkspaceSummary): Promise<RemoveChoice>;
  /**
   * Asks whether the workflow of an asset may be removed.
   *
   * @param assetName the asset's name, shown in the dialog
   * @returns true when the user agreed
   */
  confirmRemoveWorkflow(assetName: string): Promise<boolean>;
}

/** Actions only the host (Electron) can perform. */
export interface HostActions {
  /**
   * Electron shell.openPath.
   *
   * @param absolutePath the file to open
   * @returns '' on success, an error text otherwise
   */
  openPath(absolutePath: string): Promise<string>;
  /**
   * Shows the file in the system's file manager.
   *
   * @param absolutePath the file to show
   */
  showItemInFolder(absolutePath: string): void;
  /**
   * Electron shell.openExternal: hands an http(s) address to the system browser; rejects when that fails.
   *
   * @param url the address to open
   */
  openExternal(url: string): Promise<void>;
  /** Called after a workspace lifecycle channel when a workspace is open afterwards. Never rejects. */
  workspaceOpened(): Promise<void>;
  /** Called before a workspace lifecycle channel calls the manager. Never rejects. */
  workspaceClosing(): Promise<void>;
}
