import { useRef, type KeyboardEvent, type RefObject } from 'react';
import type { PromptSummary } from '@assetforge/contracts';
import { rowCount } from '../gallery';
import {
  useElementSize,
  useVirtualRows,
  type ViewPosition,
  type ViewRestore,
  type VisibleRows,
} from '../hooks/useVirtualRows';
import { PROMPTS_LABEL, RETRY_LABEL } from '../labels';
import { retryIndex, slotAt, type PagedState, type Slot } from '../paged-list';
import { BORDER, BUTTON_INLINE, ITEM_HOVER, MUTED } from '../ui';
import { TagList } from './TagList';

/** The height of a prompt row in pixels. */
const ROW_HEIGHT = 72;
/** The focus ring of a row, drawn inside it. */
const ROW_FOCUS = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

/**
 * The first line of a text.
 *
 * @param content the text
 * @returns its first line
 */
const firstLine = (content: string) => content.split('\n', 1)[0] ?? '';

/** The props of {@link PromptList}. */
export interface PromptListProps {
  viewKey: string;
  paged: PagedState<PromptSummary>;
  total: number;
  /** Where the list starts; read once when it mounts. */
  restore: ViewRestore;
  selectedId: string | null;
  onChoose(prompt: PromptSummary): void;
  onRows(rows: VisibleRows): void;
  /** Reads a failed page again. */
  onRetry(page: number): void;
  positionRef: { current: { viewKey: string; get(): ViewPosition } | null };
}

/**
 * The virtualised prompt list: click, Enter or Space chooses a prompt; the arrow keys move the focus.
 *
 * @param props the list, the selection and the callbacks
 * @returns the listbox
 */
export function PromptList(props: PromptListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label={PROMPTS_LABEL}
      aria-setsize={rowCount(props.total, 1)}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      {size !== null && size.height > 0 && <ListRows {...props} scrollRef={scrollRef} height={size.height} />}
    </div>
  );
}

/** The props of {@link ListRows}. */
interface ListRowsProps extends PromptListProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The height of the scroll area in pixels. */
  height: number;
}

/** The virtual rows of the list. */
type Rows = ReturnType<typeof useVirtualRows>;

/**
 * The visible rows of the list.
 *
 * @param props the list props, the scroll area and its height
 * @returns the rows
 */
function ListRows(props: ListRowsProps) {
  const { viewKey, paged, total, restore, selectedId, onChoose, onRows, onRetry, positionRef } = props;
  const rows = useVirtualRows({
    scrollRef: props.scrollRef,
    total,
    columns: 1,
    rowHeight: ROW_HEIGHT,
    paddingStart: 0,
    viewportHeight: props.height,
    restore,
    onRows,
    viewKey,
    positionRef,
  });
  const { virtualizer } = rows;

  function onKeyDown(index: number, prompt: PromptSummary | null, event: KeyboardEvent) {
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (plain && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      if (prompt) onChoose(prompt);
      return;
    }
    rows.onItemKeyDown(index, event);
  }

  return (
    <div role="presentation" className="relative w-full text-sm" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((row) => {
        const index = row.index;
        const slot = slotAt(paged, index);
        const style = { top: row.start, height: ROW_HEIGHT };
        if (slot.kind === 'failed' && index === retryIndex(slot.page, rows.firstVisibleIndex)) {
          const retry = () => {
            rows.refocus(index);
            onRetry(slot.page);
          };
          return retryRow({ index, style, rows, onRetry: retry });
        }
        return optionRow({ index, slot, style, total, selectedId, rows, onChoose, onKeyDown });
      })}
    </div>
  );
}

/** What {@link retryRow} draws. */
interface RetryRowProps {
  index: number;
  style: { top: number; height: number };
  rows: Rows;
  onRetry(): void;
}

/**
 * The row in place of a page that failed to load, with Retry. A plain function, not a component: a
 * row that turns from a failed page into a prompt keeps its element.
 *
 * @param props the row index, its place and the retry callback
 * @returns the row, keyed by its index
 */
function retryRow({ index, style, rows, onRetry }: RetryRowProps) {
  return (
    <div
      key={index}
      role="presentation"
      className={`absolute inset-x-0 flex items-center border-b px-2 ${BORDER}`}
      style={style}
    >
      <button
        type="button"
        data-index={index}
        className={BUTTON_INLINE}
        tabIndex={index === rows.tabbableIndex ? 0 : -1}
        onClick={onRetry}
        onKeyDown={(event) => rows.onItemKeyDown(index, event)}
        onFocus={() => rows.onItemFocus(index)}
      >
        {RETRY_LABEL}
      </button>
    </div>
  );
}

/** What {@link optionRow} draws. */
interface OptionRowProps {
  index: number;
  slot: Slot<PromptSummary>;
  style: { top: number; height: number };
  total: number;
  selectedId: string | null;
  rows: Rows;
  onChoose(prompt: PromptSummary): void;
  onKeyDown(index: number, prompt: PromptSummary | null, event: KeyboardEvent): void;
}

/**
 * A prompt row; empty and disabled while its prompt is not loaded. A plain function like {@link retryRow}.
 *
 * @param props the row index, its slot, its place, the selection and the callbacks
 * @returns the row, keyed by its index
 */
function optionRow({ index, slot, style, total, selectedId, rows, onChoose, onKeyDown }: OptionRowProps) {
  const prompt = slot.kind === 'loaded' ? slot.item : null;
  const selected = prompt !== null && prompt.id === selectedId;
  return (
    <div
      key={index}
      role="option"
      aria-posinset={index + 1}
      aria-setsize={total}
      data-index={index}
      tabIndex={index === rows.tabbableIndex ? 0 : -1}
      aria-selected={selected}
      aria-disabled={prompt === null ? true : undefined}
      aria-busy={slot.kind === 'placeholder' ? true : undefined}
      className={`absolute inset-x-0 flex cursor-default flex-col justify-center gap-1 border-b px-2 ${BORDER} ${
        selected ? 'bg-accent-soft ring-2 ring-accent ring-inset' : ITEM_HOVER
      } ${ROW_FOCUS}`}
      style={style}
      onClick={() => {
        if (prompt) onChoose(prompt);
      }}
      onKeyDown={(event) => onKeyDown(index, prompt, event)}
      onFocus={() => rows.onItemFocus(index)}
    >
      {prompt !== null && (
        <>
          <span className="truncate font-medium" title={prompt.title}>
            {prompt.title}
          </span>
          <span className={`truncate ${MUTED}`}>{firstLine(prompt.currentVersion.content)}</span>
          <TagList tags={prompt.tags} kind="prompt" max={3} />
        </>
      )}
    </div>
  );
}
