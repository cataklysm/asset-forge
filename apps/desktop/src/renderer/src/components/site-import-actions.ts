import type { RefObject } from 'react';
import type { FileTarget } from '@assetforge/contracts';
import { call, messageOf } from '../api';

/** Only short IPC actions lock the form, independently of running extraction jobs. */
export type SiteImportBusy = 'save' | 'delete' | 'queue' | 'import' | 'cancel' | 'retry' | 'login' | null;

/** Mounted request owner; a completed request never updates a disposed dialog. */
export interface SiteActionOwner {
  acting: RefObject<boolean>;
  disposed: RefObject<boolean>;
  setBusy(value: SiteImportBusy): void;
  setError(value: string | null): void;
}

/**
 * Guards a short request, reporting only its public error while the owning view remains mounted.
 *
 * @param owner the request lock and mounted state
 * @param kind the short action
 * @param action the action to run
 * @returns resolves after the action and state cleanup
 */
export async function runSiteAction(
  owner: SiteActionOwner,
  kind: Exclude<SiteImportBusy, null>,
  action: () => Promise<void>,
): Promise<void> {
  if (owner.acting.current) return;
  owner.acting.current = true;
  owner.setBusy(kind);
  owner.setError(null);
  try {
    await action();
  } catch (caught) {
    if (!owner.disposed.current) owner.setError(messageOf(caught));
  } finally {
    owner.acting.current = false;
    if (!owner.disposed.current) owner.setBusy(null);
  }
}

/** A queued batch's final task and only the URLs that still need to be submitted. */
export interface EnqueuedSiteCrawls {
  lastId: string | null;
  failed: string[];
  error: string | null;
}

/**
 * Enqueues independently reviewable galleries with one captured destination. No extraction is awaited.
 *
 * @param profileId the saved profile
 * @param urls the unique gallery addresses
 * @param target the destination captured when Queue was pressed
 * @returns submission failures and the last successful task
 */
export async function enqueueSiteCrawls(
  profileId: string,
  urls: readonly string[],
  target: FileTarget | null,
): Promise<EnqueuedSiteCrawls> {
  const result: EnqueuedSiteCrawls = { lastId: null, failed: [], error: null };
  for (const url of urls) {
    try {
      const answer = await call('sites:enqueueCrawl', { profileId, url, target });
      result.lastId = answer.crawlId;
    } catch (caught) {
      result.failed.push(url);
      result.error = messageOf(caught);
    }
  }
  return result;
}
