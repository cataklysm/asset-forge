import { useEffect, useRef, type RefObject } from 'react';

/** The dialogs being closed and shown again by {@link reshowOnTop}; their close events are not a close. */
const RESHOWING = new WeakSet<HTMLDialogElement>();

/**
 * Whether the dialog is only being shown again on top, so its close event does not close it.
 *
 * @param dialog the dialog element
 * @returns whether a re-show is under way
 */
export function isReshowing(dialog: HTMLDialogElement | null): boolean {
  return dialog !== null && RESHOWING.has(dialog);
}

/**
 * Brings an open modal dialog to the top of the top layer without unmounting it: it and the open
 * dialogs inside it are closed (innermost first) and shown again (outermost first). Focus stays where
 * it was inside the dialog, else it goes to the initial focus. Focus that was on an element outside
 * becomes the opener, so that closing the dialog later returns there (the dialog below).
 *
 * @param dialog the open dialog
 * @param opener the opener ref of the dialog
 * @param initialFocusRef focused when focus was not inside the dialog
 */
function reshowOnTop(
  dialog: HTMLDialogElement,
  opener: { current: HTMLElement | null },
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const inside = active !== null && dialog.contains(active);
  if (!inside && active !== null && active !== document.body) opener.current = active;
  const shown = [dialog, ...dialog.querySelectorAll('dialog')].filter((element) => element.open);
  for (const element of shown) RESHOWING.add(element);
  try {
    for (const element of [...shown].reverse()) element.close();
    for (const element of shown) element.showModal();
  } finally {
    // The browser fires the close events later; they still find the dialogs open again.
    for (const element of shown) RESHOWING.delete(element);
  }
  if (inside && active.isConnected) active.focus();
  else initialFocusRef?.current?.focus();
}

/**
 * Shows the open dialog on top again whenever `raise` changes; the value it was mounted with raises nothing.
 *
 * @param ref the dialog element
 * @param opener the opener ref of the dialog
 * @param raise the raise counter
 * @param initialFocusRef focused when focus was not inside the dialog
 */
function useRaise(
  ref: RefObject<HTMLDialogElement | null>,
  opener: { current: HTMLElement | null },
  raise: number,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  const shownRaise = useRef(raise);
  useEffect(() => {
    if (shownRaise.current === raise) return;
    shownRaise.current = raise;
    const dialog = ref.current;
    if (dialog?.open === true) reshowOnTop(dialog, opener, initialFocusRef);
    // Only a change of the counter raises the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raise]);
}

/**
 * Opens and closes a native `<dialog>` as a modal with `open`, and returns the focus to where it was
 * before opening, also when the dialog is unmounted while open. A change of `raise` while open
 * brings the mounted dialog to the top again, with the dialogs open inside it.
 *
 * @param ref the dialog element
 * @param open whether the dialog is shown
 * @param initialFocusRef focused when the dialog opens; read when it opens only
 * @param raise a counter; every change while open shows the dialog on top again
 */
export function useModalDialog(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>,
  raise = 0,
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

  useRaise(ref, opener, raise, initialFocusRef);

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
