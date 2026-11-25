import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { FileRecord } from '@assetforge/contracts';

interface Selection {
  id: string;
  trigger: HTMLElement;
}

/**
 * Selection state of the file detail dialog. The dialog shows the live record from `items`, so it
 * closes when the file leaves the list. Focus goes back to the tile; when that tile is gone it
 * goes to the same file's new tile, the first tile, or `fallback`.
 */
export function useFileDetail(
  items: readonly FileRecord[] | null,
  container: RefObject<HTMLElement | null>,
  fallback: RefObject<HTMLElement | null>,
) {
  const [selected, setSelected] = useState<Selection | null>(null);
  const pendingFocus = useRef<Selection | null>(null);

  const select = useCallback(
    (file: FileRecord, trigger: HTMLElement) => setSelected({ id: file.id, trigger }),
    [],
  );
  const close = useCallback(() => {
    pendingFocus.current = selected;
    setSelected(null);
  }, [selected]);

  const file = selected === null ? null : (items?.find((f) => f.id === selected.id) ?? null);
  const gone = selected !== null && items !== null && file === null;

  useEffect(() => {
    if (gone) {
      pendingFocus.current = selected;
      setSelected(null);
    }
  }, [gone, selected]);

  // Runs after the dialog has unmounted and the tiles have been re-rendered.
  useEffect(() => {
    const target = pendingFocus.current;
    if (selected !== null || target === null) return;
    pendingFocus.current = null;
    if (target.trigger.isConnected) {
      target.trigger.focus();
      return;
    }
    const root = container.current;
    const tile =
      root?.querySelector<HTMLElement>(`[data-file-id="${target.id}"]`) ??
      root?.querySelector<HTMLElement>('[data-file-tile]');
    (tile ?? fallback.current)?.focus();
  }, [selected, items, container, fallback]);

  return { file, select, close };
}
