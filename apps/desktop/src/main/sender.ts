// Kept free of Electron imports so the sender check is unit-testable.

import type { IpcResult } from '@assetforge/contracts';

/** The part of a frame the check reads. */
export interface SenderFrame {
  /** The frame's URL. */
  readonly url: string;
}

/** The part of a web contents the check reads. */
export interface SenderWebContents {
  /** Its top frame. */
  readonly mainFrame: SenderFrame;
}

/** The part of a window the check reads. */
export interface SenderWindow {
  /** Its web contents. */
  readonly webContents: SenderWebContents;
}

/** The part of an IPC event the check reads. */
export interface SenderEvent {
  /** The web contents that sent it. */
  readonly sender: SenderWebContents;
  /** The frame that sent it; null when it is gone. */
  readonly senderFrame: SenderFrame | null;
}

/**
 * IPC is only served to the top frame of the main window while it shows the app itself:
 * a sub-frame or a page navigated elsewhere never gets access.
 *
 * @param event the IPC event
 * @param window the main window, or null
 * @param isAppUrl whether a URL is the app page
 * @returns true when the sender may be served
 */
export function isTrustedSender(
  event: SenderEvent,
  window: SenderWindow | null,
  isAppUrl: (url: string) => boolean,
): boolean {
  if (!window || event.sender !== window.webContents) return false;
  const frame = event.senderFrame;
  if (frame === null || frame !== window.webContents.mainFrame) return false;
  return isAppUrl(frame.url);
}

/**
 * Why an IPC request is refused before it reaches its handler. The sender is checked first, so an
 * untrusted sender learns nothing about the app's state, not even that it is quitting.
 *
 * @param event the IPC event
 * @param window the main window, or null
 * @param isAppUrl whether a URL is the app page
 * @param isShuttingDown whether quitting has begun
 * @returns the refusal for the renderer, or null when the request may be served
 */
export function ipcRefusal(
  event: SenderEvent,
  window: SenderWindow | null,
  isAppUrl: (url: string) => boolean,
  isShuttingDown: boolean,
): IpcResult<never> | null {
  if (!isTrustedSender(event, window, isAppUrl)) {
    return { ok: false, error: { code: 'forbidden_sender', message: 'IPC sender is not the main window' } };
  }
  if (isShuttingDown) {
    return { ok: false, error: { code: 'shutting_down', message: 'The application is shutting down' } };
  }
  return null;
}
