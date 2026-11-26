import { Folder } from 'lucide-react';
import { useRef, type KeyboardEvent, type RefObject } from 'react';
import type { ProjectSummary } from '@assetforge/contracts';
import { rowCount } from '../gallery';
import {
  useElementSize,
  useVirtualRows,
  type ViewPosition,
  type ViewRestore,
  type VisibleRows,
} from '../hooks/useVirtualRows';
import { label } from '../labels';
import { retryIndex, slotAt, type PagedState } from '../paged-list';
import { BORDER, BUTTON_INLINE, ITEM_HOVER, MUTED } from '../ui';
import { TagList } from './TagList';

export interface ProjectTableProps {
  viewKey: string;
  paged: PagedState<ProjectSummary>;
  total: number;
  restore: ViewRestore;
  /** With a tag filter the table shows the Matching tags column. */
  tagged: boolean;
  selectedId: string | null;
  onSelect(project: ProjectSummary): void;
  onOpen(project: ProjectSummary, scrollOffset: number): void;
  onRows(rows: VisibleRows): void;
  onRetry(page: number): void;
  positionRef: { current: { viewKey: string; get(): ViewPosition } | null };
}

const HEADER_HEIGHT = 32;
const ROW_HEIGHT = 48;
const ROW_FOCUS = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
const COLUMNS = 'grid items-center gap-3 px-2';
const PLAIN = 'grid-cols-[minmax(10rem,2fr)_8rem_5rem_6rem]';
const TAGGED = 'grid-cols-[minmax(10rem,2fr)_8rem_5rem_minmax(8rem,2fr)_6rem]';

/** The virtualised project list of the projects screen: click selects, double click, Enter or Open opens. */
export function ProjectTable(props: ProjectTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label="Projects"
      aria-rowcount={rowCount(props.total, 1) + 1}
      className="min-h-0 flex-1 overflow-y-scroll"
    >
      {size !== null && size.height > 0 && <TableRows {...props} scrollRef={scrollRef} height={size.height} />}
    </div>
  );
}

function TableRows(props: ProjectTableProps & { scrollRef: RefObject<HTMLDivElement | null>; height: number }) {
  const { viewKey, paged, total, restore, tagged, selectedId, onSelect, onOpen, onRows, onRetry, positionRef } = props;
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
  const headers = tagged ? ['Project', 'Status', 'Assets', 'Matching tags'] : ['Project', 'Status', 'Assets'];

  function onKeyDown(index: number, project: ProjectSummary | null, event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      if (project) onOpen(project, rows.scrollOffset());
      return;
    }
    rows.onItemKeyDown(index, event);
  }

  return (
    <div role="presentation" className="relative w-full text-sm" style={{ height: virtualizer.getTotalSize() }}>
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
        <span role="columnheader" aria-label="Actions" />
      </div>
      {virtualizer.getVirtualItems().map((row) => {
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
        const project = slot.kind === 'loaded' ? slot.item : null;
        const selected = project !== null && project.id === selectedId;
        return (
          <div
            key={index}
            role="row"
            aria-rowindex={index + 2}
            data-index={index}
            tabIndex={index === rows.tabbableIndex ? 0 : -1}
            aria-selected={selected}
            aria-disabled={project === null ? true : undefined}
            aria-busy={slot.kind === 'placeholder' ? true : undefined}
            className={`absolute inset-x-0 cursor-default border-b ${BORDER} ${
              selected ? 'bg-accent-soft ring-2 ring-accent ring-inset' : ITEM_HOVER
            } ${ROW_FOCUS} ${columns}`}
            style={style}
            onClick={() => {
              if (project) onSelect(project);
            }}
            onDoubleClick={() => {
              if (project) onOpen(project, rows.scrollOffset());
            }}
            onKeyDown={(e) => onKeyDown(index, project, e)}
            onFocus={() => {
              rows.onItemFocus(index);
              if (project) onSelect(project);
            }}
          >
            {project !== null && <ProjectCells project={project} tagged={tagged} onOpen={() => onOpen(project, rows.scrollOffset())} />}
          </div>
        );
      })}
    </div>
  );
}

function ProjectCells({ project, tagged, onOpen }: { project: ProjectSummary; tagged: boolean; onOpen(): void }) {
  const matched = project.matchedTags ?? [];
  const names = new Set(matched.map((t) => t.name));
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
          <TagList tags={matched.filter((t) => t.onAsset)} kind="asset" max={3} matched={names} />
          <TagList tags={matched.filter((t) => !t.onAsset && t.onFiles)} kind="file" max={3} matched={names} />
        </span>
      )}
      <span role="gridcell" className="flex justify-end">
        <button
          type="button"
          tabIndex={-1}
          className={BUTTON_INLINE}
          aria-label={`Open ${project.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          Open
        </button>
      </span>
    </>
  );
}
