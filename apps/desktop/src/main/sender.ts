// Kept free of Electron imports so the sender check is unit-testable.

export interface SenderFrame {
  readonly url: string;
}

export interface SenderWebContents {
  readonly mainFrame: SenderFrame;
}

export interface SenderWindow {
  readonly webContents: SenderWebContents;
}

export interface SenderEvent {
  readonly sender: SenderWebContents;
  readonly senderFrame: SenderFrame | null;
}

/**
 * IPC is only served to the top frame of the main window while it shows the app itself:
 * a sub-frame or a page navigated elsewhere never gets access.
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
