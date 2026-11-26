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

interface Props {
  sources: readonly AssetSource[];
  /** Disables adding and removing (e.g. while an import runs); open and copy stay usable. */
  disabled: boolean;
  /** Rejects when the source was not added; the caller reports the error, the typed text stays. */
  onAdd(url: string): Promise<void>;
  onRemove(sourceId: string): Promise<void>;
  onOpen(sourceId: string): Promise<void>;
}

/**
 * The web addresses an asset's material came from. A source opens through `onOpen` with its ID only:
 * no anchor ever carries the address, so the window never navigates.
 */
export function SourceList({ sources, disabled, onAdd, onRemove, onOpen }: Props) {
  const labelId = useId();
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const addingRef = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);

  // The input loses focus while it is disabled; it gets it back once the add has finished.
  useEffect(() => {
    if (adding || !refocus.current) return;
    refocus.current = false;
    input.current?.focus();
  }, [adding]);

  async function add() {
    const url = text.trim();
    if (url === '' || addingRef.current) return;
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

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void add();
  }

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
        // Five rows (h-8 with a 4 px gap) fit; more scroll inside the block.
        <ul className="max-h-44 min-w-0 space-y-1 overflow-y-auto">
          {sources.map((source) => (
            <li key={source.id} className="flex min-w-0 items-center gap-1">
              <Link
                onFollow={() => void onOpen(source.id).catch(() => {})}
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
                disabled={disabled}
                onClick={() => void onRemove(source.id).catch(() => {})}
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
