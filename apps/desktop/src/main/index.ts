import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  dialog,
  ipcMain,
  protocol,
  type BrowserWindow,
  shell,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from 'electron';
import { ipcContract, type IpcResult } from '@assetforge/contracts';
import { createPreviewService, createWorkerPool, JOB_TIMEOUT_MS, POOL_SIZE } from '@assetforge/media';
import { createWorkspaceManager } from './composition.js';
import { createWorkspaceHandlers, dispatch, type Dialogs } from './ipc.js';
import { getAppUrl, isAppUrl } from './app-url.js';
import { findOriginalIn, findSourceIn, handleMediaRequest, MEDIA_SCHEME, openFile } from './media-protocol.js';
import { isTrustedSender } from './sender.js';
import { createMainWindow, type MainWindowOptions } from './window.js';

declare const __ASSETFORGE_DEV_MIGRATIONS_FOLDER__: string | null;

const outMainDir = dirname(fileURLToPath(import.meta.url));

// Pin the name before anything reads `userData` (including the single-instance lock), so the
// data directory does not depend on the package name.
app.setName('AssetForge');

// Privileges must be registered before the app is ready. `standard` makes preview URLs parse like
// http URLs (host, path, canonical form); `secure` treats the scheme as a secure origin, so loading
// previews into the page is not mixed content. The renderer's CSP admits them through its explicit
// `img-src assetforge-media:` entry, not through either privilege.
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true } }]);

// One writing client per machine: a second instance hands over to the first and quits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start(): void {
  let mainWindow: BrowserWindow | null = null;
  let shutdown: 'running' | 'closing' | 'closed' = 'running';

  // One pool serves previews and measuring; closing the preview service closes it.
  const pool = createWorkerPool({
    workerUrl: new URL('./preview-worker.js', import.meta.url),
    size: POOL_SIZE,
    timeoutMs: JOB_TIMEOUT_MS,
  });
  const previews = createPreviewService({ cacheDir: join(app.getPath('userData'), 'cache'), pool });

  const manager = createWorkspaceManager({
    userDataPath: app.getPath('userData'),
    migrationsFolder: __ASSETFORGE_DEV_MIGRATIONS_FOLDER__ ?? join(outMainDir, 'migrations'),
    moveToTrash: (absolutePath) => shell.trashItem(absolutePath),
    imageProbe: { measure: (path) => pool.measure(path) },
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
    async confirmRemoveWorkflow(assetName) {
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
      const { response } = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      return response === 0;
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

  const handlers = createWorkspaceHandlers(manager, dialogs, {
    openPath: (path) => shell.openPath(path),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    // cleanup() never rejects by contract; the catch keeps a broken promise from going unhandled.
    workspaceOpened: () => {
      void previews.cleanup().catch((error: unknown) => console.error('Cleaning the preview cache failed', error));
    },
  });
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
      .then(() => previews.close())
      .catch((error: unknown) => console.error('Closing the preview service failed', error))
      .finally(() => {
        shutdown = 'closed';
        app.quit();
      });
  });

  app
    .whenReady()
    .then(() => {
      protocol.handle(MEDIA_SCHEME, (request) =>
        handleMediaRequest(request, {
          findSource: findSourceIn(manager),
          findOriginal: findOriginalIn(manager),
          previews,
          readFile,
          openFile,
        }),
      );
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
