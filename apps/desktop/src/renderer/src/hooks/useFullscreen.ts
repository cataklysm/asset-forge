import { useEffect, useState, type RefObject } from 'react';

// Fullscreen of one element; the state follows the browser's event.

/** The fullscreen state of an element and its toggle. */
export interface Fullscreen {
  /** Whether the element is shown fullscreen. */
  active: boolean;
  /** Leaves fullscreen when something is fullscreen, else asks for it. */
  toggle(): void;
}

/** Leaves fullscreen; a refusal is ignored. */
export function exitFullscreen(): void {
  Promise.resolve(document.exitFullscreen?.()).catch(() => {});
}

/**
 * Leaves fullscreen when something is fullscreen, else asks for it on the element.
 *
 * @param box the element to show fullscreen
 */
function toggleFullscreen(box: RefObject<HTMLElement | null>): void {
  if (document.fullscreenElement) {
    exitFullscreen();
    return;
  }
  try {
    Promise.resolve(box.current?.requestFullscreen?.()).catch(() => {});
  } catch {
    // Fullscreen is refused; the button stays unpressed.
  }
}

/**
 * The fullscreen state of an element.
 *
 * @param box the element to show fullscreen
 * @returns whether it is fullscreen and the toggle
 */
export function useFullscreen(box: RefObject<HTMLElement | null>): Fullscreen {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const sync = () => setActive(document.fullscreenElement === box.current && box.current !== null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  return { active, toggle: () => toggleFullscreen(box) };
}
