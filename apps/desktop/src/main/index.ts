import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  dialog,
  ipcMain,
  type BrowserWindow,
  shell,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from 'electron';
import { ipcContract, type IpcResult } from '@assetforge/contracts';
import { createWorkspaceManager } from './composition.js';
import { createWorkspaceHandlers, dispatch, type Dialogs } from './ipc.js';
import { getAppUrl, isAppUrl } from './app-url.js';
import { isTrustedSender } from './sender.js';
import { createMainWindow, type MainWindowOptions } from './window.js';

declare const __ASSETFORGE_DEV_MIGRATIONS_FOLDER__: string | null;

const outMainDir = dirname(fileURLToPath(import.meta.url));

// Pin the name before anything reads `userData` (including the single-instance lock), so the
// data directory does not depend on the package name.
app.setName('AssetForge');

// One writing client per machine: a second instance hands over to the first and quits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start(): void {
  let mainWindow: BrowserWindow | null = null;
  let shutdown: 'running' | 'closing' | 'closed' = 'running';

  const manager = createWorkspaceManager({
    userDataPath: app.getPath('userData'),
    migrationsFolder: __ASSETFORGE_DEV_MIGRATIONS_FOLDER__ ?? join(outMainDir, 'migrations'),
    moveToTrash: (absolutePath) => shell.trashItem(absolutePath),
  });

  const dialogs: Dialogs = {
    async pickDirectory() {
      const result = await showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async pickFiles() {
      const result = await showOpenDialog({ properties: ['openFile', 'multiSelections'] });
      return result.canceled ? [] : result.filePaths;
    },
    async confirmRemoveWorkspace(workspace) {
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
      const { response } = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      return (['cancel', 'forget', 'forget_and_trash_folder'] as const)[response] ?? 'cancel';
    },
  };
  function showOpenDialog(options: OpenDialogOptions) {
    return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
  }

  const windowOptions: MainWindowOptions = {
    preloadPath: join(outMainDir, '../preload/index.cjs'),
    devServerUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'],
    rendererHtmlPath: join(outMainDir, '../renderer/index.html'),
    onLoadFailure: failStartup,
  };

  const appUrl = getAppUrl(windowOptions);

  const handlers = createWorkspaceHandlers(manager, dialogs);
  for (const channel of Object.keys(ipcContract)) {
    ipcMain.handle(channel, (event, request: unknown): Promise<IpcResult<unknown>> => {
      if (shutdown !== 'running') {
        return Promise.resolve({
          ok: false,
          error: { code: 'shutting_down', message: 'The application is shutting down' },
        });
      }
      if (!isTrustedSender(event, mainWindow, (url) => isAppUrl(url, appUrl))) {
        return Promise.resolve({
          ok: false,
          error: { code: 'forbidden_sender', message: 'IPC sender is not the main window' },
        });
      }
      return dispatch(handlers, channel, request);
    });
  }

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (shutdown === 'closed') return;
    event.preventDefault();
    if (shutdown === 'closing') return;
    shutdown = 'closing';
    manager
      .close()
      .catch((error: unknown) => console.error('Closing the workspace failed', error))
      .finally(() => {
        shutdown = 'closed';
        app.quit();
      });
  });

  app
    .whenReady()
    .then(() => {
      mainWindow = createMainWindow(windowOptions);
      mainWindow.on('closed', () => {
        mainWindow = null;
      });
    })
    .catch(failStartup);
}

/** A failed start must not leave an invisible process holding the single-instance lock. */
function failStartup(error: unknown): void {
  console.error('AssetForge failed to start', error);
  app.exit(1);
}
