import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { nextFocusIndex, offsetShowingIndex, rowCount } from '../gallery';

/** Where a freshly mounted view starts: a saved offset, optionally adjusted so `index` is visible. */
export interface ViewRestore {
  scrollOffset: number;
  index: number | null;
  /** Focus the item at `index` once it is rendered (returning from its detail screen). */
  focus: boolean;
}

export interface ViewPosition {
  scrollOffset: number;
  firstIndex: number;
}

export interface VisibleRows {
  firstRow: number;
  lastRow: number;
  columns: number;
}

/** Content-box size of an element, measured before the first paint and kept current. */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((old) => (old && old.width === width && old.height === height ? old : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

interface Options {
  scrollRef: RefObject<HTMLDivElement | null>;
  total: number;
  columns: number;
  rowHeight: number;
  /** Space above the first row inside the scroll content (a sticky header, a focus-ring margin). */
  paddingStart: number;
  /** The part of the viewport rows can be seen in (without a sticky header). */
  viewportHeight: number;
  restore: ViewRestore;
  onRows(rows: VisibleRows): void;
  /** Identifies this mounted view, so a stale position is never mistaken for the current one. */
  viewKey: string;
  positionRef: { current: { viewKey: string; get(): ViewPosition } | null };
}

export interface VirtualRows {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** The one item that is reachable with Tab (roving tab index). */
  tabbableIndex: number;
  /** The first item of the topmost row in the viewport. */
  firstVisibleIndex: number;
  onItemKeyDown(index: number, event: KeyboardEvent): void;
  onItemFocus(index: number): void;
  /** Focuses the item once it is rendered again (its element may be replaced). */
  refocus(index: number): void;
  scrollOffset(): number;
}

/**
 * Row windowing over `total` items laid out in `columns`, with keyboard focus that follows
 * the arrow keys, Home and End even into rows that are not rendered yet.
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
  const pendingFocus = useRef<number | null>(restore.focus && restore.index !== null ? clampIndex(restore.index) : null);

  const scrollOffset = () => virtualizer.scrollOffset ?? initialOffset;
  const firstVisibleRow = () => Math.max(0, Math.floor(scrollOffset() / rowHeight));

  positionRef.current = {
    viewKey,
    get: () => ({ scrollOffset: scrollOffset(), firstIndex: clampIndex(firstVisibleRow() * columns) }),
  };

  const items = virtualizer.getVirtualItems();
  const firstRow = items[0]?.index ?? 0;
  const lastRow = items[items.length - 1]?.index ?? -1;
  const onRowsRef = useRef(onRows);
  onRowsRef.current = onRows;
  useEffect(() => {
    if (lastRow >= firstRow) onRowsRef.current({ firstRow, lastRow, columns });
  }, [firstRow, lastRow, columns]);

  // Moves focus to a pending item as soon as its element exists.
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    const element = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!element) return;
    pendingFocus.current = null;
    element.focus({ preventScroll: true });
  });

  const activeRow = Math.floor(activeIndex / columns);
  const activeRendered = items.some((item) => item.index === activeRow);
  const tabbableIndex = activeRendered ? activeIndex : clampIndex(firstVisibleRow() * columns);

  function onItemKeyDown(index: number, event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = nextFocusIndex(index, event.key, columns, total);
    if (target === null) return;
    event.preventDefault();
    setActiveIndex(target);
    pendingFocus.current = target;
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
      pendingFocus.current = index;
    },
    scrollOffset,
  };
}
