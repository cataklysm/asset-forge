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
import { label, RETRY_LABEL } from '../labels';
import { retryIndex, slotAt, type PagedState } from '../paged-list';
import { formatProgress } from '../progress';
import { BUTTON, FOCUS, ITEM_HOVER, MUTED, TILE_TITLE } from '../ui';
import { CoverImage } from './CoverImage';
import { TagList } from './TagList';

// The grid view of the asset gallery, and what it shares with the table view.

/** Props shared by the grid and the table view of the assets screen. */
export interface AssetViewProps {
  /** Identifies the mounted view (filters and view mode). */
  viewKey: string;
  /** The displayed list. */
  paged: PagedState<AssetSummary>;
  /** The number of assets. */
  total: number;
  /** Where the view starts. */
  restore: ViewRestore;
  /** The name of an asset type. */
  typeName(id: string): string;
  /** The selected asset; null for none. */
  selectedId: string | null;
  /** Selects an asset. */
  onSelect(index: number, asset: AssetSummary): void;
  /** Opens an asset's screen. */
  onOpen(index: number, asset: AssetSummary, scrollOffset: number): void;
  /** Receives the rendered rows. */
  onRows(rows: VisibleRows): void;
  /** Requests a failed page again. */
  onRetry(page: number): void;
  /** Receives the view's position source. */
  positionRef: { current: { viewKey: string; get(): ViewPosition } | null };
}

/**
 * The names of the filter tags an asset matched on itself (`asset`) or on its files (`files`).
 *
 * @param asset the asset
 * @param where on the asset or on its files
 * @returns the names; undefined without a tag filter
 */
export function matchedNames(asset: AssetSummary, where: 'asset' | 'files'): ReadonlySet<string> | undefined {
  if (asset.matchedTags === undefined) return undefined;
  return new Set(
    asset.matchedTags.filter((tag) => (where === 'asset' ? tag.onAsset : tag.onFiles)).map((tag) => tag.name),
  );
}

/**
 * Pointer and keyboard handling of one item of an asset view: a click selects, a double click
 * or Enter opens, focus selects (so arrow keys move focus and selection together).
 *
 * @param props the select and open actions
 * @param rows the view's rows
 * @param index the item's index
 * @param asset the item; null while it is not loaded
 * @returns the item's handlers
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

/** The tile width in pixels. */
const TILE_WIDTH = 240;
/** The height of the cover frame. */
const FRAME_HEIGHT = 180;
/** The height of the image tag band over the cover. */
const BAND_HEIGHT = 32;
/** The gap between tiles. */
const GAP = 16;
// Frame (180) + padding 12 + name 24 + meta 20 + 8 + label 16 + 4 + chips 26 + padding 12 = 302.
/** The tile height in pixels. */
const TILE_HEIGHT = 320;
/** The height of one grid row with its gap. */
const ROW_HEIGHT = TILE_HEIGHT + GAP;
// Room for the focus ring of the first row and column.
const EDGE = 4;

/**
 * The assets as tiles in as many columns as fit.
 *
 * @param props the list, the selection and the actions
 * @returns the grid
 */
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

/** The grid's props once its size is known. */
type GridRowsProps = AssetViewProps & { scrollRef: RefObject<HTMLDivElement | null>; columns: number; height: number };

/**
 * The rendered rows of the grid.
 *
 * @param props the view's props, the scrolling element, the columns and the viewport height
 * @returns the rows
 */
function GridRows(props: GridRowsProps) {
  const { viewKey, total, restore, onRows, positionRef, scrollRef, columns, height } = props;
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
            {indexes.map((index) => gridCell(props, rows, index))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One cell of the grid: the Retry button of a failed page, else the tile or its placeholder.
 *
 * @param props the grid's props
 * @param rows the grid's rows
 * @param index the item's index
 * @returns the cell
 */
function gridCell(props: GridRowsProps, rows: VirtualRows, index: number) {
  const { paged, typeName, selectedId, onRetry } = props;
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
          onKeyDown={(event) => rows.onItemKeyDown(index, event)}
          onFocus={() => rows.onItemFocus(index)}
        >
          {RETRY_LABEL}
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
}

/**
 * The content of a loaded tile: cover with image tags, name, type, status, progress and asset tags.
 *
 * @param props the asset and its type's name
 * @returns the tile's content
 */
function AssetTile({ asset, typeName }: { asset: AssetSummary; typeName: string }) {
  return (
    <>
      <div className="relative" style={{ height: FRAME_HEIGHT }}>
        <CoverImage fileId={asset.coverFileId} size="thumb" fallback={typeName} className="h-full w-full" />
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
