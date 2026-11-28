import { describe, expect, it } from 'vitest';
import {
  isAppPermissionGranted,
  restrictAppPermissions,
  type AppPermissionContext,
  type PermissionContents,
  type PermissionSession,
} from '../src/main/app-permissions.js';

const APP_URL = 'file:///C:/app/index.html';

/** A web contents showing a URL. */
function contentsAt(url: string): PermissionContents {
  return { getURL: () => url };
}

const main = contentsAt(APP_URL);
const context: AppPermissionContext = { mainContents: () => main, isAppUrl: (url) => url === APP_URL };

describe('app permissions', () => {
  it.each(['fullscreen', 'clipboard-sanitized-write'])('grants %s to the main window showing the app', (permission) => {
    expect(isAppPermissionGranted(context, main, permission)).toBe(true);
  });

  it.each(['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'unknown'])(
    'refuses %s',
    (permission) => {
      expect(isAppPermissionGranted(context, main, permission)).toBe(false);
    },
  );

  it('refuses another web contents, a missing one and the main window away from the app', () => {
    expect(isAppPermissionGranted(context, contentsAt(APP_URL), 'fullscreen')).toBe(false);
    expect(isAppPermissionGranted(context, null, 'fullscreen')).toBe(false);
    const navigated = contentsAt('https://example.com/');
    expect(isAppPermissionGranted({ ...context, mainContents: () => navigated }, navigated, 'fullscreen')).toBe(false);
    expect(isAppPermissionGranted({ ...context, mainContents: () => null }, main, 'fullscreen')).toBe(false);
  });

  it('installs the same rule for requests and checks', () => {
    const installed: {
      request?: Parameters<PermissionSession['setPermissionRequestHandler']>[0];
      check?: Parameters<PermissionSession['setPermissionCheckHandler']>[0];
    } = {};
    restrictAppPermissions(
      {
        setPermissionRequestHandler: (handler) => (installed.request = handler),
        setPermissionCheckHandler: (handler) => (installed.check = handler),
      },
      context,
    );
    const answers: boolean[] = [];
    installed.request?.(main, 'fullscreen', (isGranted) => answers.push(isGranted));
    installed.request?.(main, 'media', (isGranted) => answers.push(isGranted));
    expect(answers).toEqual([true, false]);
    expect(installed.check?.(main, 'clipboard-sanitized-write')).toBe(true);
    expect(installed.check?.(null, 'clipboard-sanitized-write')).toBe(false);
  });
});
