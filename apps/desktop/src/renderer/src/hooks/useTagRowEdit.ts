import { cleanTagText, normalizeTagName } from '@assetforge/contracts';
import { useRef, useState, type RefObject } from 'react';
import { describeError } from '../api';
import { INVALID_TAG } from '../labels';
import type { PendingFocus } from './useTagRowFocus';

export { INVALID_TAG } from '../labels';

/** What `useTagRowEdit` hands to the row. */
interface TagRowEdit {
  /** The typed text. */
  text: string;
  setText(text: string): void;
  /** The message of the last failed add or remove. */
  error: string | null;
  setError(error: string | null): void;
  /** Adds the typed tag unless it is empty; an invalid name shows `INVALID_TAG`. */
  add(value: string): Promise<void>;
  /** Removes one tag unless a remove runs; focus moves on once it is gone. */
  remove(name: string, index: number): Promise<void>;
}

/**
 * The input text, the error and the add and remove of a tag row.
 *
 * @param onAdd adds a tag by display name
 * @param onRemove removes a tag by name
 * @param pendingFocus set before a remove so the row can move the focus once the chip is gone
 * @returns the text, the error and the two actions
 */
export function useTagRowEdit(
  onAdd: (displayName: string) => Promise<void>,
  onRemove: (name: string) => Promise<void>,
  pendingFocus: RefObject<PendingFocus | null>,
): TagRowEdit {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const removing = useRef(false);

  async function add(value: string) {
    if (cleanTagText(value) === '') return;
    if (normalizeTagName(value) === null) {
      setError(INVALID_TAG);
      return;
    }
    setError(null);
    try {
      await onAdd(cleanTagText(value));
      setText('');
    } catch (failure) {
      setError(describeError(failure));
    }
  }

  async function remove(name: string, index: number) {
    if (removing.current) return;
    removing.current = true;
    setError(null);
    pendingFocus.current = { name, index };
    try {
      await onRemove(name);
    } catch (failure) {
      pendingFocus.current = null;
      setError(describeError(failure));
    } finally {
      removing.current = false;
    }
  }

  return { text, setText, error, setError, add, remove };
}
