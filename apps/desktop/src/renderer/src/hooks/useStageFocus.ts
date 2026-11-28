import { useLayoutEffect, useRef, type FocusEvent, type RefObject } from 'react';

// Keeps the focus inside a region of the viewer while its content is replaced: the stage, and the details column's
// role or assign control.

/** A region and its focus handlers. */
export interface KeptFocus<E extends HTMLElement> {
  /** The region. */
  areaRef: RefObject<E | null>;
  /** Remembers the focused element inside the region. */
  onFocus(event: FocusEvent<E>): void;
  /** Forgets it when the focus leaves the region. */
  onBlur(event: FocusEvent<E>): void;
}

/** The stage area and its focus handlers. */
export type StageFocus = KeptFocus<HTMLDivElement>;

/** The controls that can take the focus, in document order. */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

/**
 * When the element focused last inside the region was removed and the focus fell to the body, `target` names the
 * element that takes it; focus elsewhere is left alone. Checked after every render of the host.
 *
 * @param target the element that takes the focus, given the region; null leaves the focus where it is
 * @returns the region's ref and its focus handlers
 */
export function useKeptFocus<E extends HTMLElement>(target: (area: E) => HTMLElement | null): KeptFocus<E> {
  const areaRef = useRef<E>(null);
  const lastFocus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const last = lastFocus.current;
    const area = areaRef.current;
    if (last === null || area === null || last.isConnected) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    lastFocus.current = null;
    target(area)?.focus({ preventScroll: true });
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

/**
 * The stage's video or image region is replaced when the file changes. When it held the focus, the focus goes to the
 * stage area, so the viewer keys keep working.
 *
 * @returns the area's ref and its focus handlers
 */
export function useStageFocus(): StageFocus {
  return useKeptFocus<HTMLDivElement>((area) => area);
}

/**
 * The first enabled control inside a region, else the fallback.
 *
 * @param area the region
 * @param fallback the element that takes the focus when the region has no control
 * @returns the element to focus; null when there is none
 */
export function firstControlIn(area: HTMLElement, fallback: HTMLElement | null): HTMLElement | null {
  return area.querySelector<HTMLElement>(FOCUSABLE) ?? fallback;
}
