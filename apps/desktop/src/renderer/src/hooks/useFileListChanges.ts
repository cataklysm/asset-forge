import type { MutableRefObject } from 'react';
import { MAX_CHOSEN_IDS, type Changes, type FileScope } from '@assetforge/contracts';
import { call } from '../api';
import { addsTo, type BrowserLatest } from '../components/file-browser-state';
import { useChanges } from '../jobs-context';
import { loadedIds } from '../paged-list';

// Background changes reach the file browser's list in place: changed records are read again and patched, a file
// added to this list's place (or a reset) refreshes the loaded pages. The trash never reacts.

/**
 * Follows the change feed for the list of a file browser.
 *
 * @param scope the scope of the list
 * @param latest the values of the browser's latest render
 */
export function useFileListChanges(scope: FileScope, latest: MutableRefObject<BrowserLatest>): void {
  useChanges((changes) => followChanges(scope, latest, changes));
}

/**
 * Applies one read of the change feed to the list.
 *
 * @param scope the scope of the list
 * @param latest the values of the browser's latest render
 * @param changes what changed since the last read
 */
function followChanges(scope: FileScope, latest: MutableRefObject<BrowserLatest>, changes: Changes): void {
  if (scope.kind === 'trash') return;
  const { paged: current, key: startedKey, listRequest: request } = latest.current;
  if (changes.reset || changes.added.some((place) => addsTo(scope, place.assetId))) {
    current.refresh();
    return;
  }
  const ids = loadedIds(current.state, changes.fileIds);
  if (ids.length === 0) return;
  if (ids.length > MAX_CHOSEN_IDS) {
    current.refresh();
    return;
  }
  // No check beyond the key: a workspace read runs synchronously when the main process receives it, and IPC
  // answers arrive in the order asked, so a page requested after this read never answers before it.
  call('files:list', { ...request, ids, offset: 0, limit: ids.length }).then(
    (page) => {
      // Started for another list: its records must not reach this one. The current list may have been read
      // before the change, so it is read again (queued while its first page is still loading).
      if (latest.current.key !== startedKey) {
        refreshLatest(latest);
        return;
      }
      if (page.items.length > 0) latest.current.paged.patch(page.items);
    },
    // The change must not be lost: the loaded pages are read again instead.
    () => refreshLatest(latest),
  );
}

/**
 * Reads the loaded pages of the current list again; the trash never follows the feed.
 *
 * @param latest the values of the browser's latest render
 */
function refreshLatest(latest: MutableRefObject<BrowserLatest>): void {
  if (latest.current.props.scope.kind !== 'trash') latest.current.paged.refresh();
}
