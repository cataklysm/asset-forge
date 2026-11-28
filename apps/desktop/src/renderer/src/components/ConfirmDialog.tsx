import { useRef } from 'react';
import { CANCEL_LABEL } from '../labels';
import { BUTTON } from '../ui';
import { Dialog } from './Dialog';

/** The props of `ConfirmDialog`. */
interface Props {
  /** Whether the dialog is shown. */
  open: boolean;
  /** The question, and the only text of the dialog (e.g. "Delete 2 files permanently?"). */
  title: string;
  /** Optional explanation of exactly what confirmation changes. */
  description?: string;
  /** The label of the confirm button. */
  confirmLabel: string;
  /** While the confirmed action runs: both buttons are disabled. */
  busy: boolean;
  /** Called by the confirm button. */
  onConfirm(): void;
  /** Called by Cancel and Esc. */
  onCancel(): void;
}

/**
 * Asks before an irreversible action. Cancel has the initial focus; Esc cancels, except while busy.
 *
 * @param props the question, the confirm label, the busy flag and the two callbacks
 * @returns the dialog
 */
export function ConfirmDialog({ open, title, description, confirmLabel, busy, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} title={title} onClose={() => !busy && onCancel()} initialFocusRef={cancelRef}>
      {description !== undefined && <p className="mb-4 text-sm text-muted">{description}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button ref={cancelRef} type="button" className={BUTTON} disabled={busy} onClick={onCancel}>
          {CANCEL_LABEL}
        </button>
      </div>
    </Dialog>
  );
}
