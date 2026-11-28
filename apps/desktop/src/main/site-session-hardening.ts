import type { Session } from 'electron';
import { pageResourceBlocked, requestDecision } from './site-request-filter.js';

/** The answer to `onBeforeRequest`: an empty object lets the request through. */
type FilterAnswer = { cancel?: boolean };

/** The fields of a filtered request the decision reads. */
interface FilteredRequest {
  url: string;
  resourceType: string;
  /** Absent for a request made with `net.request`. */
  webContentsId?: number;
}

/**
 * Hardens one session once: no permission, no download, only public http/https, and no image, media or font for a
 * page window (spec "Browser sessions"). The filter also sees the session downloads made with `net.request` on this
 * session (no `webContentsId`, so no page rule applies to them): their host is vetted here a second time.
 *
 * @param session the profile's session
 * @param vet answers whether a host may be reached
 * @param isPage whether a web contents id belongs to a page window
 */
export function harden(
  session: Session,
  vet: (host: string) => Promise<boolean>,
  isPage: (contentsId: number) => boolean,
): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', (event, item) => {
    event.preventDefault();
    item.cancel();
  });
  session.webRequest.onBeforeRequest((details, callback) => filterRequest(details, callback, vet, isPage));
}

/**
 * Decides one request of the session and answers it exactly once.
 *
 * @param details the request as Electron reports it
 * @param callback receives the answer
 * @param vet answers whether a host may be reached
 * @param isPage whether a web contents id belongs to a page window
 */
function filterRequest(
  details: FilteredRequest,
  callback: (answer: FilterAnswer) => void,
  vet: (host: string) => Promise<boolean>,
  isPage: (contentsId: number) => boolean,
): void {
  if (
    details.webContentsId !== undefined &&
    isPage(details.webContentsId) &&
    pageResourceBlocked(details.resourceType)
  ) {
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
    (isAllowed) => callback(isAllowed ? {} : { cancel: true }),
    () => callback({ cancel: true }),
  );
}
