import { Search } from 'lucide-react';
import { useRef, type RefObject } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { columnsForWidth, rowItems } from '../gallery';
import { useElementSize, useVirtualRows } from '../hooks/useVirtualRows';
import { retryIndex, slotAt, type PagedState } from '../paged-list';
import { BUTTON, FOCUS, ICON_BUTTON, ITEM_HOVER, MUTED, TILE_TITLE } from '../ui';
import { FileFrame, fileItemHandlers, fileMeta, ITEM_CONTROL, SelectBox, type FileViewProps } from './FileTile';
import { Menu } from './Menu';
import { ProposalMarker } from './ProposalMarker';
import { TagList } from './TagList';

// The files as tiles in rows that fill the width, virtualised by row.

/** The width of a tile; also the skeleton's. */
export const TILE_WIDTH = 200;
const FRAME_HEIGHT = 150;
const GAP = 16;
/** The height of a tile; also the skeleton's. Frame (150) + padding 12 + name 24 + meta 20 + 8 + chips 26 + padding 12 = 252. */
export const TILE_HEIGHT = 260;
const ROW_HEIGHT = TILE_HEIGHT + GAP;
// Room for the focus ring of the first row and column.
const EDGE = 4;
// The "Cover" badge: chip geometry on an opaque background, readable over the thumbnail.
const BADGE =
  'inline-flex h-[26px] items-center rounded-control border border-line-strong bg-surface px-2.5 text-[13px] text-text';
// Shows the magnifier while the pointer is over the tile or focus is inside it.
const REVEAL = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100';

/**
 * The files as tiles. The rows mount once the scroll area has a size.
 *
 * @param props the shared view props
 * @returns the scrollable listbox
 */
export function FileGridView(props: FileViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  const columns = size === null ? 1 : columnsForWidth(size.width - 2 * EDGE, TILE_WIDTH, GAP);
  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label="Files"
      aria-multiselectable="true"
      className="min-h-0 flex-1 select-none overflow-y-scroll"
    >
      {size !== null && size.height > 0 && (
        <GridRows {...props} scrollRef={scrollRef} columns={columns} height={size.height} />
      )}
    </div>
  );
}

/** The props of the rendered rows: the view's props plus the scroll area, the columns and its height. */
type GridRowsProps = FileViewProps & { scrollRef: RefObject<HTMLDivElement | null>; columns: number; height: number };

/**
 * The rows of tiles in the viewport.
 *
 * @param props the view's props, the scroll area, the columns and the height
 * @returns the rows
 */
function GridRows(props: GridRowsProps) {
  const { viewKey, paged, total, restore, onRows, onRetry, positionRef, scrollRef, columns, height } = props;
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
        // No overflow clipping here or on the tiles: a tile's menu extends below its row.
        return (
          <div
            key={row.index}
            role="presentation"
            className="absolute flex"
            style={{ top: row.start, left: EDGE, height: ROW_HEIGHT, gap: GAP }}
          >
            {indexes.map((index) => (
              <GridItem key={index} {...props} rows={rows} index={index} paged={paged} onRetry={onRetry} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** The props of one tile: the view's props plus the row windowing and the list index. */
type GridItemProps = FileViewProps & {
  rows: ReturnType<typeof useVirtualRows>;
  index: number;
  paged: PagedState<FileRecord>;
};

/**
 * One tile: Retry for a failed page, a placeholder while unloaded, else the file with its picture, checkbox, menu,
 * magnifier, name, meta line and tags.
 *
 * @param props the view's props, the row windowing and the list index
 * @returns the tile
 */
function GridItem(props: GridItemProps) {
  const { rows, index, paged, total, showRole, showOrigin, coverFileId, selected, onRetry } = props;
  const slot = slotAt(paged, index);
  const tabbable = index === rows.tabbableIndex;
  if (slot.kind === 'failed' && index === retryIndex(slot.page, rows.firstVisibleIndex)) {
    return (
      <div
        role="presentation"
        className="flex items-center justify-center"
        style={{ width: TILE_WIDTH, height: TILE_HEIGHT }}
      >
        <button
          type="button"
          data-index={index}
          className={BUTTON}
          tabIndex={tabbable ? 0 : -1}
          onClick={() => {
            rows.refocus(index);
            onRetry(slot.page);
          }}
          onKeyDown={(event) => rows.onItemKeyDown(index, event)}
          onFocus={() => rows.onItemFocus(index)}
        >
          Retry
        </button>
      </div>
    );
  }
  const file = slot.kind === 'loaded' ? slot.item : null;
  const isSelected = file !== null && selected.has(file.id);
  const menuItems = file === null ? [] : props.menuItems(file);
  return (
    <div
      role="option"
      data-index={index}
      data-file-tile={file === null ? undefined : ''}
      data-file-id={file?.id}
      aria-setsize={total}
      aria-posinset={index + 1}
      tabIndex={tabbable ? 0 : -1}
      aria-selected={isSelected}
      aria-disabled={file === null ? true : undefined}
      aria-busy={slot.kind === 'placeholder' ? true : undefined}
      title={file?.originalName}
      className={`group relative cursor-default rounded-tile border-2 bg-surface ${
        isSelected ? 'border-accent' : 'border-transparent'
      } ${ITEM_HOVER} ${FOCUS}`}
      style={{ width: TILE_WIDTH, height: TILE_HEIGHT }}
      {...fileItemHandlers(props, rows, index, file)}
    >
      {file === null ? (
        <div className="animate-pulse rounded-t-tile bg-raised" style={{ height: FRAME_HEIGHT }} />
      ) : (
        <>
          <div className="overflow-hidden rounded-t-tile" style={{ height: FRAME_HEIGHT }}>
            <FileFrame file={file} className="h-full w-full" />
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: FRAME_HEIGHT }}>
            <span className="pointer-events-auto absolute left-2 top-2 flex rounded-control bg-surface/85 p-1">
              <SelectBox file={file} index={index} checked={isSelected} onToggle={props.onToggle} />
            </span>
            {menuItems.length > 0 && (
              <span {...ITEM_CONTROL} className="pointer-events-auto absolute right-2 top-2">
                <Menu label="File actions" items={menuItems} tabIndex={tabbable ? 0 : -1} />
              </span>
            )}
            <button
              {...ITEM_CONTROL}
              type="button"
              tabIndex={-1}
              aria-label="Details"
              title="Details"
              className={`pointer-events-auto absolute bottom-2 right-2 ${ICON_BUTTON} ${REVEAL}`}
              onClick={() => props.onOpen(file)}
            >
              <Search size={16} aria-hidden />
            </button>
            {file.id === coverFileId && (
              <span className={`absolute bottom-2 ${file.kind === 'video' ? 'left-10' : 'left-2'} ${BADGE}`}>
                Cover
              </span>
            )}
          </div>
          <div className="px-3 py-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className={`min-w-0 flex-1 leading-6 ${TILE_TITLE}`}>{file.originalName}</p>
              {file.hasProposal && <ProposalMarker />}
            </div>
            <p className={`truncate text-sm leading-5 ${MUTED}`}>{fileMeta(file, showRole, showOrigin)}</p>
            <div className="mt-2">
              <TagList tags={file.tags} kind="file" max={3} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
