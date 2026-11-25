import { useRef, type MouseEvent, type RefObject } from 'react';
import type { AssetSummary } from '@assetforge/contracts';
import { formatDateTime } from '../format';
import { useElementSize, useVirtualRows } from '../hooks/useVirtualRows';
import { label } from '../labels';
import { retryIndex, slotAt } from '../paged-list';
import { formatProgress } from '../progress';
import { BORDER, BUTTON, MUTED } from '../ui';
import { ITEM_HOVER, type AssetViewProps } from './AssetGrid';
import { CoverImage } from './CoverImage';

const HEADER_HEIGHT = 32;
const ROW_HEIGHT = 48;
const ROW_FOCUS = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500';
const COLUMNS = 'grid grid-cols-[3rem_minmax(0,1fr)_10rem_8rem_5rem_11rem] items-center gap-3 px-2';

export function AssetTable(props: AssetViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  return (
    <div ref={scrollRef} role="list" aria-label="Assets" className="min-h-0 flex-1 overflow-y-scroll">
      {size !== null && size.height > 0 && <TableRows {...props} scrollRef={scrollRef} height={size.height} />}
    </div>
  );
}

function TableRows({
  viewKey,
  paged,
  total,
  restore,
  typeName,
  onOpen,
  onRows,
  onRetry,
  positionRef,
  scrollRef,
  height,
}: AssetViewProps & { scrollRef: RefObject<HTMLDivElement | null>; height: number }) {
  const rows = useVirtualRows({
    scrollRef,
    total,
    columns: 1,
    rowHeight: ROW_HEIGHT,
    paddingStart: HEADER_HEIGHT,
    viewportHeight: height - HEADER_HEIGHT,
    restore,
    onRows,
    viewKey,
    positionRef,
  });
  const { virtualizer } = rows;
  const items = virtualizer.getVirtualItems();

  return (
    <div className="relative w-full text-sm" style={{ height: virtualizer.getTotalSize() }}>
      <div
        aria-hidden="true"
        className={`sticky top-0 z-10 border-b bg-white dark:bg-slate-950 ${BORDER} ${MUTED} ${COLUMNS}`}
        style={{ height: HEADER_HEIGHT }}
      >
        <span />
        <span>Name</span>
        <span>Type</span>
        <span>Status</span>
        <span>Progress</span>
        <span>Last change</span>
      </div>
      {items.map((row) => {
        const index = row.index;
        const slot = slotAt(paged, index);
        const style = { top: row.start, height: ROW_HEIGHT };
        if (slot.kind === 'failed' && index === retryIndex(slot.page, rows.firstVisibleIndex)) {
          return (
            <div
              key={index}
              role="listitem"
              className={`absolute inset-x-0 flex items-center border-b px-2 ${BORDER}`}
              style={style}
            >
              <button
                type="button"
                data-index={index}
                className={BUTTON}
                tabIndex={index === rows.tabbableIndex ? 0 : -1}
                onClick={() => {
                  rows.refocus(index);
                  onRetry(slot.page);
                }}
                onKeyDown={(e) => rows.onItemKeyDown(index, e)}
                onFocus={() => rows.onItemFocus(index)}
              >
                Retry
              </button>
            </div>
          );
        }
        const asset = slot.kind === 'loaded' ? slot.item : null;
        const open = (e: MouseEvent) => {
          e.preventDefault();
          if (asset) onOpen(index, asset, rows.scrollOffset());
        };
        return (
          <div key={index} role="listitem" className="absolute inset-x-0" style={style}>
            <a
              href="#"
              data-index={index}
              tabIndex={index === rows.tabbableIndex ? 0 : -1}
              aria-disabled={asset === null ? true : undefined}
              aria-busy={slot.kind === 'placeholder' ? true : undefined}
              className={`h-full border-b ${BORDER} ${ITEM_HOVER} ${ROW_FOCUS} ${COLUMNS}`}
              onClick={open}
              onKeyDown={(e) => rows.onItemKeyDown(index, e)}
              onFocus={() => rows.onItemFocus(index)}
            >
              {asset !== null && (
                <>
                  <span>
                    <CoverImage
                      fileId={asset.coverFileId}
                      size="thumb"
                      fallback=""
                      className="h-10 w-10"
                    />
                  </span>
                  <span className="truncate font-medium">{asset.name}</span>
                  <span className="truncate">{typeName(asset.typeId)}</span>
                  <span className="truncate">{label(asset.status)}</span>
                  <span>{formatProgress(asset.workflowProgress)}</span>
                  <span className="truncate">{formatDateTime(asset.updatedAt)}</span>
                </>
              )}
            </a>
          </div>
        );
      })}
    </div>
  );
}
