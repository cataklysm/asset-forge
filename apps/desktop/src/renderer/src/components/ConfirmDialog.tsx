import { useRef } from 'react';
import { CANCEL_LABEL } from '../labels';
import { BUTTON } from '../ui';
import { Dialog } from './Dialog';

interface Props {
  open: boolean;
  /** The question, and the only text of the dialog (e.g. "Delete 2 files permanently?"). */
  title: string;
  confirmLabel: string;
  /** While the confirmed action runs: both buttons are disabled. */
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** Asks before an irreversible action. Cancel has the initial focus; Esc cancels, except while busy. */
export function ConfirmDialog({ open, title, confirmLabel, busy, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} title={title} onClose={() => !busy && onCancel()} initialFocusRef={cancelRef}>
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
