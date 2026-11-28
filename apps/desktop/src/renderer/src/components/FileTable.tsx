import { useRef, type RefObject } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { showsProposal } from '../file-actions';
import { formatBytes, formatDateTime } from '../format';
import { rowCount } from '../gallery';
import { useElementSize, useVirtualRows, type VirtualRows } from '../hooks/useVirtualRows';
import { DELETED_LABEL, label, ORIGIN_LABEL, RETRY_LABEL } from '../labels';
import { formatLabel } from '../media-url';
import { retryIndex, slotAt } from '../paged-list';
import { BORDER, BUTTON_INLINE, ITEM_HOVER, MUTED } from '../ui';
import { fileItemHandlers, fileOrigin, ITEM_CONTROL, SelectBox, type FileViewProps } from './FileTile';
import { Menu } from './Menu';
import { ProposalMarker } from './ProposalMarker';
import { TagList } from './TagList';

// The files as a table, virtualised by row below a sticky header.

const HEADER_HEIGHT = 32;
const ROW_HEIGHT = 48;
const ROW_FOCUS = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
const COLUMNS_WITH_ROLE =
  'grid grid-cols-[2rem_minmax(10rem,1.6fr)_8rem_5rem_6rem_10rem_minmax(6rem,1fr)_2.5rem] items-center gap-3 px-2';
const COLUMNS_WITHOUT_ROLE =
  'grid grid-cols-[2rem_minmax(10rem,1.6fr)_5rem_6rem_10rem_minmax(6rem,1fr)_2.5rem] items-center gap-3 px-2';
const COLUMNS_WITH_ORIGIN =
  'grid grid-cols-[2rem_minmax(10rem,1.6fr)_5rem_6rem_10rem_10rem_minmax(6rem,1fr)_minmax(6rem,1fr)_2.5rem] items-center gap-3 px-2';

/**
 * The files as a table: Name, Role (asset files), Type, Size, Imported, Deleted and Origin (the trash) and Tags.
 *
 * @param props the shared view props
 * @returns the scrollable grid
 */
export function FileTable(props: FileViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label="Files"
      aria-multiselectable="true"
      aria-rowcount={rowCount(props.total, 1) + 1}
      className="min-h-0 flex-1 select-none overflow-y-scroll"
    >
      {size !== null && size.height > 0 && <TableRows {...props} scrollRef={scrollRef} height={size.height} />}
    </div>
  );
}

/**
 * The column classes for the shown columns.
 *
 * @param showRole whether the Role column is shown
 * @param showOrigin whether the Deleted and Origin columns are shown
 * @returns the grid classes
 */
function columnsOf(showRole: boolean, showOrigin: boolean): string {
  if (showOrigin) return COLUMNS_WITH_ORIGIN;
  return showRole ? COLUMNS_WITH_ROLE : COLUMNS_WITHOUT_ROLE;
}

/**
 * The header row and the rows in the viewport.
 *
 * @param props the view's props, the scroll area and its height
 * @returns the rows
 */
function TableRows(props: FileViewProps & { scrollRef: RefObject<HTMLDivElement | null>; height: number }) {
  const { viewKey, total, restore, showRole, showOrigin, onRows, positionRef, scrollRef, height } = props;
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
  const columns = columnsOf(showRole, showOrigin);
  const headers = [
    'Name',
    ...(showRole ? ['Role'] : []),
    'Type',
    'Size',
    'Imported',
    ...(showOrigin ? [DELETED_LABEL, ORIGIN_LABEL] : []),
    'Tags',
  ];

  return (
    <div role="presentation" className="relative w-full text-sm" style={{ height: virtualizer.getTotalSize() }}>
      <div
        role="row"
        aria-rowindex={1}
        className={`sticky top-0 z-10 border-b bg-surface ${BORDER} ${MUTED} ${columns}`}
        style={{ height: HEADER_HEIGHT }}
      >
        <span role="columnheader" aria-label="Selected" />
        {headers.map((header) => (
          <span key={header} role="columnheader" className="truncate">
            {header}
          </span>
        ))}
        <span role="columnheader" aria-label="Actions" />
      </div>
      {items.map((row) => (
        <TableRow key={row.index} {...props} rows={rows} index={row.index} top={row.start} columns={columns} />
      ))}
    </div>
  );
}

/** The props of one row: the view's props plus the row windowing, the list index, its top and the columns. */
type TableRowProps = FileViewProps & { rows: VirtualRows; index: number; top: number; columns: string };

/**
 * One row: Retry for a failed page, an empty row while unloaded, else the file's cells.
 *
 * @param props the view's props, the row windowing, the index, the top and the columns
 * @returns the row
 */
function TableRow(props: TableRowProps) {
  const { rows, index, top, columns, paged, selected, onRetry } = props;
  const slot = slotAt(paged, index);
  const style = { top, height: ROW_HEIGHT };
  if (slot.kind === 'failed' && index === retryIndex(slot.page, rows.firstVisibleIndex)) {
    return (
      <div
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
            onKeyDown={(event) => rows.onItemKeyDown(index, event)}
            onFocus={() => rows.onItemFocus(index)}
          >
            {RETRY_LABEL}
          </button>
        </span>
      </div>
    );
  }
  const file = slot.kind === 'loaded' ? slot.item : null;
  const isSelected = file !== null && selected.has(file.id);
  const tabbable = index === rows.tabbableIndex;
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      data-index={index}
      data-file-tile={file === null ? undefined : ''}
      data-file-id={file?.id}
      tabIndex={tabbable ? 0 : -1}
      aria-selected={isSelected}
      aria-disabled={file === null ? true : undefined}
      aria-busy={slot.kind === 'placeholder' ? true : undefined}
      title={file?.originalName}
      className={`absolute inset-x-0 cursor-default border-b ${BORDER} ${
        isSelected ? 'bg-accent-soft' : ITEM_HOVER
      } ${ROW_FOCUS} ${columns}`}
      style={style}
      {...fileItemHandlers(props, rows, index, file)}
    >
      {file !== null && <FileCells {...props} file={file} isSelected={isSelected} tabbable={tabbable} />}
    </div>
  );
}

/**
 * The cells of a loaded file's row.
 *
 * @param props the view's props, the file, whether it is selected and whether its row is the tab stop
 * @returns the cells
 */
function FileCells(props: FileViewProps & { file: FileRecord; index: number; isSelected: boolean; tabbable: boolean }) {
  const { file, index, isSelected, tabbable, showRole, showOrigin, coverFileId } = props;
  const menuItems = props.menuItems(file);
  return (
    <>
      <span role="gridcell" className="flex items-center">
        <SelectBox file={file} index={index} checked={isSelected} onToggle={props.onToggle} />
      </span>
      <span role="gridcell" className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium">{file.originalName}</span>
        {showsProposal(file) && <ProposalMarker />}
        {file.status !== 'complete' && (
          <span className={`shrink-0 ${file.status === 'failed' ? 'text-danger' : MUTED}`}>{label(file.status)}</span>
        )}
        {file.id === coverFileId && <span className={`shrink-0 ${MUTED}`}>Cover</span>}
      </span>
      {showRole && (
        <span role="gridcell" className="truncate">
          {file.role === null ? '–' : label(file.role)}
        </span>
      )}
      <span role="gridcell" className="truncate">
        {formatLabel(file.originalName)}
      </span>
      <span role="gridcell" className="truncate tabular-nums">
        {formatBytes(file.sizeBytes)}
      </span>
      <span role="gridcell" className="truncate">
        {formatDateTime(file.importedAt)}
      </span>
      {showOrigin && (
        <>
          <span role="gridcell" className="truncate">
            {file.deletedAt === null ? '–' : formatDateTime(file.deletedAt)}
          </span>
          <span role="gridcell" className="truncate">
            {fileOrigin(file)}
          </span>
        </>
      )}
      <span role="gridcell" className="min-w-0">
        <TagList tags={file.tags} kind="file" max={2} />
      </span>
      <span role="gridcell" {...ITEM_CONTROL}>
        {menuItems.length > 0 && <Menu label="File actions" items={menuItems} tabIndex={tabbable ? 0 : -1} />}
      </span>
    </>
  );
}
