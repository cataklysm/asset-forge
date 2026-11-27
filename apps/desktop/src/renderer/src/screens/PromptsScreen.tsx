import { Plus } from 'lucide-react';
import { useCallback, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { PromptDetail, PromptSummary } from '@assetforge/contracts';
import { call } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FilterBar } from '../components/FilterBar';
import { Page } from '../components/Page';
import { PromptEditor } from '../components/PromptEditor';
import { SearchField } from '../components/SearchField';
import { TagFilter } from '../components/TagFilter';
import { TagList } from '../components/TagList';
import { pagesForRows, rowCount } from '../gallery';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { usePagedList } from '../hooks/usePagedList';
import {
  useElementSize,
  useVirtualRows,
  type ViewPosition,
  type ViewRestore,
  type VisibleRows,
} from '../hooks/useVirtualRows';
import {
  DISCARD_LABEL,
  NEW_PROMPT_LABEL,
  NO_MATCHING_PROMPTS_TEXT,
  NO_PROMPT_SELECTED_TEXT,
  NO_PROMPTS_TEXT,
  PROMPT_TAG_FILTER_TITLE,
  promptCountLabel,
  PROMPTS_LABEL,
  SEARCH_PROMPTS_LABEL,
  UNSAVED_PROMPT_TITLE,
} from '../labels';
import { useLeaveGuard } from '../leave-guard';
import { retryIndex, slotAt, type PagedState } from '../paged-list';
import { renameInNames } from '../tag-rename';
import { useRenamed, useTags } from '../tags-context';
import { BORDER, BUTTON, BUTTON_INLINE, ITEM_HOVER, MUTED } from '../ui';

interface Props {
  /** An import runs: New, Save, Delete and tag editing are disabled. */
  busy: boolean;
  /** The prompt selected when the screen opens. */
  initialId?: string | null;
}

/** The prompt in the editor: an existing one by id, or a new draft (`id: null`); `serial` remounts the editor. */
interface Editing {
  id: string | null;
  serial: number;
}

const SKELETON_ROWS = 6;
const ROW_HEIGHT = 72;
const NO_POSITION: ViewRestore = { scrollOffset: 0, index: null, focus: false };

const firstLine = (content: string) => content.split('\n', 1)[0] ?? '';

/** The prompt library: the searchable list on the left, the editor of the selected prompt on the right. */
export function PromptsScreen({ busy, initialId = null }: Props) {
  const [queryText, setQueryText] = useState('');
  const [tagNames, setTagNames] = useState<readonly string[]>([]);
  // Raised after every save, tag change or delete: the list reloads where it is.
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(initialId === null ? null : { id: initialId, serial: 0 });
  const [dirty, setDirty] = useState(false);
  // The open question whether to discard the draft, answered by the dialog.
  const [asking, setAsking] = useState<((discard: boolean) => void) | null>(null);

  const query = useDebouncedValue(queryText.trim(), SEARCH_DEBOUNCE_MS);
  const { renameToken } = useTags();
  useRenamed((change) => setTagNames((names) => renameInNames(names, change)));
  const key = JSON.stringify([query, tagNames, reload, renameToken]);

  const restore = useRef<ViewRestore>(NO_POSITION);
  const position = useRef<{ viewKey: string; get(): ViewPosition } | null>(null);
  const lastReload = useRef(`${reload}:${renameToken}`);
  const [rows, setRows] = useState<(VisibleRows & { viewKey: string }) | null>(null);

  const fetchPage = useCallback(
    (offset: number, limit: number) =>
      call('prompts:list', { offset, limit, ...(query !== '' && { query }), ...(tagNames.length > 0 && { tagNames: [...tagNames] }) }),
    [query, tagNames],
  );
  const [wanted, setWanted] = useState<readonly number[]>([0]);
  const paged = usePagedList<PromptSummary>(key, fetchPage, wanted);
  const total = paged.state.total;
  const viewKey = paged.state.key;
  // A reload keeps the displayed position; a new filter starts at the top (see `setFilter`).
  if (lastReload.current !== `${reload}:${renameToken}`) {
    lastReload.current = `${reload}:${renameToken}`;
    const current = position.current?.viewKey === viewKey ? position.current.get() : null;
    restore.current = { scrollOffset: current?.scrollOffset ?? 0, index: null, focus: false };
  }
  const nextWanted =
    total === null
      ? [0]
      : rows !== null && rows.viewKey === viewKey
        ? pagesForRows(rows.firstRow, rows.lastRow, rows.columns, total)
        : [];
  if (nextWanted.join(',') !== wanted.join(',')) setWanted(nextWanted);

  const onRows = useCallback(
    (visible: VisibleRows) =>
      setRows((old) =>
        old !== null &&
        old.viewKey === viewKey &&
        old.firstRow === visible.firstRow &&
        old.lastRow === visible.lastRow &&
        old.columns === visible.columns
          ? old
          : { ...visible, viewKey },
      ),
    [viewKey],
  );

  const ask = useCallback(() => new Promise<boolean>((resolve) => setAsking(() => resolve)), []);
  useLeaveGuard(dirty ? ask : null);

  function answer(discard: boolean) {
    asking?.(discard);
    setAsking(null);
  }

  async function edit(id: string | null) {
    if (id !== null && editing?.id === id) return;
    if (dirty && !(await ask())) return;
    setDirty(false);
    setEditing((current) => ({ id, serial: (current?.serial ?? 0) + 1 }));
  }

  function setFilter(change: { query?: string; tagNames?: readonly string[] }) {
    restore.current = NO_POSITION;
    if (change.query !== undefined) setQueryText(change.query);
    if (change.tagNames !== undefined) setTagNames(change.tagNames);
  }

  const onDirtyChange = useCallback((next: boolean) => setDirty(next), []);
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  const onSaved = useCallback(
    (detail: PromptDetail, created: boolean) => {
      refresh();
      if (created) {
        setDirty(false);
        setEditing((current) => ({ id: detail.id, serial: (current?.serial ?? 0) + 1 }));
      }
    },
    [refresh],
  );
  const onDeleted = useCallback(() => {
    setDirty(false);
    setEditing(null);
    refresh();
  }, [refresh]);

  const filtered = query !== '' || tagNames.length > 0;
  const failedPage =
    total === null ? ([...paged.state.pages].find(([, entry]) => entry.status === 'failed')?.[0] ?? null) : null;

  return (
    <Page
      title={PROMPTS_LABEL}
      actions={
        <button type="button" className={BUTTON} disabled={busy} onClick={() => void edit(null)}>
          <Plus size={16} aria-hidden />
          {NEW_PROMPT_LABEL}
        </button>
      }
    >
      <div className="flex min-h-0 flex-1 gap-6">
        <div className="flex min-h-0 w-80 shrink-0 flex-col gap-3">
          <FilterBar
            resultCount={total === null ? null : promptCountLabel(total)}
            onClear={filtered ? () => setFilter({ query: '', tagNames: [] }) : null}
          >
            <SearchField
              label={SEARCH_PROMPTS_LABEL}
              placeholder={SEARCH_PROMPTS_LABEL}
              value={queryText}
              onChange={(text) => setFilter({ query: text })}
            />
            <TagFilter value={tagNames} title={PROMPT_TAG_FILTER_TITLE} onChange={(names) => setFilter({ tagNames: names })} />
          </FilterBar>
          <div className="flex min-h-0 flex-1 flex-col" aria-busy={paged.pending || undefined}>
            {failedPage !== null ? (
              <div>
                <button type="button" className={BUTTON} onClick={() => paged.retry(failedPage)}>
                  Retry
                </button>
              </div>
            ) : total === null ? (
              <div className="flex flex-col gap-2" aria-busy="true">
                {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                  <div key={i} data-skeleton="" className="h-16 animate-pulse rounded-control bg-raised" />
                ))}
              </div>
            ) : total === 0 ? (
              <p className={MUTED}>{filtered ? NO_MATCHING_PROMPTS_TEXT : NO_PROMPTS_TEXT}</p>
            ) : (
              <PromptList
                key={viewKey}
                viewKey={viewKey}
                paged={paged.state}
                total={total}
                restore={restore.current}
                selectedId={editing?.id ?? null}
                onChoose={(prompt) => void edit(prompt.id)}
                onRows={onRows}
                onRetry={paged.retry}
                positionRef={position}
              />
            )}
          </div>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {editing === null ? (
            <p className={MUTED}>{NO_PROMPT_SELECTED_TEXT}</p>
          ) : (
            <PromptEditor
              key={editing.serial}
              promptId={editing.id}
              busy={busy}
              onDirtyChange={onDirtyChange}
              onSaved={onSaved}
              onTagsChanged={refresh}
              onDeleted={onDeleted}
            />
          )}
        </div>
      </div>
      <ConfirmDialog
        open={asking !== null}
        title={UNSAVED_PROMPT_TITLE}
        confirmLabel={DISCARD_LABEL}
        busy={false}
        onConfirm={() => answer(true)}
        onCancel={() => answer(false)}
      />
    </Page>
  );
}

interface ListProps {
  viewKey: string;
  paged: PagedState<PromptSummary>;
  total: number;
  restore: ViewRestore;
  selectedId: string | null;
  onChoose(prompt: PromptSummary): void;
  onRows(rows: VisibleRows): void;
  onRetry(page: number): void;
  positionRef: { current: { viewKey: string; get(): ViewPosition } | null };
}

/** The virtualised prompt list: click, Enter or Space chooses a prompt; the arrow keys move the focus. */
function PromptList(props: ListProps) {
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

const ROW_FOCUS = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

function ListRows(props: ListProps & { scrollRef: RefObject<HTMLDivElement | null>; height: number }) {
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
          return (
            <div key={index} role="presentation" className={`absolute inset-x-0 flex items-center border-b px-2 ${BORDER}`} style={style}>
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
            </div>
          );
        }
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
            onKeyDown={(e) => onKeyDown(index, prompt, e)}
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
      })}
    </div>
  );
}
