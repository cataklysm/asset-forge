import { useRef, type KeyboardEvent, type RefObject } from 'react';
import type { AssetSummary } from '@assetforge/contracts';
import { columnsForWidth, rowCount, rowItems } from '../gallery';
import {
  useElementSize,
  useVirtualRows,
  type ViewPosition,
  type ViewRestore,
  type VirtualRows,
  type VisibleRows,
} from '../hooks/useVirtualRows';
import { label } from '../labels';
import { retryIndex, slotAt, type PagedState } from '../paged-list';
import { formatProgress } from '../progress';
import { BUTTON, FOCUS, ITEM_HOVER, MUTED, TILE_TITLE } from '../ui';
import { CoverImage } from './CoverImage';
import { TagList } from './TagList';

/** Props shared by the grid and the table view of the assets screen. */
export interface AssetViewProps {
  viewKey: string;
  paged: PagedState<AssetSummary>;
  total: number;
  restore: ViewRestore;
  typeName(id: string): string;
  selectedId: string | null;
  onSelect(index: number, asset: AssetSummary): void;
  onOpen(index: number, asset: AssetSummary, scrollOffset: number): void;
  onRows(rows: VisibleRows): void;
  onRetry(page: number): void;
  positionRef: { current: { viewKey: string; get(): ViewPosition } | null };
}

/** The names of the filter tags an asset matched on itself (`asset`) or on its files (`files`). */
export function matchedNames(asset: AssetSummary, where: 'asset' | 'files'): ReadonlySet<string> | undefined {
  if (asset.matchedTags === undefined) return undefined;
  return new Set(asset.matchedTags.filter((t) => (where === 'asset' ? t.onAsset : t.onFiles)).map((t) => t.name));
}

/**
 * Pointer and keyboard handling of one item of an asset view: a click selects, a double click
 * or Enter opens, focus selects (so arrow keys move focus and selection together).
 */
export function itemHandlers(
  props: Pick<AssetViewProps, 'onSelect' | 'onOpen'>,
  rows: VirtualRows,
  index: number,
  asset: AssetSummary | null,
) {
  return {
    onClick: () => {
      if (asset) props.onSelect(index, asset);
    },
    onDoubleClick: () => {
      if (asset) props.onOpen(index, asset, rows.scrollOffset());
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        if (asset) props.onOpen(index, asset, rows.scrollOffset());
        return;
      }
      rows.onItemKeyDown(index, event);
    },
    onFocus: () => {
      rows.onItemFocus(index);
      if (asset) props.onSelect(index, asset);
    },
  };
}

const TILE_WIDTH = 240;
const FRAME_HEIGHT = 180;
const BAND_HEIGHT = 32;
const GAP = 16;
// Frame (180) + padding 12 + name 24 + meta 20 + 8 + label 16 + 4 + chips 26 + padding 12 = 302.
const TILE_HEIGHT = 320;
const ROW_HEIGHT = TILE_HEIGHT + GAP;
// Room for the focus ring of the first row and column.
const EDGE = 4;

export function AssetGrid(props: AssetViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  const columns = size === null ? 1 : columnsForWidth(size.width - 2 * EDGE, TILE_WIDTH, GAP);
  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label="Assets"
      aria-rowcount={rowCount(props.total, columns)}
      className="min-h-0 flex-1 overflow-y-scroll"
    >
      {size !== null && size.height > 0 && (
        <GridRows {...props} scrollRef={scrollRef} columns={columns} height={size.height} />
      )}
    </div>
  );
}

function GridRows(
  props: AssetViewProps & { scrollRef: RefObject<HTMLDivElement | null>; columns: number; height: number },
) {
  const { viewKey, paged, total, restore, typeName, selectedId, onRows, onRetry, positionRef, scrollRef, columns, height } =
    props;
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
    <div role="presentation" className="relative w-full" style={{ height: virtualizer.getTotalSize() + EDGE }}>
      {items.map((row) => {
        const { start, end } = rowItems(row.index, columns, total);
        const indexes = Array.from({ length: end - start }, (_, i) => start + i);
        return (
          <div
            key={row.index}
            role="row"
            aria-rowindex={row.index + 1}
            className="absolute flex"
            style={{ top: row.start, left: EDGE, height: ROW_HEIGHT, gap: GAP }}
          >
            {indexes.map((index) => {
              const slot = slotAt(paged, index);
              if (slot.kind === 'failed' && index === retryIndex(slot.page, rows.firstVisibleIndex)) {
                return (
                  <div
                    key={index}
                    role="gridcell"
                    className="flex items-center justify-center"
                    style={{ width: TILE_WIDTH, height: TILE_HEIGHT }}
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
              const selected = asset !== null && asset.id === selectedId;
              return (
                <div
                  key={index}
                  role="gridcell"
                  data-index={index}
                  tabIndex={index === rows.tabbableIndex ? 0 : -1}
                  aria-selected={selected}
                  aria-disabled={asset === null ? true : undefined}
                  aria-busy={slot.kind === 'placeholder' ? true : undefined}
                  title={asset?.name}
                  className={`relative cursor-default overflow-hidden rounded-tile border-2 bg-surface ${
                    selected ? 'border-accent' : 'border-transparent'
                  } ${ITEM_HOVER} ${FOCUS}`}
                  style={{ width: TILE_WIDTH, height: TILE_HEIGHT }}
                  {...itemHandlers(props, rows, index, asset)}
                >
                  {asset === null ? (
                    <div className="animate-pulse bg-raised" style={{ height: FRAME_HEIGHT }} />
                  ) : (
                    <AssetTile asset={asset} typeName={typeName(asset.typeId)} />
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function AssetTile({ asset, typeName }: { asset: AssetSummary; typeName: string }) {
  return (
    <>
      <div className="relative" style={{ height: FRAME_HEIGHT }}>
        <CoverImage
          fileId={asset.coverFileId}
          size="thumb"
          fallback={typeName}
          className="h-full w-full"
        />
        {asset.coverTags.length > 0 && (
          <div
            className="absolute inset-x-0 bottom-0 flex items-center bg-surface/85 px-2"
            style={{ height: BAND_HEIGHT }}
          >
            <TagList tags={asset.coverTags} kind="file" max={3} matched={matchedNames(asset, 'files')} />
          </div>
        )}
      </div>
      <div className="px-3 py-3">
        <p className={`leading-6 ${TILE_TITLE}`}>{asset.name}</p>
        <p className={`flex justify-between gap-2 text-sm leading-5 ${MUTED}`}>
          <span className="flex min-w-0 gap-3 overflow-hidden whitespace-nowrap">
            <span className="truncate">
              Type <span className="text-text">{typeName}</span>
            </span>
            <span className="truncate">
              Status <span className="text-text">{label(asset.status)}</span>
            </span>
          </span>
          <span className="shrink-0 tabular-nums" title="Workflow progress">
            {formatProgress(asset.workflowProgress)}
          </span>
        </p>
        {asset.tags.length > 0 && (
          <>
            <p className={`mt-2 text-xs leading-4 ${MUTED}`}>Asset tags</p>
            <div className="mt-1">
              <TagList tags={asset.tags} kind="asset" max={3} matched={matchedNames(asset, 'asset')} />
            </div>
          </>
        )}
      </div>
    </>
  );
}
