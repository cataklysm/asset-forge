import { useCallback, useRef, useState } from 'react';

/** One of the two stacked studio dialogs. */
export type StackedDialog = 'studio' | 'linked';

/** What `useDialogStack` offers. */
export interface DialogStack {
  /** The key part of the studio; rises when the studio is raised over the linked file dialog. */
  studioKey: number;
  /** The key part of the linked file dialog; rises when it is raised over the studio. */
  linkedKey: number;
  /** Puts `which` on top, mounting it anew when the other one is on top. */
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
 * stays open, so the one requested while the other is on top is mounted anew (a new key), which
 * shows it again above the other. The studio's form and starts in flight outlive that remount
 * (`StudioSession`).
 *
 * @returns the keys and the stack operations
 */
export function useDialogStack(): DialogStack {
  const top = useRef<StackedDialog | null>(null);
  const [studioKey, setStudioKey] = useState(0);
  const [linkedKey, setLinkedKey] = useState(0);
  const raise = useCallback((which: StackedDialog) => {
    if (top.current !== null && top.current !== which) (which === 'studio' ? setStudioKey : setLinkedKey)((key) => key + 1);
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
  return { studioKey, linkedKey, raise, lower, clear };
}
