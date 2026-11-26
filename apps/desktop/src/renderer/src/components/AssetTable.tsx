import { useRef, type RefObject } from 'react';
import { formatDateTime } from '../format';
import { rowCount } from '../gallery';
import { useElementSize, useVirtualRows } from '../hooks/useVirtualRows';
import { label } from '../labels';
import { retryIndex, slotAt } from '../paged-list';
import { formatProgress } from '../progress';
import { BORDER, BUTTON_INLINE, ITEM_HOVER, MUTED } from '../ui';
import { itemHandlers, matchedNames, type AssetViewProps } from './AssetGrid';
import { CoverImage } from './CoverImage';
import { TagList } from './TagList';

const HEADER_HEIGHT = 32;
const ROW_HEIGHT = 48;
const ROW_FOCUS = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
const COLUMNS =
  'grid grid-cols-[3rem_minmax(8rem,1.4fr)_8rem_7rem_4.5rem_minmax(6rem,1fr)_minmax(6rem,1fr)_10rem] items-center gap-3 px-2';
const HEADERS = ['Name', 'Type', 'Status', 'Progress', 'Asset tags', 'Image tags', 'Last change'];

export function AssetTable(props: AssetViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label="Assets"
      aria-rowcount={rowCount(props.total, 1) + 1}
      className="min-h-0 flex-1 overflow-y-scroll"
    >
      {size !== null && size.height > 0 && <TableRows {...props} scrollRef={scrollRef} height={size.height} />}
    </div>
  );
}

function TableRows(props: AssetViewProps & { scrollRef: RefObject<HTMLDivElement | null>; height: number }) {
  const { viewKey, paged, total, restore, typeName, selectedId, onRows, onRetry, positionRef, scrollRef, height } = props;
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
    <div role="presentation" className="relative w-full text-sm" style={{ height: virtualizer.getTotalSize() }}>
      <div
        role="row"
        aria-rowindex={1}
        className={`sticky top-0 z-10 border-b bg-surface ${BORDER} ${MUTED} ${COLUMNS}`}
        style={{ height: HEADER_HEIGHT }}
      >
        <span role="columnheader" aria-label="Cover" />
        {HEADERS.map((header) => (
          <span key={header} role="columnheader" className="truncate">
            {header}
          </span>
        ))}
      </div>
      {items.map((row) => {
        const index = row.index;
        const slot = slotAt(paged, index);
        const style = { top: row.start, height: ROW_HEIGHT };
        if (slot.kind === 'failed' && index === retryIndex(slot.page, rows.firstVisibleIndex)) {
          return (
            <div
              key={index}
              role="row"
              aria-rowindex={index + 2}
              className={`absolute inset-x-0 flex items-center border-b px-2 ${BORDER}`}
              style={style}
            >
              <span role="gridcell">
                <button
                  type="button"
                  data-index={index}
                  className={BUTTON_INLINE}
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
              </span>
            </div>
          );
        }
        const asset = slot.kind === 'loaded' ? slot.item : null;
        const selected = asset !== null && asset.id === selectedId;
        return (
          <div
            key={index}
            role="row"
            aria-rowindex={index + 2}
            data-index={index}
            tabIndex={index === rows.tabbableIndex ? 0 : -1}
            aria-selected={selected}
            aria-disabled={asset === null ? true : undefined}
            aria-busy={slot.kind === 'placeholder' ? true : undefined}
            className={`absolute inset-x-0 cursor-default border-b ${BORDER} ${
              selected ? 'bg-accent-soft' : ITEM_HOVER
            } ${ROW_FOCUS} ${COLUMNS}`}
            style={style}
            {...itemHandlers(props, rows, index, asset)}
          >
            {asset !== null && (
              <>
                <span role="gridcell">
                  <CoverImage fileId={asset.coverFileId} size="thumb" fallback="" className="h-10 w-10" />
                </span>
                <span role="gridcell" className="truncate font-medium" title={asset.name}>
                  {asset.name}
                </span>
                <span role="gridcell" className="truncate">
                  {typeName(asset.typeId)}
                </span>
                <span role="gridcell" className="truncate">
                  {label(asset.status)}
                </span>
                <span role="gridcell" className="tabular-nums">
                  {formatProgress(asset.workflowProgress)}
                </span>
                <span role="gridcell" className="min-w-0">
                  <TagList tags={asset.tags} kind="asset" max={2} matched={matchedNames(asset, 'asset')} />
                </span>
                <span role="gridcell" className="min-w-0">
                  <TagList tags={asset.coverTags} kind="file" max={2} matched={matchedNames(asset, 'files')} />
                </span>
                <span role="gridcell" className="truncate">
                  {formatDateTime(asset.updatedAt)}
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
