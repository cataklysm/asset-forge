import { useEffect, useRef, type RefObject } from 'react';
import type { TagAssignment } from '@assetforge/contracts';
import type { TagRename } from '../tag-rename';

/** The chip being removed and its index, so that focus can move once it is gone. */
export interface PendingFocus {
  name: string;
  index: number;
}

/** What `useTagRowFocus` hands to the row. */
interface TagRowFocus {
  /** Set before a remove; cleared when it fails or once focus moved. */
  pendingFocus: RefObject<PendingFocus | null>;
  /** A finished rename started from a pencil of this row, until its chip has focus again. */
  renamedFocus: RefObject<TagRename | null>;
}

/**
 * The remove buttons of the chips of a tag row, in order.
 *
 * @param row the row element, or null before it mounted
 * @returns the buttons
 */
export function chipRemoveButtons(row: HTMLElement | null): HTMLButtonElement[] {
  return [...(row?.querySelectorAll<HTMLButtonElement>('[data-chip] button[data-remove]') ?? [])];
}

/**
 * Moves the focus once a removed or renamed chip is gone: to the renamed chip's pencil, else to the
 * neighbouring remove button, else to the input.
 *
 * @param tags the tags of the row
 * @param rowRef the row element
 * @param input the input of the row
 * @returns the refs the row sets before a remove or after a rename
 */
export function useTagRowFocus(
  tags: readonly TagAssignment[],
  rowRef: RefObject<HTMLDivElement | null>,
  input: RefObject<HTMLInputElement | null>,
): TagRowFocus {
  const pendingFocus = useRef<PendingFocus | null>(null);
  const renamedFocus = useRef<TagRename | null>(null);

  useEffect(() => {
    const renamed = renamedFocus.current;
    // The chip of the old name unmounts once the rename reaches the row; focus moves to the new one.
    if (renamed !== null && !tags.some((tag) => tag.name === renamed.from)) {
      renamedFocus.current = null;
      const index = tags.findIndex((tag) => tag.name === renamed.name);
      const chip = index < 0 ? undefined : rowRef.current?.querySelectorAll('[data-chip]')[index];
      (chip?.querySelector<HTMLButtonElement>('button[data-rename]') ?? input.current)?.focus();
    }
    const pending = pendingFocus.current;
    if (pending === null || tags.some((tag) => tag.name === pending.name)) return;
    pendingFocus.current = null;
    const buttons = chipRemoveButtons(rowRef.current);
    (buttons[pending.index] ?? buttons[pending.index - 1] ?? input.current)?.focus();
  }, [tags]);

  return { pendingFocus, renamedFocus };
}
