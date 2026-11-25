import type { ReactNode } from 'react';
import { BUTTON } from '../ui';

interface Props {
  count: number;
  onClear(): void;
  /** The actions for the selection. */
  children: ReactNode;
}

/** "n selected", the selection's actions and "Clear selection"; nothing without a selection. */
export function SelectionBar({ count, onClear, children }: Props) {
  if (count < 1) return null;
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-3">
      <span className="text-sm tabular-nums text-text">{count} selected</span>
      {children}
      <button type="button" className={BUTTON} onClick={onClear}>
        Clear selection
      </button>
    </div>
  );
}
