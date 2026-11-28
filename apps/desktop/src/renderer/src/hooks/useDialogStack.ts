import { useCallback, useRef, useState } from 'react';

/** One of the two stacked studio dialogs. */
export type StackedDialog = 'studio' | 'linked';

/** What `useDialogStack` offers. */
export interface DialogStack {
  /** The raise counter of the studio; rises when the studio is raised over the linked file dialog. */
  studioRaise: number;
  /** The raise counter of the linked file dialog; rises when it is raised over the studio. */
  linkedRaise: number;
  /** Puts `which` on top, raising it when the other one is on top. */
  raise(which: StackedDialog): void;
  /** Records that `which` closed; the other one, if still open, is now on top. */
  lower(which: StackedDialog, otherOpen: boolean): void;
  /** Records that neither dialog is open. */
  clear(): void;
}

/**
 * The other one of the two dialogs.
 *
 * @param which one dialog
 * @returns the other dialog
 */
const otherOf = (which: StackedDialog): StackedDialog => (which === 'studio' ? 'linked' : 'studio');

/**
 * Which of the two dialogs is on top. A native dialog keeps its place in the top layer while it
 * stays open, so the one requested while the other is on top gets a new raise counter, which makes
 * its `Dialog` show the mounted element again above the other (`useModalDialog`); nothing remounts.
 *
 * @returns the raise counters and the stack operations
 */
export function useDialogStack(): DialogStack {
  const top = useRef<StackedDialog | null>(null);
  const [studioRaise, setStudioRaise] = useState(0);
  const [linkedRaise, setLinkedRaise] = useState(0);
  const raise = useCallback((which: StackedDialog) => {
    if (top.current !== null && top.current !== which)
      (which === 'studio' ? setStudioRaise : setLinkedRaise)((count) => count + 1);
    top.current = which;
  }, []);
  // The one closed was on top; the other one, if still open, is now.
  const lower = (which: StackedDialog, otherOpen: boolean) => {
    if (top.current !== which) return;
    top.current = otherOpen ? otherOf(which) : null;
  };
  const clear = useCallback(() => {
    top.current = null;
  }, []);
  return { studioRaise, linkedRaise, raise, lower, clear };
}
