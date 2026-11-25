import { Children, type ReactNode } from 'react';
import { BUTTON } from '../ui';

interface Props {
  /** One child per toolbar row; the count and "Clear filters" end the last row. */
  children: ReactNode;
  resultCount: string | null;
  onClear: (() => void) | null;
  countTitle?: string;
}

/** Filter rows of a list screen: 40 high, 12 apart, the result count right-aligned. */
export function FilterBar({ children, resultCount, onClear, countTitle }: Props) {
  const rows = Children.toArray(children);
  const trailing = (
    <div className="ml-auto flex items-center gap-3">
      {resultCount !== null && (
        <span className="text-sm tabular-nums text-muted" title={countTitle} aria-live="polite">
          {resultCount}
        </span>
      )}
      {onClear !== null && (
        <button type="button" className={BUTTON} onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      {(rows.length === 0 ? [null] : rows).map((row, index, all) => (
        <div key={index} className="flex min-h-10 flex-wrap items-center gap-3">
          {row}
          {index === all.length - 1 && trailing}
        </div>
      ))}
    </div>
  );
}
