import { pathToFileURL } from 'node:url';

// Kept free of Electron imports: this is the rule behind both the navigation lock and
// IPC sender trust, so it must be unit-testable.

/** Where the app page comes from. */
export interface AppUrlOptions {
  /** Dev server URL (`ELECTRON_RENDERER_URL`) or `undefined` to load the built renderer. */
  devServerUrl: string | undefined;
  /** The built renderer's HTML file. */
  rendererHtmlPath: string;
}

/**
 * The URL the main window loads; navigation is only allowed within it.
 *
 * @param options where the app page comes from
 * @returns the URL
 */
export function getAppUrl(options: AppUrlOptions): string {
  return options.devServerUrl ?? pathToFileURL(options.rendererHtmlPath).href;
}

/**
 * Same origin for http(s). For the built `file:` renderer, the same document only: same
 * host (so a UNC `file://server/...` URL with the same path is foreign) and same path.
 * Query and hash are ignored there, because they do not select another file.
 *
 * @param target the URL to check
 * @param appUrl the URL of the app page
 * @returns true when the target is the app
 */
export function isAppUrl(target: string, appUrl: string): boolean {
  let next: URL;
  let app: URL;
  try {
    next = new URL(target);
    app = new URL(appUrl);
  } catch {
    return false;
  }
  if (app.protocol === 'file:') {
    return next.protocol === 'file:' && next.host === app.host && next.pathname === app.pathname;
  }
  return next.origin === app.origin;
}
