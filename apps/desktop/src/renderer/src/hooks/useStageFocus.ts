import { useLayoutEffect, useRef, type FocusEvent, type RefObject } from 'react';

// Keeps the focus on the viewer's stage while its content is replaced.

/** The stage area and its focus handlers. */
export interface StageFocus {
  /** The focusable stage area. */
  areaRef: RefObject<HTMLDivElement | null>;
  /** Remembers the focused element inside the area. */
  onFocus(event: FocusEvent<HTMLDivElement>): void;
  /** Forgets it when the focus leaves the area. */
  onBlur(event: FocusEvent<HTMLDivElement>): void;
}

/**
 * The stage's video or image region is replaced when the file changes. When it held the focus, the focus goes to the
 * stage area, so the viewer keys keep working; focus elsewhere is left alone.
 *
 * @returns the area's ref and its focus handlers
 */
export function useStageFocus(): StageFocus {
  const areaRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const last = lastFocus.current;
    const area = areaRef.current;
    if (last === null || area === null || last.isConnected) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    area.focus({ preventScroll: true });
  });
  return {
    areaRef,
    onFocus: (event) => {
      lastFocus.current = event.target;
    },
    onBlur: (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && !event.currentTarget.contains(next)) lastFocus.current = null;
    },
  };
}
