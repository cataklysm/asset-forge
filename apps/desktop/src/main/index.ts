import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron';
import { ipcContract, type IpcResult } from '@assetforge/contracts';
import { createWorkspaceManager } from './composition.js';
import { createWorkspaceHandlers, dispatch, type Dialogs } from './ipc.js';
import { createMainWindow } from './window.js';

declare const __ASSETFORGE_DEV_MIGRATIONS_FOLDER__: string | null;

const outMainDir = dirname(fileURLToPath(import.meta.url));

// One writing client per machine: a second instance hands over to the first and quits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start(): void {
  let mainWindow: BrowserWindow | null = null;

  const manager = createWorkspaceManager({
    userDataPath: app.getPath('userData'),
    migrationsFolder: __ASSETFORGE_DEV_MIGRATIONS_FOLDER__ ?? join(outMainDir, 'migrations'),
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
  };
  function showOpenDialog(options: OpenDialogOptions) {
    return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
  }

  const handlers = createWorkspaceHandlers(manager, dialogs);
  for (const channel of Object.keys(ipcContract)) {
    ipcMain.handle(channel, (event, request: unknown): Promise<IpcResult<unknown>> => {
      if (!isFromMainWindow(event, mainWindow)) {
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

  let shutdown: 'running' | 'closing' | 'closed' = 'running';
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

  void app.whenReady().then(() => {
    mainWindow = createMainWindow({
      preloadPath: join(outMainDir, '../preload/index.cjs'),
      devServerUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'],
      rendererHtmlPath: join(outMainDir, '../renderer/index.html'),
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  });
}

function isFromMainWindow(event: IpcMainInvokeEvent, mainWindow: BrowserWindow | null): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  return event.senderFrame !== null && event.senderFrame === mainWindow.webContents.mainFrame;
}
