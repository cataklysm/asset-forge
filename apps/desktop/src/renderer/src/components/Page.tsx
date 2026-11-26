import type { ReactNode } from 'react';
import { BORDER, COUNT, PAGE_TITLE } from '../ui';

interface Props {
  title: ReactNode;
  count?: number | null;
  countTitle?: string;
  actions?: ReactNode;
  toolbar?: ReactNode;
  detail?: ReactNode;
  children: ReactNode;
}

/** One page: title row, optional toolbar, content and an optional detail column on the right. */
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
        <aside
          className={`w-[264px] shrink-0 overflow-auto border-l p-6 min-[1280px]:w-[300px] ${BORDER}`}
        >
          {detail}
        </aside>
      )}
    </div>
  );
}
