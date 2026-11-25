import { BUTTON } from '../ui';

interface Props {
  offset: number;
  limit: number;
  total: number;
  onChange(offset: number): void;
}

export function Pager({ offset, limit, total, onChange }: Props) {
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
