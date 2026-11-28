import { Folder } from 'lucide-react';
import { useRef, type KeyboardEvent, type RefObject } from 'react';
import type { ProjectSummary } from '@assetforge/contracts';
import { rowCount } from '../gallery';
import {
  useElementSize,
  useVirtualRows,
  type ViewPosition,
  type ViewRestore,
  type VirtualRows,
  type VisibleRows,
} from '../hooks/useVirtualRows';
import {
  label,
  OPEN_PROJECT_BUTTON,
  openProjectLabel,
  PROJECT_ACTIONS_COLUMN,
  PROJECT_ASSETS_COLUMN,
  PROJECT_COLUMN,
  PROJECT_MATCHING_TAGS_COLUMN,
  PROJECT_STATUS_COLUMN,
  PROJECTS_TITLE,
  RETRY_LABEL,
} from '../labels';
import { retryIndex, slotAt, type PagedState, type Slot } from '../paged-list';
import { BORDER, BUTTON_INLINE, ITEM_HOVER, MUTED } from '../ui';
import { PageFailureText } from './PageFailure';
import { TagList } from './TagList';

/** The props of `ProjectTable`. */
export interface ProjectTableProps {
  /** The list key the scroll position belongs to. */
  viewKey: string;
  paged: PagedState<ProjectSummary>;
  total: number;
  /** The scroll position to restore on mount. */
  restore: ViewRestore;
  /** With a tag filter the table shows the Matching tags column. */
  tagged: boolean;
  selectedId: string | null;
  onSelect(project: ProjectSummary): void;
  /** Opens a project; the scroll offset and its row index are kept for the way back. */
  onOpen(project: ProjectSummary, scrollOffset: number, index: number): void;
  /** Called with the rows in view, so their pages can be loaded. */
  onRows(rows: VisibleRows): void;
  /** Loads a failed page again. */
  onRetry(page: number): void;
  /** Receives the source of the current scroll position. */
  positionRef: { current: { viewKey: string; get(): ViewPosition } | null };
}

/** The height of the sticky header row in pixels. */
const HEADER_HEIGHT = 32;
/** The height of one project row in pixels. */
const ROW_HEIGHT = 48;
/** The focus ring of a row, drawn inside it. */
const ROW_FOCUS = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
/** The grid of every row. */
const COLUMNS = 'grid items-center gap-3 px-2';
/** The columns without a tag filter. */
const PLAIN = 'grid-cols-[minmax(10rem,2fr)_8rem_5rem_6rem]';
/** The columns with the Matching tags column. */
const TAGGED = 'grid-cols-[minmax(10rem,2fr)_8rem_5rem_minmax(8rem,2fr)_6rem]';

/**
 * Whether a key press opens the row: Enter without a modifier.
 *
 * @param event the key event
 * @returns true for a plain Enter
 */
function isPlainEnter(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

/**
 * The virtualised project list of the projects screen: click selects, double click, Enter or Open opens.
 *
 * @param props the list state, the selection and the callbacks
 * @returns the scrolling grid
 */
export function ProjectTable(props: ProjectTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label={PROJECTS_TITLE}
      aria-rowcount={rowCount(props.total, 1) + 1}
      className="min-h-0 flex-1 overflow-y-scroll"
    >
      {size !== null && size.height > 0 && <TableRows {...props} scrollRef={scrollRef} height={size.height} />}
    </div>
  );
}

/** The props of `TableRows`. */
type TableRowsProps = ProjectTableProps & { scrollRef: RefObject<HTMLDivElement | null>; height: number };

/**
 * The header and the rendered rows, once the viewport height is known.
 *
 * @param props the table props plus the scroll element and its height
 * @returns the sized row container
 */
function TableRows(props: TableRowsProps) {
  const { viewKey, paged, total, restore, tagged, onRows, positionRef } = props;
  const rows = useVirtualRows({
    scrollRef: props.scrollRef,
    total,
    columns: 1,
    rowHeight: ROW_HEIGHT,
    paddingStart: HEADER_HEIGHT,
    viewportHeight: props.height - HEADER_HEIGHT,
    restore,
    onRows,
    viewKey,
    positionRef,
  });
  const { virtualizer } = rows;
  const columns = `${COLUMNS} ${tagged ? TAGGED : PLAIN}`;

  return (
    <div role="presentation" className="relative w-full text-sm" style={{ height: virtualizer.getTotalSize() }}>
      <HeaderRow tagged={tagged} columns={columns} />
      {virtualizer.getVirtualItems().map((row) => (
        <TableRow
          key={row.index}
          {...props}
          index={row.index}
          top={row.start}
          slot={slotAt(paged, row.index)}
          rows={rows}
          columns={columns}
        />
      ))}
    </div>
  );
}

/**
 * The sticky header row.
 *
 * @param props whether the Matching tags column shows, and the grid classes
 * @returns the header row
 */
function HeaderRow({ tagged, columns }: { tagged: boolean; columns: string }) {
  const plain = [PROJECT_COLUMN, PROJECT_STATUS_COLUMN, PROJECT_ASSETS_COLUMN];
  const headers = tagged ? [...plain, PROJECT_MATCHING_TAGS_COLUMN] : plain;
  return (
    <div
      role="row"
      aria-rowindex={1}
      className={`sticky top-0 z-10 border-b bg-surface ${BORDER} ${MUTED} ${columns}`}
      style={{ height: HEADER_HEIGHT }}
    >
      {headers.map((header) => (
        <span key={header} role="columnheader" className="truncate">
          {header}
        </span>
      ))}
      <span role="columnheader" aria-label={PROJECT_ACTIONS_COLUMN} />
    </div>
  );
}

/**
 * The classes of a project row.
 *
 * @param selected whether the row is the selected project
 * @param columns the grid classes
 * @returns the class list
 */
function rowClass(selected: boolean, columns: string): string {
  const look = selected ? 'bg-accent-soft ring-2 ring-accent ring-inset' : ITEM_HOVER;
  return `absolute inset-x-0 cursor-default border-b ${BORDER} ${look} ${ROW_FOCUS} ${columns}`;
}

/** The props of `TableRow`. */
type TableRowProps = TableRowsProps & {
  index: number;
  /** The offset of the row from the top of the list. */
  top: number;
  slot: Slot<ProjectSummary>;
  rows: VirtualRows;
  columns: string;
};

/**
 * One rendered row: the Retry row of a failed page, or a project (or its placeholder). Both render
 * a `div` at the root, so a row changing between them keeps its element.
 *
 * @param props the row position, its slot, the virtual rows and the table callbacks
 * @returns the row
 */
function TableRow(props: TableRowProps) {
  const { index, top, slot, rows, columns, tagged, selectedId, onSelect, onOpen, onRetry } = props;
  if (slot.kind === 'failed' && index === retryIndex(slot.page, rows.firstVisibleIndex)) {
    // Called, not mounted: the row stays the same `div` element when it changes between the two kinds.
    return retryRow({ index, top, page: slot.page, message: slot.message, rows, onRetry });
  }
  const project = slot.kind === 'loaded' ? slot.item : null;
  const selected = project !== null && project.id === selectedId;
  const open = () => {
    if (project) onOpen(project, rows.scrollOffset(), index);
  };
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      data-index={index}
      data-item-id={project?.id}
      tabIndex={index === rows.tabbableIndex ? 0 : -1}
      aria-selected={selected}
      aria-disabled={project === null ? true : undefined}
      aria-busy={slot.kind === 'placeholder' ? true : undefined}
      className={rowClass(selected, columns)}
      style={{ top, height: ROW_HEIGHT }}
      onClick={() => project && onSelect(project)}
      onDoubleClick={open}
      onKeyDown={(event) => {
        // Enter opens the project; every other key goes to the virtual rows.
        if (!isPlainEnter(event)) return rows.onItemKeyDown(index, event);
        event.preventDefault();
        open();
      }}
      onFocus={() => {
        rows.onItemFocus(index);
        if (project) onSelect(project);
      }}
    >
      {project !== null && <ProjectCells project={project} tagged={tagged} onOpen={open} />}
    </div>
  );
}

/** The arguments of `retryRow`. */
interface RetryRowProps {
  index: number;
  /** The offset of the row from the top of the list. */
  top: number;
  /** The failed page. */
  page: number;
  /** The failure text of the page. */
  message: string | undefined;
  rows: VirtualRows;
  onRetry(page: number): void;
}

/**
 * The Retry row of a failed page, with its failure text. Without hooks, so `TableRow` can call it.
 *
 * @param props the row position, the failed page and the retry
 * @returns the row
 */
function retryRow({ index, top, page, message, rows, onRetry }: RetryRowProps) {
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      className={`absolute inset-x-0 flex items-center gap-3 border-b px-2 ${BORDER}`}
      style={{ top, height: ROW_HEIGHT }}
    >
      <span role="gridcell" className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          data-index={index}
          className={BUTTON_INLINE}
          tabIndex={index === rows.tabbableIndex ? 0 : -1}
          onClick={() => {
            rows.refocus(index);
            onRetry(page);
          }}
          onKeyDown={(event) => rows.onItemKeyDown(index, event)}
          onFocus={() => rows.onItemFocus(index)}
        >
          {RETRY_LABEL}
        </button>
        <PageFailureText message={message} />
      </span>
    </div>
  );
}

/**
 * The cells of one project row.
 *
 * @param props the project, whether the Matching tags column shows, and the open
 * @returns the cells
 */
function ProjectCells({ project, tagged, onOpen }: { project: ProjectSummary; tagged: boolean; onOpen(): void }) {
  const matched = project.matchedTags ?? [];
  const names = new Set(matched.map((tag) => tag.name));
  return (
    <>
      <span role="gridcell" className="flex min-w-0 items-center gap-2 font-medium" title={project.name}>
        <Folder size={16} aria-hidden className="shrink-0 text-muted" />
        <span className="truncate">{project.name}</span>
      </span>
      <span role="gridcell" className="truncate">
        {label(project.status)}
      </span>
      <span role="gridcell" className="tabular-nums">
        {project.assetCount}
      </span>
      {tagged && (
        <span role="gridcell" className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {/* A tag found on the asset itself counts as an asset tag; only the others follow the image icon. */}
          <TagList tags={matched.filter((tag) => tag.onAsset)} kind="asset" max={3} matched={names} />
          <TagList tags={matched.filter((tag) => !tag.onAsset && tag.onFiles)} kind="file" max={3} matched={names} />
        </span>
      )}
      <span role="gridcell" className="flex justify-end">
        <button
          type="button"
          tabIndex={-1}
          className={BUTTON_INLINE}
          aria-label={openProjectLabel(project.name)}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {OPEN_PROJECT_BUTTON}
        </button>
      </span>
    </>
  );
}
