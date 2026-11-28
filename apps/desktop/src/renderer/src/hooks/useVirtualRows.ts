import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { nextFocusIndex, offsetShowingIndex, rowCount } from '../gallery';
import { focusedItem, focusSuccessor, mayTakeFocus, type FocusedItem, type PendingFocus } from './item-focus';

// Row windowing for grids and tables, with a roving tab stop and keyboard focus that reaches rows not rendered yet.

/** Where a freshly mounted view starts: a saved offset, optionally adjusted so `index` is visible. */
export interface ViewRestore {
  /** The saved scroll offset in pixels. */
  scrollOffset: number;
  /** The item that must be visible; null for none. */
  index: number | null;
  /** Focus the item at `index` once it is rendered (returning from its detail screen). */
  focus: boolean;
  /**
   * The element that had the focus when the screen asked for `focus`; the item focus is dropped once the
   * user puts the focus anywhere else. Without it, the element focused when the view mounts counts.
   */
  focusFrom?: Element | null;
}

/** Where a mounted view is scrolled to. */
export interface ViewPosition {
  /** The scroll offset in pixels. */
  scrollOffset: number;
  /** The first item of the topmost visible row. */
  firstIndex: number;
}

/** What a mounted view offers its host through `positionRef`. */
export interface ViewHandle {
  /** The view the handle belongs to. */
  viewKey: string;
  /** The current position. */
  get(): ViewPosition;
  /** Scrolls the item's row into view and focuses the item, once it is rendered. */
  reveal(index: number): void;
}

/** The rendered rows. */
export interface VisibleRows {
  /** The first rendered row. */
  firstRow: number;
  /** The last rendered row. */
  lastRow: number;
  /** The items per row. */
  columns: number;
}

/**
 * Content-box size of an element, measured before the first paint and kept current.
 *
 * @param ref the element
 * @returns its size; null before the first measurement
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((previous) =>
        previous && previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * Applies the focus after a commit: a pending item focus once its element exists and the user has not put
 * the focus elsewhere meanwhile (then it is dropped), otherwise the focus of an item whose element was
 * replaced or became unfocusable in this commit.
 *
 * @param container the scrolling element of the rows; null when unmounted
 * @param pendingFocus the pending item focus; cleared once applied or dropped
 * @param focusedBefore the item that had the focus while the render was computed
 */
function applyFocus(
  container: HTMLElement | null,
  pendingFocus: { current: PendingFocus | null },
  focusedBefore: FocusedItem | null,
): void {
  if (container === null) return;
  const pending = pendingFocus.current;
  if (pending === null) {
    focusSuccessor(container, focusedBefore)?.focus({ preventScroll: true });
    return;
  }
  if (!mayTakeFocus(container, pending)) {
    pendingFocus.current = null;
    return;
  }
  const element = container.querySelector<HTMLElement>(`[data-index="${pending.index}"]`);
  if (!element) return;
  pendingFocus.current = null;
  element.focus({ preventScroll: true });
}

/** What `useVirtualRows` lays out. */
interface Options {
  /** The scrolling element. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The number of items. */
  total: number;
  /** The items per row. */
  columns: number;
  /** The height of one row in pixels. */
  rowHeight: number;
  /** Space above the first row inside the scroll content (a sticky header, a focus-ring margin). */
  paddingStart: number;
  /** The part of the viewport rows can be seen in (without a sticky header). */
  viewportHeight: number;
  /** Where the view starts; read on mount only. */
  restore: ViewRestore;
  /** Receives the rendered rows whenever they change. */
  onRows(rows: VisibleRows): void;
  /** Identifies this mounted view, so a stale position is never mistaken for the current one. */
  viewKey: string;
  /** Receives the handle; hosts that never reveal an item may keep it as a plain position source. */
  positionRef: { current: ViewHandle | null } | { current: Omit<ViewHandle, 'reveal'> | null };
}

/** What `useVirtualRows` answers. */
export interface VirtualRows {
  /** The row virtualizer. */
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** The one item that is reachable with Tab (roving tab index). */
  tabbableIndex: number;
  /** The first item of the topmost row in the viewport. */
  firstVisibleIndex: number;
  /** Moves the focus on the arrow keys, Home and End. */
  onItemKeyDown(index: number, event: KeyboardEvent): void;
  /** Makes a focused item the tab stop. */
  onItemFocus(index: number): void;
  /** Focuses the item once it is rendered again (its element may be replaced). */
  refocus(index: number): void;
  /** The current scroll offset in pixels. */
  scrollOffset(): number;
}

/**
 * Row windowing over `total` items laid out in `columns`, with keyboard focus that follows
 * the arrow keys, Home and End even into rows that are not rendered yet.
 *
 * @param options the scrolling element, the layout, the start and the handle
 * @returns the virtualizer, the tab stop and the keyboard handlers
 */
export function useVirtualRows({
  scrollRef,
  total,
  columns,
  rowHeight,
  paddingStart,
  viewportHeight,
  restore,
  onRows,
  viewKey,
  positionRef,
}: Options): VirtualRows {
  const [initialOffset] = useState(() =>
    restore.index === null
      ? restore.scrollOffset
      : offsetShowingIndex(restore.scrollOffset, restore.index, columns, rowHeight, viewportHeight),
  );
  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: rowCount(total, columns),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
    paddingStart,
    scrollPaddingStart: paddingStart,
    initialOffset,
  });

  const clampIndex = (index: number) => Math.min(Math.max(0, index), Math.max(0, total - 1));
  const [activeIndex, setActiveIndex] = useState(() => clampIndex(restore.index ?? 0));
  const [initialFocus] = useState<PendingFocus | null>(() =>
    restore.focus && restore.index !== null
      ? {
          index: clampIndex(restore.index),
          from: restore.focusFrom === undefined ? document.activeElement : restore.focusFrom,
        }
      : null,
  );
  const pendingFocus = useRef(initialFocus);
  // Read, not written, during the render: the commit after it hands a lost item focus on.
  const focusedBefore = focusedItem(scrollRef.current);

  const scrollOffset = () => virtualizer.scrollOffset ?? initialOffset;
  const firstVisibleRow = () => Math.max(0, Math.floor(scrollOffset() / rowHeight));

  positionRef.current = {
    viewKey,
    get: () => ({ scrollOffset: scrollOffset(), firstIndex: clampIndex(firstVisibleRow() * columns) }),
    reveal: (index) => {
      if (total === 0) return;
      moveFocus(clampIndex(index));
    },
  };

  const items = virtualizer.getVirtualItems();
  const firstRow = items[0]?.index ?? 0;
  const lastRow = items[items.length - 1]?.index ?? -1;
  const onRowsRef = useRef(onRows);
  onRowsRef.current = onRows;
  useEffect(() => {
    if (lastRow >= firstRow) onRowsRef.current({ firstRow, lastRow, columns });
  }, [firstRow, lastRow, columns]);

  // Moves focus to a pending item as soon as its element exists, or back to an item whose element changed.
  useEffect(() => applyFocus(scrollRef.current, pendingFocus, focusedBefore));

  const activeRow = Math.floor(activeIndex / columns);
  const activeRendered = items.some((item) => item.index === activeRow);
  // After the total shrinks the active item may no longer exist; a tab stop must remain.
  const tabbableIndex = activeRendered && activeIndex < total ? activeIndex : clampIndex(firstVisibleRow() * columns);

  /** Moves the focus for an unmodified navigation key. */
  function onItemKeyDown(index: number, event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = nextFocusIndex(index, event.key, columns, total);
    if (target === null) return;
    event.preventDefault();
    moveFocus(target);
  }

  /** Makes `target` the active item, scrolls its row into view and focuses it now or once rendered. */
  function moveFocus(target: number) {
    setActiveIndex(target);
    pendingFocus.current = { index: target, from: document.activeElement };
    virtualizer.scrollToIndex(Math.floor(target / columns), { align: 'auto' });
    const element = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${target}"]`);
    if (element) {
      pendingFocus.current = null;
      element.focus({ preventScroll: true });
    }
  }

  return {
    virtualizer,
    tabbableIndex,
    firstVisibleIndex: clampIndex(firstVisibleRow() * columns),
    onItemKeyDown,
    onItemFocus: setActiveIndex,
    refocus: (index: number) => {
      pendingFocus.current = { index, from: document.activeElement };
    },
    scrollOffset,
  };
}
