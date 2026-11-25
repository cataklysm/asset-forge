import { pathToFileURL } from 'node:url';
import { BrowserWindow } from 'electron';

export interface MainWindowOptions {
  preloadPath: string;
  /** Dev server URL (`ELECTRON_RENDERER_URL`) or `undefined` to load the built renderer. */
  devServerUrl: string | undefined;
  rendererHtmlPath: string;
  /** Called when the initial load of the app page fails; the window cannot show anything useful. */
  onLoadFailure(error: unknown): void;
}

/** The URL the main window loads; navigation is only allowed within it. */
export function getAppUrl(opts: Pick<MainWindowOptions, 'devServerUrl' | 'rendererHtmlPath'>): string {
  return opts.devServerUrl ?? pathToFileURL(opts.rendererHtmlPath).href;
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
  let initialLoadDone = false;
  contents.once('did-finish-load', () => {
    initialLoadDone = true;
  });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    // -3 (ERR_ABORTED) is a superseded or cancelled navigation, not a failed load.
    if (isMainFrame && !initialLoadDone && errorCode !== -3) {
      opts.onLoadFailure(new Error(`Loading the app page failed: ${errorDescription} (${errorCode})`));
    }
  });

  const loading = opts.devServerUrl
    ? window.loadURL(opts.devServerUrl)
    : window.loadFile(opts.rendererHtmlPath);
  loading.catch(opts.onLoadFailure);
  return window;
}

/** Same origin for http(s); for the built `file:` renderer, the same document only. */
export function isAppUrl(target: string, appUrl: string): boolean {
  let next: URL;
  let app: URL;
  try {
    next = new URL(target);
    app = new URL(appUrl);
  } catch {
    return false;
  }
  if (app.protocol === 'file:') return next.protocol === 'file:' && next.pathname === app.pathname;
  return next.origin === app.origin;
}
