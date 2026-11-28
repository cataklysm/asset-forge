import { describe, expect, it } from 'vitest';
import {
  isAppPermissionGranted,
  restrictAppPermissions,
  type AppPermissionContext,
  type PermissionContents,
  type PermissionSession,
} from '../src/main/app-permissions.js';
import { isAppOrigin, isAppUrl } from '../src/main/app-url.js';

const APP_URL = 'file:///C:/app/index.html';
const FOREIGN = 'https://example.com/';

/** A web contents showing a URL. */
function contentsAt(url: string): PermissionContents {
  return { getURL: () => url };
}

const main = contentsAt(APP_URL);
const context: AppPermissionContext = {
  mainContents: () => main,
  isAppUrl: (url) => isAppUrl(url, APP_URL),
  isAppOrigin: (origin) => isAppOrigin(origin, APP_URL),
};
const appFrame = { isMainFrame: true, isApp: true };

/** The two handlers the rule installs on a fake session. */
function installed(): {
  request: Parameters<PermissionSession['setPermissionRequestHandler']>[0];
  check: Parameters<PermissionSession['setPermissionCheckHandler']>[0];
} {
  const handlers: Partial<ReturnType<typeof installed>> = {};
  restrictAppPermissions(
    {
      setPermissionRequestHandler: (handler) => (handlers.request = handler),
      setPermissionCheckHandler: (handler) => (handlers.check = handler),
    },
    context,
  );
  return handlers as ReturnType<typeof installed>;
}

/**
 * Answers one request through the installed handler.
 *
 * @param details the request's frame
 * @param permission the permission asked for
 * @returns the answer
 */
function requested(details: { isMainFrame: boolean; requestingUrl: string }, permission = 'fullscreen'): boolean {
  let answer: boolean | undefined;
  installed().request(main, permission, (isGranted) => (answer = isGranted), details);
  return answer!;
}

describe('app permissions', () => {
  it.each(['fullscreen', 'clipboard-sanitized-write'])('grants %s to the main window showing the app', (permission) => {
    expect(isAppPermissionGranted(context, main, permission, appFrame)).toBe(true);
  });

  it.each(['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'unknown'])(
    'refuses %s',
    (permission) => {
      expect(isAppPermissionGranted(context, main, permission, appFrame)).toBe(false);
    },
  );

  it('refuses another web contents, a missing one and the main window away from the app', () => {
    expect(isAppPermissionGranted(context, contentsAt(APP_URL), 'fullscreen', appFrame)).toBe(false);
    expect(isAppPermissionGranted(context, null, 'fullscreen', appFrame)).toBe(false);
    const navigated = contentsAt(FOREIGN);
    expect(
      isAppPermissionGranted({ ...context, mainContents: () => navigated }, navigated, 'fullscreen', appFrame),
    ).toBe(false);
    expect(isAppPermissionGranted({ ...context, mainContents: () => null }, main, 'fullscreen', appFrame)).toBe(false);
  });

  it('refuses a sub frame and a frame that is not the app', () => {
    expect(isAppPermissionGranted(context, main, 'fullscreen', { isMainFrame: false, isApp: true })).toBe(false);
    expect(isAppPermissionGranted(context, main, 'fullscreen', { isMainFrame: true, isApp: false })).toBe(false);
  });

  it('answers a request only for the main frame showing the app', () => {
    expect(requested({ isMainFrame: true, requestingUrl: APP_URL })).toBe(true);
    expect(requested({ isMainFrame: true, requestingUrl: APP_URL }, 'media')).toBe(false);
    expect(requested({ isMainFrame: false, requestingUrl: APP_URL })).toBe(false);
    expect(requested({ isMainFrame: true, requestingUrl: FOREIGN })).toBe(false);
  });

  it('answers a check only for the main frame with the app origin and URL', () => {
    const { check } = installed();
    const permission = 'clipboard-sanitized-write';
    expect(check(main, permission, 'file:///', { isMainFrame: true, requestingUrl: APP_URL })).toBe(true);
    expect(check(main, permission, 'file:///', { isMainFrame: true })).toBe(true);
    expect(check(main, permission, 'file:///', { isMainFrame: false, requestingUrl: APP_URL })).toBe(false);
    expect(check(main, permission, 'https://example.com', { isMainFrame: true, requestingUrl: APP_URL })).toBe(false);
    expect(check(main, permission, 'file:///', { isMainFrame: true, requestingUrl: FOREIGN })).toBe(false);
    expect(check(null, permission, 'file:///', { isMainFrame: true, requestingUrl: APP_URL })).toBe(false);
  });

  it('matches app origins by scheme and host for files and by origin for the dev server', () => {
    expect(isAppOrigin('file://', APP_URL)).toBe(true);
    expect(isAppOrigin('file://server', APP_URL)).toBe(false);
    expect(isAppOrigin('null', APP_URL)).toBe(false);
    expect(isAppOrigin('http://localhost:5173', 'http://localhost:5173/')).toBe(true);
    expect(isAppOrigin('http://localhost:5174', 'http://localhost:5173/')).toBe(false);
  });
});
