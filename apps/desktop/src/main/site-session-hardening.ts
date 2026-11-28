import type { Session } from 'electron';
import { pageResourceBlocked, requestDecision } from './site-request-filter.js';

/**
 * Hardens one session once: no permission, no download, only public http/https, and no image, media or font for a
 * page window (spec "Browser sessions"). The filter also sees the session downloads made with `net.request` on this
 * session (no `webContentsId`, so no page rule applies to them): their host is vetted here a second time.
 */
export function harden(session: Session, vet: (host: string) => Promise<boolean>, isPage: (contentsId: number) => boolean): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', (event, item) => {
    event.preventDefault();
    item.cancel();
  });
  session.webRequest.onBeforeRequest((details, callback) => {
    if (details.webContentsId !== undefined && isPage(details.webContentsId) && pageResourceBlocked(details.resourceType)) {
      callback({ cancel: true });
      return;
    }
    const decision = requestDecision(details.url, details.resourceType);
    if (decision === 'allow') {
      callback({});
      return;
    }
    if (decision === 'refuse') {
      callback({ cancel: true });
      return;
    }
    vet(decision.host).then(
      (allowed) => callback(allowed ? {} : { cancel: true }),
      () => callback({ cancel: true }),
    );
  });
}
