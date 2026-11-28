import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import type { BrowserLatest, TrackedFile, WantRange } from '../components/file-browser-state';
import { replacementOf } from '../components/file-browser-state';
import type { ViewerList } from '../components/FileBrowser';
import { findLoaded, slotAt, type PagedState } from '../paged-list';
import type { ViewHandle } from './useVirtualRows';

// How the file browser follows the host's file detail dialog: it tracks the viewed file by id, loads the pages the
// dialog browses, replaces a file that left the list and returns the focus to its tile once the dialog closed.

/** What the browser last asked the host to show, and from which file; never asked twice. */
type Asked = { from: string | null; to: string | null } | null;

/** The viewer state of the file browser, kept by `useViewerTracking`. */
export interface ViewerTracking {
  /**
   * The viewed file's last known index; kept while a reload has not yet loaded the page that holds it (and for the
   * focus return after the viewer closed).
   */
  tracked: MutableRefObject<TrackedFile | null>;
  /** The viewed file in the displayed list; null when it is not loaded. */
  found: { item: FileRecord; index: number } | null;
  /** The last known index of the viewed file; null while none is viewed or known. */
  knownIndex: number | null;
  /** The target of the latest `show` whose page is not loaded yet. */
  pendingShow: { index: number } | null;
  /** Sets or clears the pending `show`. */
  setPendingShow: Dispatch<SetStateAction<{ index: number } | null>>;
  /** The index range the film strip keeps loaded. */
  wantRange: WantRange | null;
  /** Sets or clears the film strip's range. */
  setWantRange: Dispatch<SetStateAction<WantRange | null>>;
  /** What the browser asked the host to show last. */
  asked: MutableRefObject<Asked>;
}

/**
 * Tracks the viewed file by id in the displayed list.
 *
 * @param state the displayed list
 * @param viewedId the file the host's dialog shows; null when it is closed
 * @returns the tracking state
 */
export function useViewerTracking(state: PagedState<FileRecord>, viewedId: string | null): ViewerTracking {
  const tracked = useRef<TrackedFile | null>(null);
  const found = findLoaded(state, viewedId);
  if (found !== null) tracked.current = { id: found.item.id, index: found.index };
  const knownIndex = viewedId !== null && tracked.current?.id === viewedId ? tracked.current.index : null;
  const [pendingShow, setPendingShow] = useState<{ index: number } | null>(null);
  const [wantRange, setWantRange] = useState<WantRange | null>(null);
  const asked = useRef<Asked>(null);
  return { tracked, found, knownIndex, pendingShow, setPendingShow, wantRange, setWantRange, asked };
}

/** What `useViewerSync` works with. */
export interface ViewerSyncOptions {
  /** The state of `useViewerTracking`. */
  tracking: ViewerTracking;
  /** The values of the latest render. */
  latest: MutableRefObject<BrowserLatest>;
  /** The handle of the mounted view. */
  position: MutableRefObject<ViewHandle | null>;
  /** The file the host's dialog shows; null when it is closed. */
  viewedId: string | null;
  /** The displayed list. */
  state: PagedState<FileRecord>;
  /** Whether a new key is still loading. */
  pending: boolean;
}

/**
 * Keeps the host's dialog and the displayed list in step: resolves a pending `show`, replaces a viewed file that
 * left the list, hands a fresh record of the viewed file to the dialog and reveals the file shown last once the
 * dialog closed.
 *
 * @param options the tracking state, the latest render and the displayed list
 * @returns the displayed list as the viewer sees it; null while no viewer is open or the position is unknown
 */
export function useViewerSync(options: ViewerSyncOptions): ViewerList | null {
  const { tracking, latest, position, viewedId, state, pending } = options;
  const { pendingShow, setPendingShow } = tracking;

  useEffect(() => {
    if (viewedId !== null) followViewedFile(tracking, latest, state, pending, viewedId);
    // `askViewer` reads the latest props itself.
  }, [state, pending, viewedId, pendingShow]);

  // A reload that brings a new record of the viewed file hands it to the viewer once, so the open
  // dialog shows the fresh data (e.g. tags added by an analysis job).
  const handed = useRef<FileRecord | null>(null);
  useEffect(() => {
    if (viewedId === null) {
      handed.current = null;
      return;
    }
    const record = findLoaded(state, viewedId)?.item ?? null;
    if (record === null) return;
    const previous = handed.current;
    handed.current = record;
    if (previous !== null && previous.id === record.id && previous !== record) latest.current.props.viewer?.onView(record);
  }, [state, viewedId]);

  // After the viewer closed, the tile of the file shown last comes into view and takes the focus.
  const lastViewed = useRef<string | null>(viewedId);
  useEffect(() => {
    const previous = lastViewed.current;
    lastViewed.current = viewedId;
    if (previous === null || viewedId !== null) return;
    setPendingShow(null);
    tracking.setWantRange(null);
    revealLastViewed(tracking, latest, position, previous);
  }, [viewedId]);

  return viewerListOf(tracking, latest, viewedId, state);
}

/**
 * A pending `show` resolves once its page is loaded (clamped to a shrunk list). Without one, a viewed file that left
 * the displayed list is replaced by the file now at its last index (see `replacementOf`), else the viewer closes.
 *
 * @param tracking the tracking state
 * @param latest the values of the latest render
 * @param state the displayed list
 * @param pending whether a new key is still loading
 * @param viewedId the viewed file
 */
function followViewedFile(
  tracking: ViewerTracking,
  latest: MutableRefObject<BrowserLatest>,
  state: PagedState<FileRecord>,
  pending: boolean,
  viewedId: string,
): void {
  const count = state.total;
  if (count === null) return;
  const { pendingShow, setPendingShow } = tracking;
  if (pendingShow !== null) {
    if (count === 0) {
      setPendingShow(null);
      askViewer(tracking, latest, null);
      return;
    }
    const slot = slotAt(state, Math.min(pendingShow.index, count - 1));
    if (slot.kind !== 'loaded') return;
    setPendingShow(null);
    if (slot.item.id !== viewedId) askViewer(tracking, latest, slot.item);
    return;
  }
  if (pending || findLoaded(state, viewedId) !== null) return;
  const last = tracking.tracked.current;
  if (last === null || last.id !== viewedId) return;
  const replacement = replacementOf(state, last);
  if (replacement === null) return;
  const next = replacement.file;
  const asked = tracking.asked.current;
  if (asked?.from === viewedId && asked.to === (next?.id ?? null)) return;
  askViewer(tracking, latest, next);
}

/**
 * Asks the host's dialog to show a file and remembers the request.
 *
 * @param tracking the tracking state
 * @param latest the values of the latest render
 * @param file the file to show; null closes the dialog
 */
function askViewer(tracking: ViewerTracking, latest: MutableRefObject<BrowserLatest>, file: FileRecord | null): void {
  const current = latest.current.props.viewer;
  if (current === undefined) return;
  tracking.asked.current = { from: current.fileId, to: file?.id ?? null };
  current.onView(file);
}

/**
 * Shows the file at an index: at once when its page is loaded, otherwise once it is (a pending `show`).
 *
 * @param tracking the tracking state
 * @param latest the values of the latest render
 * @param index the list index; clamped to 0 … total − 1
 */
function showIndex(tracking: ViewerTracking, latest: MutableRefObject<BrowserLatest>, index: number): void {
  const { state } = latest.current.paged;
  const count = state.total;
  if (count === null) return;
  if (count === 0) {
    tracking.setPendingShow(null);
    askViewer(tracking, latest, null);
    return;
  }
  const target = Math.min(Math.max(0, Math.trunc(index)), count - 1);
  const slot = slotAt(state, target);
  if (slot.kind !== 'loaded') {
    tracking.setPendingShow({ index: target });
    return;
  }
  tracking.setPendingShow(null);
  if (slot.item.id !== latest.current.props.viewer?.fileId) askViewer(tracking, latest, slot.item);
}

/**
 * Forgets the closed viewer and reveals the tile of the file it showed last.
 *
 * @param tracking the tracking state
 * @param latest the values of the latest render
 * @param position the handle of the mounted view
 * @param previous the file the viewer showed last
 */
function revealLastViewed(
  tracking: ViewerTracking,
  latest: MutableRefObject<BrowserLatest>,
  position: MutableRefObject<ViewHandle | null>,
  previous: string,
): void {
  tracking.asked.current = null;
  const last = tracking.tracked.current;
  tracking.tracked.current = null;
  const { paged: current, viewKey } = latest.current;
  const count = current.state.total;
  if (last === null || last.id !== previous || count === null || count === 0) return;
  const index = findLoaded(current.state, previous)?.index ?? Math.min(last.index, count - 1);
  if (position.current?.viewKey === viewKey) position.current.reveal(index);
}

/**
 * The displayed list as the viewer sees it.
 *
 * @param tracking the tracking state
 * @param latest the values of the latest render
 * @param viewedId the viewed file
 * @param state the displayed list
 * @returns the list, or null while no viewer is open or the position of the viewed file is unknown
 */
function viewerListOf(
  tracking: ViewerTracking,
  latest: MutableRefObject<BrowserLatest>,
  viewedId: string | null,
  state: PagedState<FileRecord>,
): ViewerList | null {
  const total = state.total;
  const { found, knownIndex, setWantRange } = tracking;
  const viewIndex =
    total === null || total === 0 ? null : (found?.index ?? (knownIndex === null ? null : Math.min(knownIndex, total - 1)));
  if (latest.current.props.viewer === undefined || viewedId === null || total === null || viewIndex === null) return null;
  return {
    total,
    index: viewIndex,
    slot: (index) => slotAt(state, index),
    show: (index) => showIndex(tracking, latest, index),
    want: (first, last) =>
      setWantRange((previous) =>
        previous !== null && previous.first === first && previous.last === last ? previous : { first, last },
      ),
  };
}
