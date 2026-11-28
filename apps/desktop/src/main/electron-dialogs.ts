import {
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
} from 'electron';
import type { WorkspaceSummary } from '@assetforge/contracts';
import type { Dialogs, RemoveChoice } from './host-actions.js';
import type { ImportDirectoryMemory } from './import-directory.js';

/** The native dialogs of the app, modal to the main window while it exists. */
export class ElectronDialogs implements Dialogs {
  /**
   * @param window the main window, or null while there is none
   * @param importDirectory the directory the file picker opens in
   */
  constructor(
    private readonly window: () => BrowserWindow | null,
    private readonly importDirectory: ImportDirectoryMemory,
  ) {}

  /**
   * Lets the user choose a directory.
   *
   * @returns its path, or null when cancelled
   */
  async pickDirectory(): Promise<string | null> {
    const result = await this.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }

  /**
   * Lets the user choose files to import, starting in the directory chosen last time.
   *
   * @returns their paths; none when cancelled
   */
  async pickFiles(): Promise<string[]> {
    const defaultPath = await this.importDirectory.current();
    const result = await this.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      ...(defaultPath === undefined ? {} : { defaultPath }),
    });
    if (result.canceled) return [];
    this.importDirectory.remember(result.filePaths);
    return result.filePaths;
  }

  /**
   * Asks the user how to remove a workspace.
   *
   * @param workspace the workspace to remove
   * @returns the user's choice
   */
  async confirmRemoveWorkspace(workspace: WorkspaceSummary): Promise<RemoveChoice> {
    const options: MessageBoxOptions = {
      type: 'warning',
      title: 'Remove workspace',
      message: `Remove the workspace "${workspace.name}"?`,
      detail: `${workspace.rootPath}\n\nRemoving it deletes its catalog in AssetForge. The files in the folder stay where they are unless you also move the folder to the trash.`,
      buttons: ['Cancel', 'Remove from AssetForge', 'Remove and move folder to trash'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const { response } = await this.showMessageBox(options);
    return (['cancel', 'forget', 'forget_and_trash_folder'] as const)[response] ?? 'cancel';
  }

  /**
   * Asks whether the workflow of an asset may be removed.
   *
   * @param assetName the asset's name, shown in the dialog
   * @returns true when the user agreed
   */
  async confirmRemoveWorkflow(assetName: string): Promise<boolean> {
    const options: MessageBoxOptions = {
      type: 'warning',
      title: 'Remove workflow',
      message: `Remove the workflow from "${assetName}"?`,
      detail: 'Step states and notes are deleted. The asset and its files are kept.',
      buttons: ['Remove workflow', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } = await this.showMessageBox(options);
    return response === 0;
  }

  /**
   * Shows an open dialog, modal to the main window while it exists.
   *
   * @param options the dialog's options
   * @returns what the user chose
   */
  private showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
    const window = this.window();
    return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
  }

  /**
   * Shows a message box, modal to the main window while it exists.
   *
   * @param options the box's options
   * @returns which button the user pressed
   */
  private showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
    const window = this.window();
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  }
}
