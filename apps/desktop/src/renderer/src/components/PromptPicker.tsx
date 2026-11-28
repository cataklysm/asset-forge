import { useCallback, useRef, useState, type KeyboardEvent, type UIEvent } from 'react';
import type { PromptSummary } from '@assetforge/contracts';
import { call, messageOf } from '../api';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { usePagedList } from '../hooks/usePagedList';
import {
  CANCEL_LABEL,
  NO_MATCHING_PROMPTS_TEXT,
  NO_PROMPTS_TEXT,
  PROMPTS_LABEL,
  RETRY_LABEL,
  SEARCH_PROMPTS_LABEL,
} from '../labels';
import { PAGE_SIZE, type PagedState } from '../paged-list';
import { ALERT, BORDER, BUTTON, BUTTON_INLINE, ITEM_HOVER, MUTED } from '../ui';
import { Dialog } from './Dialog';
import { SearchField } from './SearchField';

/** The props of {@link PromptPicker}. */
interface Props {
  /** Loads and attaches the prompt; a rejection's forwarded message is shown in the picker. */
  onPick(promptId: string): Promise<void>;
  onClose(): void;
}

/** Rows this close to the end of the list load the next page. */
const LOAD_AHEAD_PX = 200;
/** The focus ring of a row, drawn inside it. */
const ROW_FOCUS = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

/**
 * The first line of a text.
 *
 * @param text the text
 * @returns its first line
 */
const firstLine = (text: string) => text.split('\n', 1)[0] ?? '';

/**
 * The loaded rows in order, up to the first page that is not loaded.
 *
 * @param state the paged list
 * @returns the rows, and the page that failed when that is where the rows end
 */
function loadedItems(state: PagedState<PromptSummary>): { items: PromptSummary[]; failedPage: number | null } {
  const items: PromptSummary[] = [];
  let failedPage: number | null = null;
  for (let page = 0; ; page += 1) {
    const entry = state.pages.get(page);
    if (entry?.status === 'failed') failedPage = page;
    if (entry?.status !== 'loaded') break;
    items.push(...entry.items);
  }
  return { items, failedPage };
}

/**
 * A small dialog that finds a library prompt by the same query as the Prompts screen and hands over the chosen one.
 *
 * @param props the pick and close callbacks
 * @returns the dialog
 */
export function PromptPicker({ onPick, onClose }: Props) {
  const [queryText, setQueryText] = useState('');
  const query = useDebouncedValue(queryText.trim(), SEARCH_DEBOUNCE_MS);
  const fetchPage = useCallback(
    (offset: number, limit: number) => call('prompts:list', { offset, limit, ...(query !== '' && { query }) }),
    [query],
  );

  // A new query starts again with its first page.
  const [pages, setPages] = useState({ key: query, count: 1 });
  if (pages.key !== query) setPages({ key: query, count: 1 });
  const wanted = Array.from({ length: pages.key === query ? pages.count : 1 }, (_, page) => page);
  const { state, pending, retry } = usePagedList<PromptSummary>(query, fetchPage, wanted);

  const { items, failedPage } = loadedItems(state);
  const total = state.total;

  function onScroll(event: UIEvent<HTMLElement>) {
    const box = event.currentTarget;
    if (box.scrollHeight - box.scrollTop - box.clientHeight > LOAD_AHEAD_PX) return;
    if (total === null || items.length >= total || items.length < pages.count * PAGE_SIZE) return;
    setPages((current) => ({ ...current, count: current.count + 1 }));
  }

  const [error, setError] = useState<string | null>(null);
  // A double activation must not load twice.
  const picking = useRef(false);
  async function pick(prompt: PromptSummary) {
    if (picking.current) return;
    picking.current = true;
    setError(null);
    try {
      await onPick(prompt.id);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      picking.current = false;
    }
  }

  function onKeyDown(prompt: PromptSummary, event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void pick(prompt);
  }

  return (
    <Dialog open title={PROMPTS_LABEL} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <SearchField
          value={queryText}
          onChange={setQueryText}
          placeholder={SEARCH_PROMPTS_LABEL}
          label={SEARCH_PROMPTS_LABEL}
        />
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <div
          className={`h-80 overflow-y-auto rounded-control border ${BORDER}`}
          onScroll={onScroll}
          aria-busy={pending || undefined}
        >
          {total === 0 && (
            <p className={`p-3 text-sm ${MUTED}`}>{query === '' ? NO_PROMPTS_TEXT : NO_MATCHING_PROMPTS_TEXT}</p>
          )}
          <div role="listbox" aria-label={PROMPTS_LABEL} className="text-sm">
            {items.map((prompt) => (
              <div
                key={prompt.id}
                role="option"
                aria-selected={false}
                tabIndex={0}
                title={prompt.currentVersion.content}
                className={`flex cursor-default flex-col gap-1 border-b px-3 py-2 ${BORDER} ${ITEM_HOVER} ${ROW_FOCUS}`}
                onClick={() => void pick(prompt)}
                onKeyDown={(event) => onKeyDown(prompt, event)}
              >
                <span className="truncate font-medium">{prompt.title}</span>
                <span className={`truncate ${MUTED}`}>{firstLine(prompt.currentVersion.content)}</span>
              </div>
            ))}
          </div>
          {failedPage !== null && (
            <div className="p-2">
              <button type="button" className={BUTTON_INLINE} onClick={() => retry(failedPage)}>
                {RETRY_LABEL}
              </button>
            </div>
          )}
        </div>
        <div className="flex justify-end">
          <button type="button" className={BUTTON} onClick={onClose}>
            {CANCEL_LABEL}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
