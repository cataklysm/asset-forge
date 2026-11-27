import { useEffect, useRef, type RefObject } from 'react';

export interface ViewerKeyActions {
  previous(): void;
  next(): void;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  actual(): void;
  rotate(): void;
  fullscreen(): void;
  /** Shift+arrows on a video: seconds back (negative) or forward. Without it Shift+arrows step like the plain arrows. */
  seek?(seconds: number): void;
  /** Space on a video: play or pause. Without it Space is left alone. */
  togglePlayback?(): void;
  /** Delete: removes the shown file. Without it Delete is left alone. A held key removes one file only. */
  remove?(): void;
}

type PlainAction = Exclude<keyof ViewerKeyActions, 'seek' | 'togglePlayback' | 'remove'>;

const KEYS: Record<string, PlainAction> = {
  ArrowLeft: 'previous',
  ArrowRight: 'next',
  '+': 'zoomIn',
  '=': 'zoomIn',
  '-': 'zoomOut',
  '0': 'fit',
  '1': 'actual',
  r: 'rotate',
  R: 'rotate',
  f: 'fullscreen',
  F: 'fullscreen',
};

const SEEK_SECONDS = 5;

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Space activates these itself; it toggles playback only elsewhere (the video, the stage). */
function isActivatable(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, a, summary, select, [role="button"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [role="tab"], [role="radio"]') !== null;
}

/** The action of a key, or null when the viewer leaves it alone. */
function actionOf(event: KeyboardEvent, actions: ViewerKeyActions): (() => void) | null {
  const seek = actions.seek;
  if (event.shiftKey && seek !== undefined && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const seconds = event.key === 'ArrowLeft' ? -SEEK_SECONDS : SEEK_SECONDS;
    return () => seek(seconds);
  }
  const toggle = actions.togglePlayback;
  if (event.key === ' ') return toggle !== undefined && !isActivatable(event.target) ? toggle : null;
  if (event.key === 'Delete') return actions.remove !== undefined && !event.shiftKey && !event.repeat ? actions.remove : null;
  const name = KEYS[event.key];
  return name === undefined ? null : () => actions[name]();
}

/** Viewer shortcuts on the dialog content; Esc is left to the dialog. */
export function useViewerKeys(root: RefObject<HTMLElement | null>, actions: ViewerKeyActions): void {
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented) return;
      const action = actionOf(event, latest.current);
      if (action === null) return;
      if (isTextTarget(event.target) || element.querySelector('[aria-expanded="true"]') !== null) return;
      // Also keeps a focused video element from handling the key a second time.
      event.preventDefault();
      action();
    };
    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [root]);
}
