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
}

const KEYS: Record<string, keyof ViewerKeyActions> = {
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

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Viewer shortcuts on the dialog content; Esc is left to the dialog. */
export function useViewerKeys(root: RefObject<HTMLElement | null>, actions: ViewerKeyActions): void {
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const name = KEYS[event.key];
      if (name === undefined || event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented) return;
      if (isTextTarget(event.target) || element.querySelector('[aria-expanded="true"]') !== null) return;
      event.preventDefault();
      latest.current[name]();
    };
    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [root]);
}
