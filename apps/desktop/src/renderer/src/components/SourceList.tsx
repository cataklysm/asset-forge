import type { AssetSource } from '@assetforge/contracts';
import { Copy, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  ADD_SOURCE_PLACEHOLDER,
  COPY_SOURCE_FAILED,
  COPY_SOURCE_TITLE,
  REMOVE_SOURCE_TITLE,
  SOURCES_LABEL,
} from '../labels';
import { ALERT, ICON_BUTTON_INLINE, INPUT, LABEL } from '../ui';
import { Link } from './Link';

// The source URLs of an asset in its header.

interface Props {
  /** The asset's sources, oldest first. */
  sources: readonly AssetSource[];
  /** Disables adding and removing (e.g. while an import runs); open and copy stay usable. */
  disabled: boolean;
  /** Rejects when the source was not added; the caller reports the error, the typed text stays. */
  onAdd(url: string): Promise<void>;
  /** Rejects when the source was not removed; the caller reports the error. */
  onRemove(sourceId: string): Promise<void>;
  /** Asks the main process to open a source; the caller reports a failure. */
  onOpen(sourceId: string): Promise<void>;
}

/**
 * The web addresses an asset's material came from. A source opens through `onOpen` with its ID only:
 * no anchor ever carries the address, so the window never navigates.
 *
 * @param props the sources, the disabled state and the actions
 * @returns the group
 */
export function SourceList({ sources, disabled, onAdd, onRemove, onOpen }: Props) {
  const labelId = useId();
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const addingRef = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);
  const list = useRef<HTMLUListElement>(null);
  /** The source being removed and its index, so that focus can move once it is gone. */
  const pendingFocus = useRef<{ id: string; index: number } | null>(null);

  // Whether a remove runs; a second remove before it has finished is ignored.
  const removingRef = useRef(false);

  // The input loses focus while it is disabled; it gets it back once the add has finished, unless the
  // user has put the focus somewhere else meanwhile. The disabled input may still count as the active element.
  useEffect(() => {
    if (adding || !refocus.current) return;
    refocus.current = false;
    const focused = document.activeElement;
    if (focused === null || focused === document.body || focused === input.current) input.current?.focus();
  }, [adding]);

  // A removed source takes its focused button with it; focus moves to the next source, else the previous one.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null || sources.some((source) => source.id === pending.id)) return;
    pendingFocus.current = null;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button[data-remove]') ?? [])];
    (buttons[pending.index] ?? buttons[pending.index - 1] ?? input.current)?.focus();
  }, [sources]);

  /** Removes a source, one at a time, and remembers where focus goes once it is gone. */
  async function remove(id: string, index: number) {
    if (removingRef.current) return;
    removingRef.current = true;
    setCopyFailed(false);
    pendingFocus.current = { id, index };
    try {
      await onRemove(id);
    } catch {
      // Reported by the caller; the source stays and keeps its focus.
      pendingFocus.current = null;
    } finally {
      removingRef.current = false;
    }
  }

  /** Adds the typed address once at a time and clears the input when it was added. */
  async function add() {
    const url = text.trim();
    if (url === '' || addingRef.current) return;
    setCopyFailed(false);
    addingRef.current = true;
    refocus.current = true;
    setAdding(true);
    try {
      await onAdd(url);
      setText('');
    } catch {
      // Reported by the caller; the text stays for a correction.
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  }

  /** Enter adds. */
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void add();
  }

  /** Copies an address to the clipboard. */
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <div role="group" aria-labelledby={labelId} className="flex min-w-0 flex-col gap-1.5">
      <span id={labelId} className={LABEL}>
        {SOURCES_LABEL}
      </span>
      {sources.length > 0 && (
        // Five rows (h-8 with a 4 px gap) and the 4 px padding that keeps focus rings unclipped fit; more scroll.
        <ul ref={list} className="max-h-46 min-w-0 space-y-1 overflow-y-auto p-1">
          {sources.map((source, index) => (
            <li key={source.id} className="flex min-w-0 items-center gap-1">
              <Link
                onFollow={() => {
                  setCopyFailed(false);
                  void onOpen(source.id).catch(() => {});
                }}
                title={source.url}
                className="block min-w-0 flex-1 truncate text-sm"
              >
                {source.url}
              </Link>
              <button
                type="button"
                className={`shrink-0 ${ICON_BUTTON_INLINE}`}
                title={COPY_SOURCE_TITLE}
                aria-label={COPY_SOURCE_TITLE}
                onClick={() => void copy(source.url)}
              >
                <Copy size={14} aria-hidden />
              </button>
              <button
                type="button"
                className={`shrink-0 ${ICON_BUTTON_INLINE}`}
                title={REMOVE_SOURCE_TITLE}
                aria-label={REMOVE_SOURCE_TITLE}
                data-remove
                disabled={disabled}
                onClick={() => void remove(source.id, index)}
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={input}
        type="text"
        className={`w-full min-w-0 text-sm ${INPUT}`}
        placeholder={ADD_SOURCE_PLACEHOLDER}
        aria-label={ADD_SOURCE_PLACEHOLDER}
        maxLength={2000}
        value={text}
        disabled={disabled || adding}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {copyFailed && (
        <p role="alert" className={ALERT}>
          {COPY_SOURCE_FAILED}
        </p>
      )}
    </div>
  );
}
