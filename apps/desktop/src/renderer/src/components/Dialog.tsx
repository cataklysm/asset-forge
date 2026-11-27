import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { BORDER, SECTION_TITLE } from '../ui';

interface Props {
  open: boolean;
  /** The accessible name; the `form` dialog also shows it as its heading. */
  title: string;
  onClose(): void;
  /** Focused when the dialog opens; otherwise the browser focuses the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** `detail` renders its content edge to edge; the content brings its own header. */
  size?: 'form' | 'detail';
  children: ReactNode;
}

const SIZE = {
  form: 'w-[min(92vw,32rem)]',
  // The window size minus an even margin; the UA's max-width/max-height would cap it otherwise.
  detail: 'w-[calc(100vw-3rem)] h-[calc(100vh-3rem)] max-w-none max-h-none overflow-hidden',
} as const;

/** A modal native `<dialog>`. Esc calls `onClose`; when it closes, focus returns to where it was before opening. */
export function Dialog({ open, title, onClose, initialFocusRef, size = 'form', children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const opener = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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

  const detail = size === 'detail';
  return (
    <dialog
      ref={ref}
      aria-labelledby={detail ? undefined : titleId}
      aria-label={detail ? title : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onCloseRef.current();
      }}
      onClose={() => {
        // Closed by the browser (e.g. a `method="dialog"` form) while the caller still holds it open.
        if (openRef.current) onCloseRef.current();
      }}
      className={`m-auto rounded-dialog border bg-surface p-0 text-text backdrop:bg-bg/70 ${BORDER} ${SIZE[size]}`}
    >
      {open &&
        (detail ? (
          <div className="h-full">{children}</div>
        ) : (
          <div className="flex h-full flex-col gap-4 p-5">
            <h2 id={titleId} title={title} className={`${SECTION_TITLE} truncate`}>
              {title}
            </h2>
            <div className="min-h-0 flex-1">{children}</div>
          </div>
        ))}
    </dialog>
  );
}
