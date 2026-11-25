import { pathToFileURL } from 'node:url';
import { BrowserWindow } from 'electron';

export interface MainWindowOptions {
  preloadPath: string;
  /** Dev server URL (`ELECTRON_RENDERER_URL`) or `undefined` to load the built renderer. */
  devServerUrl: string | undefined;
  rendererHtmlPath: string;
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

  const appUrl = opts.devServerUrl ?? pathToFileURL(opts.rendererHtmlPath).href;
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, appUrl)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());

  if (opts.devServerUrl) void window.loadURL(opts.devServerUrl);
  else void window.loadFile(opts.rendererHtmlPath);
  return window;
}

/** Same origin for http(s); for the built `file:` renderer, the same document only. */
function isAppUrl(target: string, appUrl: string): boolean {
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
