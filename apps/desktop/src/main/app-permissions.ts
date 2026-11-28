// Kept free of Electron imports so the permission rule is unit-testable; index.ts hands in the default session.

/**
 * The permissions the app page uses: fullscreen of the image and video stage, and writing text to the clipboard
 * (copy buttons). Every other permission (camera, microphone, location, notifications, ...) is refused.
 */
export const APP_PERMISSIONS: ReadonlySet<string> = new Set(['fullscreen', 'clipboard-sanitized-write']);

/** The part of a web contents the rule reads. */
export interface PermissionContents {
  /** @returns the URL of its top frame */
  getURL(): string;
}

/** The part of a session the rule is installed on. */
export interface PermissionSession {
  /**
   * Installs the handler that answers permission requests.
   *
   * @param handler answers one request through its callback
   */
  setPermissionRequestHandler(
    handler: (contents: PermissionContents, permission: string, callback: (isGranted: boolean) => void) => void,
  ): void;
  /**
   * Installs the handler that answers permission checks.
   *
   * @param handler answers one check
   */
  setPermissionCheckHandler(handler: (contents: PermissionContents | null, permission: string) => boolean): void;
}

/** What the rule needs to know about the app. */
export interface AppPermissionContext {
  /** @returns the web contents of the main window, or null while there is none */
  mainContents(): PermissionContents | null;
  /**
   * @param url a page URL
   * @returns whether it is the app page
   */
  isAppUrl(url: string): boolean;
}

/**
 * Whether a permission is granted: only one the app page uses, only to the main window, and only while it shows the
 * app page.
 *
 * @param context the main window and the app URL rule
 * @param contents the web contents that asks, or null when Electron names none
 * @param permission the permission's name
 * @returns true when it is granted
 */
export function isAppPermissionGranted(
  context: AppPermissionContext,
  contents: PermissionContents | null,
  permission: string,
): boolean {
  if (!APP_PERMISSIONS.has(permission)) return false;
  const main = context.mainContents();
  if (contents === null || main === null || contents !== main) return false;
  return context.isAppUrl(contents.getURL());
}

/**
 * Installs the rule on the session of the main window for requests and checks alike.
 *
 * @param session the default session
 * @param context the main window and the app URL rule
 */
export function restrictAppPermissions(session: PermissionSession, context: AppPermissionContext): void {
  session.setPermissionRequestHandler((contents, permission, callback) =>
    callback(isAppPermissionGranted(context, contents, permission)),
  );
  session.setPermissionCheckHandler((contents, permission) => isAppPermissionGranted(context, contents, permission));
}
