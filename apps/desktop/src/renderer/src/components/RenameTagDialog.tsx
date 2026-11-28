import { cleanTagText, normalizeTagName } from '@assetforge/contracts';
import { useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { ApiError, call, describeError } from '../api';
import { useSourceUsage, useTargetLookup } from '../hooks/useTagLookup';
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

/** A tag by its normalised name and its display name. */
type Tag = { name: string; displayName: string };

/** The props of `RenameTagDialog`. */
interface Props {
  /** The tag to rename; null keeps the dialog closed. */
  tag: Tag | null;
  /** Closes the dialog; ignored while a rename runs. */
  onClose(): void;
  /** Called once a rename or merge succeeded. */
  onRenamed(change: TagRename): void;
}

/**
 * Renames a tag workspace-wide, or merges it into the tag the typed name belongs to. The typed
 * name is looked up debounced; the merge line and the `Merge` label are the confirmation.
 *
 * @param props the tag, the close and the rename callback
 * @returns the dialog
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

/** The props of `RenameTagForm`. */
interface FormProps {
  tag: Tag;
  /** The name input; the dialog focuses it. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Shared with the dialog so closing is ignored while a rename runs. */
  busyRef: { current: boolean };
  onClose(): void;
  onRenamed(change: TagRename): void;
}

/**
 * The name input, the usage and merge lines and the buttons of the rename dialog.
 *
 * @param props the tag, the input and busy refs and the callbacks
 * @returns the form
 */
function RenameTagForm({ tag, inputRef, busyRef, onClose, onRenamed }: FormProps) {
  const [text, setText] = useState(tag.displayName);
  const source = useSourceUsage(tag.name, inputRef);
  const cleaned = cleanTagText(text);
  const normalized = normalizeTagName(text);
  const unchanged = cleaned === tag.displayName;
  // Another spelling of the same tag needs no lookup: it can never be a merge.
  const lookupName = normalized !== null && normalized !== tag.name ? normalized : '';
  const { target, retryLookup } = useTargetLookup(lookupName);
  const [busy, setBusy] = useState(false);
  /** The tag no longer exists: only closing is left. */
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } catch (failure) {
      setError(describeError(failure));
      if (failure instanceof ApiError && failure.code === 'not_found') setGone(true);
      if (failure instanceof ApiError && failure.code === 'invalid_operation') retryLookup();
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
            if (target !== null && 'failure' in target) retryLookup();
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
