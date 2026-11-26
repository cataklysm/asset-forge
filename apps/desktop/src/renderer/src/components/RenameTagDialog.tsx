import { cleanTagText, normalizeTagName, type TagUsage } from '@assetforge/contracts';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { ApiError, call, describeError } from '../api';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import {
  CANCEL_LABEL,
  MERGE_LABEL,
  RENAME_LABEL,
  RENAME_TAG_TITLE,
  TAG_NAME_LABEL,
  tagMergeLine,
  tagUsageLine,
} from '../labels';
import type { TagRename } from '../tag-rename';
import { ALERT, BUTTON, INPUT, LABEL } from '../ui';
import { Dialog } from './Dialog';

type Tag = { name: string; displayName: string };

interface Props {
  /** The tag to rename; null keeps the dialog closed. */
  tag: Tag | null;
  onClose(): void;
  onRenamed(change: TagRename): void;
}

/**
 * Renames a tag workspace-wide, or merges it into the tag the typed name belongs to. The typed
 * name is looked up debounced; the merge line and the `Merge` label are the confirmation.
 */
export function RenameTagDialog({ tag, onClose, onRenamed }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  return (
    <Dialog open={tag !== null} title={RENAME_TAG_TITLE} onClose={() => !busy.current && onClose()} initialFocusRef={inputRef}>
      {tag !== null && (
        <RenameTagForm key={tag.name} tag={tag} inputRef={inputRef} busyRef={busy} onClose={onClose} onRenamed={onRenamed} />
      )}
    </Dialog>
  );
}

/** A lookup answer for one normalised name, or the message of a failed lookup. */
type Lookup = { name: string; usage: TagUsage } | { name: string; failure: string };

function RenameTagForm({
  tag,
  inputRef,
  busyRef,
  onClose,
  onRenamed,
}: {
  tag: Tag;
  inputRef: RefObject<HTMLInputElement | null>;
  busyRef: { current: boolean };
  onClose(): void;
  onRenamed(change: TagRename): void;
}) {
  const [text, setText] = useState(tag.displayName);
  const [source, setSource] = useState<TagUsage | null>(null);
  const [target, setTarget] = useState<Lookup | null>(null);
  /** Raised to look the same name up again (after a refused rename). */
  const [lookupRun, setLookupRun] = useState(0);
  const [busy, setBusy] = useState(false);
  /** The tag no longer exists: only closing is left. */
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.select();
    let current = true;
    call('tags:usage', { name: tag.name }).then(
      (usage) => {
        if (current && usage.exists) setSource(usage);
      },
      // The line keeps the display name alone.
      () => {},
    );
    return () => {
      current = false;
    };
    // Once per tag; the form is keyed by the tag name.
  }, []);

  const cleaned = cleanTagText(text);
  const normalized = normalizeTagName(text);
  const unchanged = cleaned === tag.displayName;
  // Another spelling of the same tag needs no lookup: it can never be a merge.
  const lookupName = normalized !== null && normalized !== tag.name ? normalized : '';
  const debounced = useDebouncedValue(lookupName, SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    // A name still settling is looked up once the debounce has run out.
    if (debounced === '' || debounced !== lookupName) return;
    // Superseded: a later name (or unmounting) drops this answer.
    let current = true;
    call('tags:usage', { name: debounced }).then(
      (usage) => {
        if (current) setTarget({ name: debounced, usage });
      },
      // A failed lookup is no answer: confirm stays disabled until one for the current text succeeds.
      (e: unknown) => {
        if (current) setTarget({ name: debounced, failure: describeError(e) });
      },
    );
    return () => {
      current = false;
    };
  }, [debounced, lookupName, lookupRun]);

  const answer = lookupName !== '' && target?.name === lookupName ? target : null;
  const outstanding = lookupName !== '' && answer === null;
  const lookupFailure = answer !== null && 'failure' in answer ? answer.failure : null;
  const mergeWith = answer !== null && 'usage' in answer && answer.usage.exists ? answer.usage : null;
  const canConfirm = !busy && !gone && normalized !== null && !unchanged && !outstanding && lookupFailure === null;
  const shownError = lookupFailure ?? error;

  async function confirm() {
    if (!canConfirm || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await call('tags:rename', { from: tag.name, to: cleaned, merge: mergeWith !== null });
      busyRef.current = false;
      setBusy(false);
      onRenamed({ from: tag.name, name: result.name, displayName: result.displayName });
      onClose();
      return;
    } catch (e) {
      setError(describeError(e));
      if (e instanceof ApiError && e.code === 'not_found') setGone(true);
      if (e instanceof ApiError && e.code === 'invalid_operation') {
        setTarget(null);
        setLookupRun((run) => run + 1);
      }
    }
    busyRef.current = false;
    setBusy(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void confirm();
  }

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-3">
        <span className={LABEL}>{TAG_NAME_LABEL}</span>
        <input
          ref={inputRef}
          type="text"
          value={text}
          disabled={gone}
          onChange={(event) => {
            setText(event.target.value);
            if (!gone) setError(null);
            // Typing again retries a failed lookup, also when the name stays the same.
            if (target !== null && 'failure' in target) {
              setTarget(null);
              setLookupRun((run) => run + 1);
            }
          }}
          onKeyDown={onKeyDown}
          className={`${INPUT} min-w-0 flex-1`}
        />
      </label>
      <p className={`${LABEL} truncate`}>{source === null ? tag.displayName : tagUsageLine(source)}</p>
      {mergeWith !== null && <p className="truncate text-sm text-warning">{tagMergeLine(mergeWith)}</p>}
      {shownError !== null && (
        <p role="alert" className={ALERT}>
          {shownError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} disabled={busy} onClick={onClose}>
          {CANCEL_LABEL}
        </button>
        <button type="button" className={BUTTON} disabled={!canConfirm} onClick={() => void confirm()}>
          {mergeWith !== null ? MERGE_LABEL : RENAME_LABEL}
        </button>
      </div>
    </div>
  );
}
