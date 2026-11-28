import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PromptDetail, PromptSummary } from '@assetforge/contracts';
import { call } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FilterBar } from '../components/FilterBar';
import { Page } from '../components/Page';
import { PromptEditor } from '../components/PromptEditor';
import { PromptList } from '../components/PromptList';
import { SearchField } from '../components/SearchField';
import { TagFilter } from '../components/TagFilter';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { usePagedList } from '../hooks/usePagedList';
import type { ViewPosition, ViewRestore, VisibleRows } from '../hooks/useVirtualRows';
import {
  DISCARD_LABEL,
  NEW_PROMPT_LABEL,
  NO_MATCHING_PROMPTS_TEXT,
  NO_PROMPT_SELECTED_TEXT,
  NO_PROMPTS_TEXT,
  PROMPT_TAG_FILTER_TITLE,
  promptCountLabel,
  PROMPTS_LABEL,
  RETRY_LABEL,
  SEARCH_PROMPTS_LABEL,
  UNSAVED_PROMPT_TITLE,
} from '../labels';
import { useLeaveGuard } from '../leave-guard';
import { failedFirstPage, wantedPages, type ShownRows } from '../paged-view';
import { renameInNames } from '../tag-rename';
import { useRenamed, useTags } from '../tags-context';
import { BUTTON, MUTED } from '../ui';

/** The props of {@link PromptsScreen}. */
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

/** The number of skeleton rows while the first page loads. */
const SKELETON_ROWS = 6;
/** The start of a list shown for the first time: the top, nothing focused. */
const NO_POSITION: ViewRestore = { scrollOffset: 0, index: null, focus: false };
/**
 * The leave guard while a save runs: stay, without asking.
 *
 * @returns false
 */
const HOLD = async () => false;

/**
 * The leave guard of the screen: a running save is never discarded, a dirty draft asks.
 *
 * @param saving whether a save or delete is in flight
 * @param dirty whether the draft holds unsaved changes
 * @param ask asks whether to discard the draft
 * @returns the guard, or null when the navigation may leave
 */
function leaveGuardOf(saving: boolean, dirty: boolean, ask: () => Promise<boolean>): (() => Promise<boolean>) | null {
  if (saving) return HOLD;
  return dirty ? ask : null;
}

/** What {@link usePromptPages} reads the list for. */
interface PromptPagesInput {
  query: string;
  tagNames: readonly string[];
  /** Raised after every tag rename. */
  renameToken: number;
}

/**
 * The paged prompt list with its position: a rename keeps the displayed position, a new filter
 * starts where `restore` was set (see `setFilter` in {@link PromptsScreen}). A save, tag change or
 * delete reloads in place through `paged.refresh`, which keeps the rows shown when the read fails.
 *
 * @param input the filter and the rename counter
 * @returns the paged list, the start and position refs and the row callback
 */
function usePromptPages({ query, tagNames, renameToken }: PromptPagesInput) {
  const key = JSON.stringify([query, tagNames, renameToken]);
  const restore = useRef<ViewRestore>(NO_POSITION);
  const position = useRef<{ viewKey: string; get(): ViewPosition } | null>(null);
  const lastRename = useRef(renameToken);
  const [rows, setRows] = useState<ShownRows | null>(null);

  const fetchPage = useCallback(
    (offset: number, limit: number) =>
      call('prompts:list', {
        offset,
        limit,
        ...(query !== '' && { query }),
        ...(tagNames.length > 0 && { tagNames: [...tagNames] }),
      }),
    [query, tagNames],
  );
  const [wanted, setWanted] = useState<readonly number[]>([0]);
  const paged = usePagedList<PromptSummary>(key, fetchPage, wanted);
  const total = paged.state.total;
  const viewKey = paged.state.key;
  if (lastRename.current !== renameToken) {
    lastRename.current = renameToken;
    const current = position.current?.viewKey === viewKey ? position.current.get() : null;
    restore.current = { scrollOffset: current?.scrollOffset ?? 0, index: null, focus: false };
  }
  const nextWanted = wantedPages(total, rows, viewKey);
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
  return { paged, restore, position, onRows };
}

/** The paged prompt list. */
type PromptPages = ReturnType<typeof usePromptPages>;

/**
 * The prompt library: the searchable list on the left, the editor of the selected prompt on the right.
 *
 * @param props the busy flag and the prompt selected at first
 * @returns the screen
 */
export function PromptsScreen({ busy, initialId = null }: Props) {
  const [queryText, setQueryText] = useState('');
  const [tagNames, setTagNames] = useState<readonly string[]>([]);
  const [editing, setEditing] = useState<Editing | null>(initialId === null ? null : { id: initialId, serial: 0 });
  const [dirty, setDirty] = useState(false);
  // A save or delete of the editor is in flight: nothing leaves the editor until it settled.
  const [saving, setSaving] = useState(false);
  // The open question whether to discard the draft, answered by the dialog.
  const [asking, setAsking] = useState<((discard: boolean) => void) | null>(null);

  const query = useDebouncedValue(queryText.trim(), SEARCH_DEBOUNCE_MS);
  const { renameToken } = useTags();
  useRenamed((change) => setTagNames((names) => renameInNames(names, change)));
  const pages = usePromptPages({ query, tagNames, renameToken });

  const ask = useCallback(() => new Promise<boolean>((resolve) => setAsking(() => resolve)), []);
  useLeaveGuard(leaveGuardOf(saving, dirty, ask));

  function answer(discard: boolean) {
    asking?.(discard);
    setAsking(null);
  }

  async function edit(id: string | null) {
    if (saving) return;
    if (id !== null && editing?.id === id) return;
    if (dirty && !(await ask())) return;
    setDirty(false);
    setEditing((current) => ({ id, serial: (current?.serial ?? 0) + 1 }));
  }

  function setFilter(change: { query?: string; tagNames?: readonly string[] }) {
    pages.restore.current = NO_POSITION;
    if (change.query !== undefined) setQueryText(change.query);
    if (change.tagNames !== undefined) setTagNames(change.tagNames);
  }

  const onDirtyChange = useCallback((next: boolean) => setDirty(next), []);
  const onSavingChange = useCallback((next: boolean) => setSaving(next), []);
  // After every save, tag change or delete: the list reloads where it is.
  const refresh = pages.paged.refresh;
  // The serial of the editor shown now, so that a late create answer of an editor left since is not taken.
  const shownSerial = useRef<number | null>(editing?.serial ?? null);
  useEffect(() => {
    shownSerial.current = editing?.serial ?? null;
  }, [editing]);
  const onSaved = useCallback(
    (detail: PromptDetail, created: boolean, serial: number) => {
      refresh();
      if (!created || shownSerial.current !== serial) return;
      setDirty(false);
      setEditing((current) => ({ id: detail.id, serial: (current?.serial ?? 0) + 1 }));
    },
    [refresh],
  );
  const onDeleted = useCallback(() => {
    setDirty(false);
    setEditing(null);
    refresh();
  }, [refresh]);

  const filtered = query !== '' || tagNames.length > 0;
  const total = pages.paged.state.total;

  return (
    <Page
      title={PROMPTS_LABEL}
      actions={
        <button type="button" className={BUTTON} disabled={busy || saving} onClick={() => void edit(null)}>
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
            <TagFilter
              value={tagNames}
              title={PROMPT_TAG_FILTER_TITLE}
              onChange={(names) => setFilter({ tagNames: names })}
            />
          </FilterBar>
          <div className="flex min-h-0 flex-1 flex-col" aria-busy={pages.paged.pending || undefined}>
            {promptsBody(pages, filtered, editing?.id ?? null, (prompt) => void edit(prompt.id))}
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
              onSavingChange={onSavingChange}
              onSaved={(detail, created) => onSaved(detail, created, editing.serial)}
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

/**
 * The list column below the filters: Retry when the first page failed, skeleton rows while it
 * loads, a note when nothing matches, else the list. A plain function, so every branch keeps the
 * element it had inline.
 *
 * @param pages the paged list
 * @param filtered whether a search or tag filter is set
 * @param selectedId the prompt in the editor
 * @param onChoose chooses a prompt
 * @returns the column content
 */
function promptsBody(
  pages: PromptPages,
  filtered: boolean,
  selectedId: string | null,
  onChoose: (prompt: PromptSummary) => void,
): ReactNode {
  const { paged } = pages;
  const total = paged.state.total;
  const failedPage = failedFirstPage(paged.state);
  if (failedPage !== null) {
    return (
      <div>
        <button type="button" className={BUTTON} onClick={() => paged.retry(failedPage)}>
          {RETRY_LABEL}
        </button>
      </div>
    );
  }
  if (total === null) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} data-skeleton="" className="h-16 animate-pulse rounded-control bg-raised" />
        ))}
      </div>
    );
  }
  if (total === 0) return <p className={MUTED}>{filtered ? NO_MATCHING_PROMPTS_TEXT : NO_PROMPTS_TEXT}</p>;
  const viewKey = paged.state.key;
  return (
    <PromptList
      key={viewKey}
      viewKey={viewKey}
      paged={paged.state}
      total={total}
      restore={pages.restore.current}
      selectedId={selectedId}
      onChoose={onChoose}
      onRows={pages.onRows}
      onRetry={paged.retry}
      positionRef={pages.position}
    />
  );
}
