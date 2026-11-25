import { BrowserWindow } from 'electron';
import { getAppUrl, isAppUrl, type AppUrlOptions } from './app-url.js';
import { createLoadFailureHandler } from './load-failure.js';

export interface MainWindowOptions extends AppUrlOptions {
  preloadPath: string;
  /** Called when the initial load of the app page fails; the window cannot show anything useful. */
  onLoadFailure(error: unknown): void;
}

export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const appUrl = getAppUrl(opts);
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, appUrl)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());

  // Only the initial load is fatal; later failures (e.g. a dev-server restart) are left to the user.
  const loadFailure = createLoadFailureHandler(opts.onLoadFailure);
  contents.once('did-finish-load', () => loadFailure.finished());
  contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) =>
    loadFailure.didFailLoad(errorCode, errorDescription, isMainFrame),
  );

  const loading = opts.devServerUrl
    ? window.loadURL(opts.devServerUrl)
    : window.loadFile(opts.rendererHtmlPath);
  loading.catch((error: unknown) => loadFailure.rejected(error));
  return window;
}
