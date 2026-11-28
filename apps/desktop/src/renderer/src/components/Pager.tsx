import { useEffect } from 'react';
import { clampOffset } from '../paging';
import { BUTTON } from '../ui';

/** The props of `Pager`. */
interface Props {
  /** The offset of the shown page. */
  offset: number;
  /** The page size. */
  limit: number;
  /** The number of rows over all pages. */
  total: number;
  /** Called with the offset to show. */
  onChange(offset: number): void;
}

/**
 * Previous and Next with the shown range; steps back by itself when the page lies past the end.
 *
 * @param props the offset, the page size, the total and the change callback
 * @returns the pagination
 */
export function Pager({ offset, limit, total, onChange }: Props) {
  // Rows may disappear (e.g. an assigned file); step back when the page is past the end.
  const clamped = clampOffset(offset, total, limit);
  useEffect(() => {
    if (clamped !== offset) onChange(clamped);
  }, [clamped, offset, onChange]);

  return (
    <nav className="flex items-center gap-3 text-sm" aria-label="Pagination">
      <button
        type="button"
        className={BUTTON}
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        Previous
      </button>
      <span>
        {total === 0 ? 0 : offset + 1}–{Math.min(offset + limit, total)} of {total}
      </span>
      <button
        type="button"
        className={BUTTON}
        disabled={offset + limit >= total}
        onClick={() => onChange(offset + limit)}
      >
        Next
      </button>
    </nav>
  );
}
