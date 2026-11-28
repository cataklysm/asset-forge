import type { BrowserWindow, BrowserWindowConstructorOptions, Session, WebContents } from 'electron';
import type { SiteProfile } from '@assetforge/contracts';
import { prepareWindow, windowOptions, type NavigationEvent } from './site-window-options.js';

// The visible login window of a site profile (spec "Browser sessions"): the user logs in there, and the session
// keeps the cookies for the crawl and the downloads.

/**
 * The login window's title.
 *
 * @param name the profile name
 * @param url the page the window shows
 * @returns `<profile name> – <current host>`, the name alone without a host
 */
export function loginTitle(name: string, url: string): string {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    // Keep the name alone.
  }
  return host === '' ? name : `${name} – ${host}`;
}

/**
 * The login window goes to any http/https URL; the request filter keeps it to public hosts.
 *
 * @param url the navigation target
 * @returns true for an http/https URL without user info
 */
export function loginNavigationAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

/**
 * Creates the login window of a profile with its guards; it loads nothing yet. A popup target that is allowed is
 * loaded in the same window, and the title always names the profile and the current host.
 *
 * @param createWindow Electron's window constructor
 * @param session the profile's hardened session
 * @param profile the profile
 * @param url the page the window opens on, for its first title
 * @returns the window
 */
export function createLoginWindow(
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow,
  session: Session,
  profile: SiteProfile,
  url: string,
): BrowserWindow {
  const window = createWindow(windowOptions(session, true, loginTitle(profile.name, url)));
  prepareWindow(window);
  const contents = window.webContents;
  const guard = (event: NavigationEvent) => {
    if (!loginNavigationAllowed(event.url)) event.preventDefault();
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.setWindowOpenHandler(({ url: target }) => {
    if (loginNavigationAllowed(target)) contents.loadURL(target).catch(() => {});
    return { action: 'deny' };
  });
  // Page titles never replace the profile name and host.
  window.on('page-title-updated', (event) => event.preventDefault());
  const retitle = (_event: unknown, current: string) => {
    if (!window.isDestroyed()) window.setTitle(loginTitle(profile.name, current));
  };
  contents.on('did-navigate', retitle);
  contents.on('did-navigate-in-page', retitle);
  return window;
}

/**
 * Loads the first page of the login window.
 *
 * @param contents the window's contents
 * @param url the page to open
 */
export function loadLoginPage(contents: WebContents, url: string): void {
  contents.loadURL(url).catch(() => {
    // The window shows Chromium's error page; nothing to report.
  });
}
