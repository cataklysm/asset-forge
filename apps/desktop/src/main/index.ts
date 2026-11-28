import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, net, protocol, session, shell, type IpcMainInvokeEvent } from 'electron';
import { ipcContract, type IpcResult } from '@assetforge/contracts';
import { errorLogLine, writeLine, type WorkspaceManager } from '@assetforge/core';
import ffmpegPath from 'ffmpeg-static';
import {
  createPreviewService,
  createVideoFrames,
  createWorkerPool,
  JOB_TIMEOUT_MS,
  POOL_SIZE,
  type PreviewService,
} from '@assetforge/media';
import { createAnalysisServices, type AnalysisServices } from './analysis-services.js';
import { restrictAppPermissions } from './app-permissions.js';
import { closeApp } from './app-shutdown.js';
import { createWorkspaceManager } from './composition.js';
import { ElectronDialogs } from './electron-dialogs.js';
import { resolveFfmpegBinary } from './ffmpeg-binary.js';
import { createImportDirectoryMemory, IMPORT_DIRECTORY_FILE } from './import-directory.js';
import { createGenerationImageSource } from './generation-image-source.js';
import { dispatch, type IpcHandlers } from './ipc.js';
import { createLogFile, LOG_DIRECTORY } from './log-file.js';
import { attachLogFile, flushMainLog, mainLog } from './main-log.js';
import { createWorkspaceHandlers } from './workspace-handlers.js';
import { createSafeStorageCodec } from './secret-codec.js';
import type { SessionNetRequest } from './session-request.js';
import { createSitePartitionDirectory } from './site-partition-sweep.js';
import { createElectronSiteSessions, type ElectronSiteSessions } from './site-sessions.js';
import { getAppUrl, isAppOrigin, isAppUrl } from './app-url.js';
import { findOriginalIn, findSourceIn, findVideoIn, handleMediaRequest } from './media-protocol.js';
import { openFile } from './media-file.js';
import { MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES } from './media-routes.js';
import { ipcRefusal } from './sender.js';
import { createMainWindow, type MainWindowOptions } from './window.js';

declare const __ASSETFORGE_DEV_MIGRATIONS_FOLDER__: string | null;

const outMainDir = dirname(fileURLToPath(import.meta.url));

// Pin the name before anything reads `userData` (including the single-instance lock), so the
// data directory does not depend on the package name.
app.setName('AssetForge');

// Privileges must be registered before the app is ready; MEDIA_SCHEME_PRIVILEGES says why each one is set.
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { ...MEDIA_SCHEME_PRIVILEGES } }]);

// One writing client per machine: a second instance hands over to the first and quits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

/** The state the event handlers of the running app share. */
interface AppState {
  /** The main window, or null while there is none. */
  mainWindow: BrowserWindow | null;
  /** How far quitting has come. */
  shutdown: 'running' | 'closing' | 'closed';
}

/** The parts of the running app that the event handlers work on. */
interface AppParts {
  /** The shared state. */
  state: AppState;
  /** The preview service and its worker pool. */
  previews: PreviewService;
  /** The workspace manager. */
  manager: WorkspaceManager;
  /** The site windows and sessions. */
  siteSessions: ElectronSiteSessions;
  /** The analysis services and the job host. */
  services: AnalysisServices;
}

/** Wires the app together and registers its event handlers. */
function start(): void {
  const state: AppState = { mainWindow: null, shutdown: 'running' };

  // First, so every later line of the main log also lands in the bounded log file; only this instance writes it.
  attachLogFile(createLogFile({ directory: join(app.getPath('userData'), LOG_DIRECTORY) }));

  // One pool serves previews and measuring; closing the preview service closes it.
  const pool = createWorkerPool({
    workerUrl: new URL('./preview-worker.js', import.meta.url),
    size: POOL_SIZE,
    timeoutMs: JOB_TIMEOUT_MS,
    log: mainLog,
  });
  // The binary is hashed once per start, off the hot path: frame requests made before the check has
  // finished wait for it. Closing the preview service closes the frame tool.
  const ffmpegBinary = resolveFfmpegBinary({
    packagePath: ffmpegPath,
    platform: process.platform,
    arch: process.arch,
    warn: mainLog,
    runDir: join(app.getPath('userData'), 'bin'),
  });
  const frames = createVideoFrames({ binaryPath: ffmpegBinary });
  const previews = createPreviewService({ cacheDir: join(app.getPath('userData'), 'cache'), pool, frames });

  const manager = createWorkspaceManager({
    userDataPath: app.getPath('userData'),
    migrationsFolder: __ASSETFORGE_DEV_MIGRATIONS_FOLDER__ ?? join(outMainDir, 'migrations'),
    moveToTrash: (absolutePath) => shell.trashItem(absolutePath),
    imageProbe: { measure: (path) => pool.measure(path) },
    videoProbe: { measure: (path, format) => previews.measureVideo(path, format) },
    log: mainLog,
  });

  const importDirectory = createImportDirectoryMemory(join(app.getPath('userData'), IMPORT_DIRECTORY_FILE));
  const dialogs = new ElectronDialogs(() => state.mainWindow, importDirectory);

  const windowOptions: MainWindowOptions = {
    preloadPath: join(outMainDir, '../preload/index.cjs'),
    devServerUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'],
    rendererHtmlPath: join(outMainDir, '../renderer/index.html'),
    onLoadFailure: failStartup,
  };

  const appUrl = getAppUrl(windowOptions);

  // One persistent browser session per site profile; its windows never get a preload or Node. Closing the main
  // window or quitting ends a running crawl and closes the login window (shutdown).
  const siteSessions = createElectronSiteSessions({
    fromPartition: (partition) => session.fromPartition(partition),
    createWindow: (options) => new BrowserWindow(options),
    // Electron's IncomingMessage is a Readable at run time; its typings only declare the events.
    netRequest: (options) => net.request(options) as unknown as SessionNetRequest,
    log: mainLog,
  });

  // The vision settings store is the only source of the provider, its key and the default models.
  const services = createAnalysisServices({
    manager,
    userDataPath: app.getPath('userData'),
    secrets: createSafeStorageCodec(),
    env: process.env,
    images: { jpeg: (path, signal) => pool.jpeg(path, signal) },
    generationImages: createGenerationImageSource(previews),
    log: mainLog,
    appVersion: app.getVersion(),
    siteSessions,
  });
  const parts: AppParts = { state, previews, manager, siteSessions, services };

  const handlers = createWorkspaceHandlers(
    manager,
    dialogs,
    {
      openPath: (path) => shell.openPath(path),
      showItemInFolder: (path) => shell.showItemInFolder(path),
      openExternal: (url) => shell.openExternal(url),
      workspaceOpened: () => workspaceOpened(parts),
      workspaceClosing: () => services.workspaceClosing(),
    },
    services.jobHost,
    services,
  );
  for (const channel of Object.keys(ipcContract)) {
    ipcMain.handle(channel, (event, request: unknown) => handleIpc(state, handlers, appUrl, channel, event, request));
  }

  app.on('second-instance', () => focusMainWindow(state));

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => beforeQuit(parts, event));

  app
    .whenReady()
    .then(() => {
      // The main window's session grants only what the app page uses; site sessions are hardened on their own. This
      // must stay on the default session and before openMainWindow: until a handler is installed, Electron grants
      // every permission, so a window opened first could be answered by that default.
      restrictAppPermissions(session.defaultSession, {
        mainContents: () => state.mainWindow?.webContents ?? null,
        isAppUrl: (url) => isAppUrl(url, appUrl),
        isAppOrigin: (origin) => isAppOrigin(origin, appUrl),
        isFilePage: appUrl.startsWith('file:'),
      });
      registerMediaProtocol(manager, previews);
      openMainWindow(parts, windowOptions);
      // Sessions exist only once the app is ready; the sweep never rejects and logs no path, URL or cookie.
      void services.sweepSitePartitions(createSitePartitionDirectory(app.getPath('userData')));
    })
    .catch(failStartup);
}

/**
 * Runs after a workspace was opened: cleans the preview cache and starts the jobs.
 *
 * @param parts the parts of the running app
 */
async function workspaceOpened(parts: AppParts): Promise<void> {
  // cleanup() never rejects by contract; the catch keeps a broken promise from going unhandled.
  void parts.previews.cleanup().catch((error: unknown) => logError('Cleaning the preview cache failed', error));
  // A channel that was already running when quitting began must not start jobs on a closing database.
  if (parts.state.shutdown === 'running') await parts.services.workspaceOpened();
}

/**
 * Answers one IPC request, refusing it from any sender but the main window and while quitting.
 *
 * @param state the shared state
 * @param handlers the IPC handlers
 * @param appUrl the URL the main window's page is loaded from
 * @param channel the channel the request came in on
 * @param event the IPC event, naming the sender
 * @param request the request as sent
 * @returns the result for the renderer
 */
function handleIpc(
  state: AppState,
  handlers: IpcHandlers,
  appUrl: string,
  channel: string,
  event: IpcMainInvokeEvent,
  request: unknown,
): Promise<IpcResult<unknown>> {
  const refusal = ipcRefusal(event, state.mainWindow, (url) => isAppUrl(url, appUrl), state.shutdown !== 'running');
  if (refusal !== null) return Promise.resolve(refusal);
  return dispatch(handlers, channel, request);
}

/**
 * Brings the main window to the front, for a second instance that handed over.
 *
 * @param state the shared state
 */
function focusMainWindow(state: AppState): void {
  const mainWindow = state.mainWindow;
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/**
 * Holds the first quit back until the jobs, the workspace and the preview service are closed, then quits.
 *
 * @param parts the parts of the running app
 * @param event the quit event, prevented until everything is closed
 */
function beforeQuit(parts: AppParts, event: Electron.Event): void {
  const { state } = parts;
  if (state.shutdown === 'closed') return;
  event.preventDefault();
  if (state.shutdown === 'closing') return;
  state.shutdown = 'closing';
  void closeApp({ ...parts, logError, flushLog: flushMainLog }).finally(() => {
    state.shutdown = 'closed';
    app.quit();
  });
}

/**
 * Serves the media protocol from the open workspace and the preview cache.
 *
 * @param manager the workspace manager
 * @param previews the preview service
 */
function registerMediaProtocol(manager: WorkspaceManager, previews: PreviewService): void {
  protocol.handle(MEDIA_SCHEME, (request) =>
    handleMediaRequest(request, {
      findSource: findSourceIn(manager),
      findOriginal: findOriginalIn(manager),
      findVideo: findVideoIn(manager),
      previews,
      readFile,
      openFile,
    }),
  );
}

/**
 * Opens the main window; closing it ends a running crawl, closes the login window and stops a running import after
 * the item in progress, since the app quits with its last window.
 *
 * @param parts the parts of the running app
 * @param windowOptions how the main window loads
 */
function openMainWindow(parts: AppParts, windowOptions: MainWindowOptions): void {
  const { state } = parts;
  state.mainWindow = createMainWindow(windowOptions);
  state.mainWindow.on('closed', () => {
    state.mainWindow = null;
    parts.siteSessions.shutdown();
    parts.manager.cancelImport();
  });
}

/**
 * A failed start must not leave an invisible process holding the single-instance lock.
 *
 * @param error why the start failed
 */
function failStartup(error: unknown): void {
  logError('AssetForge failed to start', error);
  // The flush is bounded by the log file's deadline and never rejects.
  void flushMainLog().finally(() => app.exit(1));
}

/**
 * Writes one line about a failure of the main process: the fixed text and the error's safe description, never its
 * message or stack, which carry paths.
 *
 * @param message the fixed text
 * @param error what failed
 */
function logError(message: string, error: unknown): void {
  writeLine(mainLog, errorLogLine(message, {}, error));
}
