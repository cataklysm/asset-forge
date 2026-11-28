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

/** The part of the details of a permission request the rule reads. */
export interface PermissionRequestDetails {
  /** Whether the main frame asks. */
  isMainFrame: boolean;
  /** The URL of the frame that asks. */
  requestingUrl: string;
}

/** The part of the details of a permission check the rule reads. */
export interface PermissionCheckDetails {
  /** Whether the main frame checks. */
  isMainFrame: boolean;
  /** The last URL the checking frame loaded; absent when no document checks. */
  requestingUrl?: string;
}

/** The part of a session the rule is installed on. */
export interface PermissionSession {
  /**
   * Installs the handler that answers permission requests.
   *
   * @param handler answers one request through its callback
   */
  setPermissionRequestHandler(
    handler: (
      contents: PermissionContents,
      permission: string,
      callback: (isGranted: boolean) => void,
      details: PermissionRequestDetails,
    ) => void,
  ): void;
  /**
   * Installs the handler that answers permission checks.
   *
   * @param handler answers one check
   */
  setPermissionCheckHandler(
    handler: (
      contents: PermissionContents | null,
      permission: string,
      requestingOrigin: string,
      details: PermissionCheckDetails,
    ) => boolean,
  ): void;
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
  /**
   * @param origin an origin as a permission check names it
   * @returns whether it is the app's origin
   */
  isAppOrigin(origin: string): boolean;
  /** Whether the app page is a `file:` page, whose origin Electron may name as `'null'` or `''`. */
  isFilePage: boolean;
}

/** The origins Electron may name for a `file:` page, which has an opaque origin. */
const OPAQUE_ORIGINS: ReadonlySet<string> = new Set(['null', '']);

/** The frame that asks, as far as the rule needs it. */
export interface PermissionFrame {
  /** Whether it is the main frame. */
  isMainFrame: boolean;
  /** Whether its URL, or its origin for a check, is the app's. */
  isApp: boolean;
}

/**
 * Whether a permission is granted: only one the app page uses, only to the main frame of the main window, and only
 * while both the window and the asking frame show the app page.
 *
 * @param context the main window and the app URL rule
 * @param contents the web contents that asks, or null when Electron names none
 * @param permission the permission's name
 * @param frame the frame that asks
 * @returns true when it is granted
 */
export function isAppPermissionGranted(
  context: AppPermissionContext,
  contents: PermissionContents | null,
  permission: string,
  frame: PermissionFrame,
): boolean {
  if (!APP_PERMISSIONS.has(permission) || !frame.isMainFrame || !frame.isApp) return false;
  const main = context.mainContents();
  if (contents === null || main === null || contents !== main) return false;
  return context.isAppUrl(contents.getURL());
}

/**
 * The asking frame of a permission check. Its URL decides when Electron names one; otherwise its origin must be the
 * app's, where a `file:` app page also accepts the opaque origin `'null'` or `''`. The rule still requires the main
 * frame of the main window showing the app page, so an opaque origin alone never grants anything.
 *
 * @param context the app URL rules
 * @param requestingOrigin the origin Electron names
 * @param details the check's details
 * @returns the frame for the rule
 */
function checkingFrame(
  context: AppPermissionContext,
  requestingOrigin: string,
  details: PermissionCheckDetails,
): PermissionFrame {
  if (details.requestingUrl !== undefined) {
    return { isMainFrame: details.isMainFrame, isApp: context.isAppUrl(details.requestingUrl) };
  }
  const isOpaqueFileOrigin = context.isFilePage && OPAQUE_ORIGINS.has(requestingOrigin);
  return { isMainFrame: details.isMainFrame, isApp: isOpaqueFileOrigin || context.isAppOrigin(requestingOrigin) };
}

/**
 * Installs the rule on the session of the main window for requests and checks alike. It must be installed before the
 * main window opens, so no request is ever answered by Electron's default (grant everything).
 *
 * @param session the default session
 * @param context the main window and the app URL rules
 */
export function restrictAppPermissions(session: PermissionSession, context: AppPermissionContext): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(
      isAppPermissionGranted(context, contents, permission, {
        isMainFrame: details.isMainFrame,
        isApp: context.isAppUrl(details.requestingUrl),
      }),
    ),
  );
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    isAppPermissionGranted(context, contents, permission, checkingFrame(context, requestingOrigin, details)),
  );
}
