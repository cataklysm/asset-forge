import { useRef, type MouseEvent, type RefObject } from 'react';
import type { AssetSummary } from '@assetforge/contracts';
import { columnsForWidth, rowItems } from '../gallery';
import { useElementSize, useVirtualRows, type ViewPosition, type ViewRestore, type VisibleRows } from '../hooks/useVirtualRows';
import { label } from '../labels';
import { retryIndex, slotAt, type PagedState } from '../paged-list';
import { formatProgress } from '../progress';
import { BUTTON, FOCUS, MUTED } from '../ui';
import { CoverImage } from './CoverImage';

/** Props shared by the grid and the table view of the assets screen. */
export interface AssetViewProps {
  viewKey: string;
  paged: PagedState<AssetSummary>;
  total: number;
  restore: ViewRestore;
  typeName(id: string): string;
  onOpen(index: number, asset: AssetSummary, scrollOffset: number): void;
  onRows(rows: VisibleRows): void;
  onRetry(page: number): void;
  positionRef: { current: { viewKey: string; get(): ViewPosition } | null };
}

const TILE = 180;
const GAP = 16;
// Frame (TILE) + 8 margin + name (20) + type (16) + status/progress (16).
const TILE_HEIGHT = TILE + 60;
const ROW_HEIGHT = TILE_HEIGHT + GAP;
// Room for the focus ring of the first row and column.
const EDGE = 4;

export const ITEM_HOVER = 'hover:bg-slate-100 dark:hover:bg-slate-800';

export function AssetGrid(props: AssetViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  return (
    <div
      ref={scrollRef}
      role="list"
      aria-label="Assets"
      className="min-h-0 flex-1 overflow-y-scroll"
    >
      {size !== null && size.height > 0 && (
        <GridRows {...props} scrollRef={scrollRef} width={size.width} height={size.height} />
      )}
    </div>
  );
}

function GridRows({
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
  width,
  height,
}: AssetViewProps & { scrollRef: RefObject<HTMLDivElement | null>; width: number; height: number }) {
  const columns = columnsForWidth(width - 2 * EDGE, TILE, GAP);
  const rows = useVirtualRows({
    scrollRef,
    total,
    columns,
    rowHeight: ROW_HEIGHT,
    paddingStart: EDGE,
    viewportHeight: height,
    restore,
    onRows,
    viewKey,
    positionRef,
  });
  const { virtualizer } = rows;
  const items = virtualizer.getVirtualItems();

  return (
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() + EDGE }}>
      {items.map((row) => {
        const { start, end } = rowItems(row.index, columns, total);
        const indexes = Array.from({ length: end - start }, (_, i) => start + i);
        return (
          <div
            key={row.index}
            className="absolute flex"
            style={{ top: row.start, left: EDGE, height: ROW_HEIGHT, gap: GAP }}
          >
            {indexes.map((index) => {
              const slot = slotAt(paged, index);
              if (slot.kind === 'failed' && index === retryIndex(slot.page, rows.firstVisibleIndex)) {
                return (
                  <div
                    key={index}
                    role="listitem"
                    className="flex items-center justify-center"
                    style={{ width: TILE, height: TILE_HEIGHT }}
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
                <div key={index} role="listitem" style={{ width: TILE, height: TILE_HEIGHT }}>
                  <a
                    href="#"
                    data-index={index}
                    tabIndex={index === rows.tabbableIndex ? 0 : -1}
                    aria-disabled={asset === null ? true : undefined}
                    aria-busy={slot.kind === 'placeholder' ? true : undefined}
                    title={asset?.name}
                    className={`block h-full w-full rounded ${ITEM_HOVER} ${FOCUS}`}
                    onClick={open}
                    onKeyDown={(e) => rows.onItemKeyDown(index, e)}
                    onFocus={() => rows.onItemFocus(index)}
                  >
                    {asset === null ? (
                      <div className="rounded bg-slate-100 dark:bg-slate-800/60" style={{ width: TILE, height: TILE }} />
                    ) : (
                      <>
                        <CoverImage
                          fileId={asset.coverFileId}
                          size="thumb"
                          fallback={typeName(asset.typeId)}
                          className="h-[180px] w-[180px]"
                        />
                        <span className="mt-2 block truncate px-1 text-sm leading-5 font-medium">{asset.name}</span>
                        <span className={`block truncate px-1 text-xs leading-4 ${MUTED}`}>
                          {typeName(asset.typeId)}
                        </span>
                        <span className={`flex justify-between gap-2 px-1 text-xs leading-4 ${MUTED}`}>
                          <span className="truncate">{label(asset.status)}</span>
                          <span>{formatProgress(asset.workflowProgress)}</span>
                        </span>
                      </>
                    )}
                  </a>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
