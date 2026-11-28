import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';

/** The fields both windows share (spec "Browser sessions"); no preload, the user agent untouched. */
export function windowOptions(session: Session, show: boolean, title: string): BrowserWindowConstructorOptions {
  return {
    show,
    title,
    width: 1100,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      spellcheck: false,
      // No alert, confirm or prompt can block a window, and no developer tools open on a site's page.
      disableDialogs: true,
      devTools: false,
      // The crawl polls a hidden window; it must not be throttled as a background tab.
      backgroundThrottling: show,
    },
  };
}

/** What both windows get once created: no menu, no sound, and a page cannot hold its unload with `beforeunload`. */
export function prepareWindow(window: BrowserWindow): void {
  window.removeMenu();
  const contents = window.webContents;
  contents.setAudioMuted(true);
  contents.on('will-prevent-unload', (event) => event.preventDefault());
}
