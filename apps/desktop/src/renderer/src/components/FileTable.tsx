import { useRef, type RefObject } from 'react';
import { formatBytes, formatDateTime } from '../format';
import { rowCount } from '../gallery';
import { useElementSize, useVirtualRows } from '../hooks/useVirtualRows';
import { label } from '../labels';
import { formatLabel } from '../media-url';
import { retryIndex, slotAt } from '../paged-list';
import { BORDER, BUTTON_INLINE, ITEM_HOVER, MUTED } from '../ui';
import { fileItemHandlers, ITEM_CONTROL, SelectBox, type FileViewProps } from './FileTile';
import { Menu } from './Menu';
import { TagList } from './TagList';

const HEADER_HEIGHT = 32;
const ROW_HEIGHT = 48;
const ROW_FOCUS = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
const COLUMNS_WITH_ROLE =
  'grid grid-cols-[2rem_minmax(10rem,1.6fr)_8rem_5rem_6rem_10rem_minmax(6rem,1fr)_2.5rem] items-center gap-3 px-2';
const COLUMNS_WITHOUT_ROLE =
  'grid grid-cols-[2rem_minmax(10rem,1.6fr)_5rem_6rem_10rem_minmax(6rem,1fr)_2.5rem] items-center gap-3 px-2';

/** The files as a table: Name, Role (asset files), Type, Size, Imported and Tags. */
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

function TableRows(props: FileViewProps & { scrollRef: RefObject<HTMLDivElement | null>; height: number }) {
  const { viewKey, paged, total, restore, showRole, coverFileId, selected, onRows, onRetry, positionRef, scrollRef, height } =
    props;
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
  const columns = showRole ? COLUMNS_WITH_ROLE : COLUMNS_WITHOUT_ROLE;
  const headers = showRole
    ? ['Name', 'Role', 'Type', 'Size', 'Imported', 'Tags']
    : ['Name', 'Type', 'Size', 'Imported', 'Tags'];

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
        const file = slot.kind === 'loaded' ? slot.item : null;
        const isSelected = file !== null && selected.has(file.id);
        const tabbable = index === rows.tabbableIndex;
        const menuItems = file === null ? [] : props.menuItems(file);
        return (
          <div
            key={index}
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
            {file !== null && (
              <>
                <span role="gridcell" className="flex items-center">
                  <SelectBox file={file} index={index} checked={isSelected} onToggle={props.onToggle} />
                </span>
                <span role="gridcell" className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{file.originalName}</span>
                  {file.status !== 'complete' && (
                    <span className={`shrink-0 ${file.status === 'failed' ? 'text-danger' : MUTED}`}>
                      {label(file.status)}
                    </span>
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
                <span role="gridcell" className="min-w-0">
                  <TagList tags={file.tags} kind="file" max={2} />
                </span>
                <span role="gridcell" {...ITEM_CONTROL}>
                  {menuItems.length > 0 && <Menu label="File actions" items={menuItems} tabIndex={tabbable ? 0 : -1} />}
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
