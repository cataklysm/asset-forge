import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { useModalDialog } from '../hooks/useModalDialog';
import { BORDER, SECTION_TITLE } from '../ui';

/** The props of `Dialog`. */
interface Props {
  /** Whether the dialog is shown. */
  open: boolean;
  /** The accessible name; the `form` dialog also shows it as its heading. */
  title: string;
  /** Called on Esc and when the browser closes the dialog while it is held open. */
  onClose(): void;
  /** Focused when the dialog opens; otherwise the browser focuses the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** `detail` renders its content edge to edge; the content brings its own header. */
  size?: 'form' | 'wide' | 'detail';
  /** The content, rendered only while open. */
  children: ReactNode;
}

/** The width (and for `detail` the height) of each size. */
const SIZE = {
  form: 'w-[min(92vw,32rem)]',
  /** A form with two columns. */
  wide: 'w-[min(94vw,64rem)]',
  // The window size minus an even margin; the UA's max-width/max-height would cap it otherwise.
  detail: 'w-[calc(100vw-3rem)] h-[calc(100vh-3rem)] max-w-none max-h-none overflow-hidden',
} as const;

/**
 * The content of an open dialog: edge to edge for `detail`, otherwise under the title as heading.
 *
 * @param props the title, its id, whether the dialog is a detail dialog and the content
 * @returns the content
 */
function DialogBody({
  title,
  titleId,
  detail,
  children,
}: {
  title: string;
  titleId: string;
  detail: boolean;
  children: ReactNode;
}) {
  if (detail) return <div className="h-full">{children}</div>;
  return (
    <div className="flex h-full flex-col gap-4 p-5">
      <h2 id={titleId} title={title} className={`${SECTION_TITLE} truncate`}>
        {title}
      </h2>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * A modal native `<dialog>`. Esc calls `onClose`; when it closes, focus returns to where it was before opening.
 *
 * @param props the open flag, the title, the close callback, the initial focus, the size and the content
 * @returns the dialog element
 */
export function Dialog({ open, title, onClose, initialFocusRef, size = 'form', children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const openRef = useRef(open);
  openRef.current = open;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useModalDialog(ref, open, initialFocusRef);

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
      {open && (
        <DialogBody title={title} titleId={titleId} detail={detail}>
          {children}
        </DialogBody>
      )}
    </dialog>
  );
}
