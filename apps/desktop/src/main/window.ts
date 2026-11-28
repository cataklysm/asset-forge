import { BrowserWindow, nativeTheme } from 'electron';
import { getAppUrl, isAppUrl, type AppUrlOptions } from './app-url.js';
import { createLoadFailureHandler } from './load-failure.js';

/** How the main window is built and loaded. */
export interface MainWindowOptions extends AppUrlOptions {
  /** The built preload script. */
  preloadPath: string;
  /**
   * Called when the initial load of the app page fails; the window cannot show anything useful.
   *
   * @param error why it failed
   */
  onLoadFailure(error: unknown): void;
}

/** The background equals the page token `--color-bg`, so the window does not flash light before the page paints. */
export const WINDOW_APPEARANCE = { backgroundColor: '#060b1d', minWidth: 1024, minHeight: 680 } as const;

/**
 * Creates the main window, locks its navigation to the app and loads the app page.
 *
 * @param options how the window is built and loaded
 * @returns the window
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  nativeTheme.themeSource = 'dark';
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    ...WINDOW_APPEARANCE,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const appUrl = getAppUrl(options);
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, appUrl)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());

  // Only the initial load is fatal; later failures (e.g. a dev-server restart) are left to the user.
  const loadFailure = createLoadFailureHandler(options.onLoadFailure);
  contents.once('did-finish-load', () => loadFailure.finished());
  contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) =>
    loadFailure.didFailLoad(errorCode, errorDescription, isMainFrame),
  );

  const loading = options.devServerUrl
    ? window.loadURL(options.devServerUrl)
    : window.loadFile(options.rendererHtmlPath);
  loading.catch((error: unknown) => loadFailure.rejected(error));
  return window;
}
