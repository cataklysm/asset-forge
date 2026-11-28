import { BREADCRUMB_LABEL } from '../labels';
import { MUTED } from '../ui';
import { Link } from './Link';

// The breadcrumb of a detail screen: the link back to its list, then the name of the open item.

/** The props of `Breadcrumb`. */
interface Props {
  /** The text of the link back to the list. */
  listLabel: string;
  /** The name of the open item once loaded; null before. */
  current: string | null;
  /** Goes back to the list. */
  onList(): void;
  /** The link waits, for example while an import runs. */
  disabled?: boolean;
  /** The tooltip of the link. */
  title?: string;
}

/**
 * The breadcrumb back to a list, with the name of the open item.
 *
 * @param props the list link, the current name and the navigation back
 * @returns the breadcrumb navigation
 */
export function Breadcrumb({ listLabel, current, onList, disabled, title }: Props) {
  return (
    <nav aria-label={BREADCRUMB_LABEL} className={`text-sm ${MUTED}`}>
      <Link onFollow={onList} disabled={disabled} title={title}>
        {listLabel}
      </Link>
      {current !== null && (
        <>
          <span> / </span>
          <span className="text-text">{current}</span>
        </>
      )}
    </nav>
  );
}
