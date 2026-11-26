import { useEffect, useRef, useState, type RefObject } from 'react';
import type { FileRecord } from '@assetforge/contracts';

interface Opened {
  id: string;
  trigger: HTMLElement | null;
  /** The dialog moved on to this file; the file browser brings its tile back into view. */
  followed: boolean;
}

/**
 * The file detail dialog of a file browser host: the file it shows and the focus return after it
 * closes — the opener, else the same file's element (the list may have been reloaded while the
 * dialog was open), else the first tile inside `container`. Once the dialog moved on to another
 * file, the focus return targets that file's tile and the file browser reveals it, so the
 * first-tile fallback no longer applies.
 */
export function useFileDialog(container: RefObject<HTMLElement | null>) {
  const [file, setFile] = useState<FileRecord | null>(null);
  const opened = useRef<Opened | null>(null);
  const pendingFocus = useRef<Opened | null>(null);

  useEffect(() => {
    const target = pendingFocus.current;
    if (file !== null || target === null) return;
    pendingFocus.current = null;
    if (target.trigger?.isConnected) {
      target.trigger.focus();
      return;
    }
    const root = container.current;
    const element = root?.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(target.id)}"]`);
    if (element) {
      element.focus();
      return;
    }
    if (!target.followed) root?.querySelector<HTMLElement>('[data-file-tile]')?.focus();
  }, [file, container]);

  function open(next: FileRecord) {
    const active = document.activeElement;
    opened.current = { id: next.id, trigger: active instanceof HTMLElement ? active : null, followed: false };
    setFile(next);
  }

  /** Shows another file in the open dialog; the remembered opener no longer applies to it. */
  function show(next: FileRecord) {
    if (opened.current !== null && opened.current.id !== next.id) {
      opened.current = { id: next.id, trigger: null, followed: true };
    }
    setFile(next);
  }

  function close() {
    pendingFocus.current = opened.current;
    opened.current = null;
    setFile(null);
  }

  /** Shows `record` when the dialog shows the file with its id. */
  function update(record: FileRecord) {
    setFile((current) => (current?.id === record.id ? record : current));
  }

  /** Merges measured dimensions into the shown file when it has id `id`; other fields stay as they are. */
  function setDimensions(id: string, size: { width: number; height: number }) {
    setFile((current) => (current?.id === id ? { ...current, width: size.width, height: size.height } : current));
  }

  return { file, open, show, close, update, setDimensions };
}
