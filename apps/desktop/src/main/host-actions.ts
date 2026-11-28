import type { WorkspaceSummary } from '@assetforge/contracts';
import { InvalidOperationError } from '@assetforge/core';

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
   * Asks whether a workspace may be removed although its final backup failed.
   *
   * @param workspace the workspace to remove
   * @param message the fixed message of the failed backup
   * @returns true when the user chose to remove it anyway
   */
  confirmRemoveWithoutBackup(workspace: WorkspaceSummary, message: string): Promise<boolean>;
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

/**
 * Hands a stored, re-checked address to the system browser.
 *
 * @param host the host
 * @param url the address, read from the workspace and checked by the URL rule again
 * @throws InvalidOperationError with a fixed message when the shell fails
 */
export async function openStoredUrl(host: Pick<HostActions, 'openExternal'>, url: string): Promise<void> {
  try {
    await host.openExternal(url);
  } catch {
    // The shell's error may carry paths or the address; it is never forwarded.
    throw new InvalidOperationError('This source could not be opened');
  }
}
