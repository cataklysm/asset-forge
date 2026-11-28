import type { ReactNode } from 'react';
import { BORDER, COUNT, PAGE_TITLE } from '../ui';

/** The props of `Page`. */
interface Props {
  /** The page heading. */
  title: ReactNode;
  /** Shown beside the heading unless null or absent. */
  count?: number | null;
  /** The tooltip of the count. */
  countTitle?: string;
  /** The buttons at the end of the title row. */
  actions?: ReactNode;
  /** The rows between the title row and the content. */
  toolbar?: ReactNode;
  /** The detail column on the right; absent hides it. */
  detail?: ReactNode;
  /** The content. */
  children: ReactNode;
}

/**
 * One page: title row, optional toolbar, content and an optional detail column on the right.
 *
 * @param props the heading, the count, the actions, the toolbar, the detail column and the content
 * @returns the page
 */
export function Page({ title, count, countTitle, actions, toolbar, detail, children }: Props) {
  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className={`flex min-w-0 items-baseline gap-3 ${PAGE_TITLE}`}>
            <span className="truncate">{title}</span>
            {count !== undefined && count !== null && (
              <span className={COUNT} title={countTitle}>
                {count}
              </span>
            )}
          </h2>
          {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        {toolbar}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </section>
      {detail !== undefined && (
        <aside className={`w-[264px] shrink-0 overflow-auto border-l p-6 min-[1280px]:w-[300px] ${BORDER}`}>
          {detail}
        </aside>
      )}
    </div>
  );
}
