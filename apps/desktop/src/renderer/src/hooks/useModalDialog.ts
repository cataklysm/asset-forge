import { useEffect, useRef, type RefObject } from 'react';

/**
 * Opens and closes a native `<dialog>` as a modal with `open`, and returns the focus to where it was
 * before opening, also when the dialog is unmounted while open.
 *
 * @param ref the dialog element
 * @param open whether the dialog is shown
 * @param initialFocusRef focused when the dialog opens; read when it opens only
 */
export function useModalDialog(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  const opener = useRef<HTMLElement | null>(null);

  function restoreFocus() {
    const element = opener.current;
    opener.current = null;
    if (element?.isConnected) element.focus();
  }

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open) {
      if (!dialog.open) {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.showModal();
      }
      initialFocusRef?.current?.focus();
    } else {
      if (dialog.open) dialog.close();
      restoreFocus();
    }
    // initialFocusRef is read when the dialog opens only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Unmounted while open: the element is gone and focus would fall back to the body. The
  // connectivity check skips StrictMode's simulated unmount, which leaves the element in place.
  // Focus that is still on an element elsewhere stays there: the dialog is then mounted anew from
  // another dialog, and the new one takes that element as its opener.
  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog === null || dialog.isConnected) return;
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected) restoreFocus();
      else opener.current = null;
    };
  }, []);
}
