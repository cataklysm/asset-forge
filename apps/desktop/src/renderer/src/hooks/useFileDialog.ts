import { useEffect, useRef, useState, type RefObject } from 'react';
import type { FileRecord } from '@assetforge/contracts';

interface Opened {
  id: string;
  trigger: HTMLElement | null;
}

/**
 * The file detail dialog of a file browser host: the file it shows and the focus return after it
 * closes — the opener, else the same file's element (the list may have been reloaded while the
 * dialog was open), else the first tile inside `container`.
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
    const element =
      root?.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(target.id)}"]`) ??
      root?.querySelector<HTMLElement>('[data-file-tile]');
    element?.focus();
  }, [file, container]);

  function open(next: FileRecord) {
    const active = document.activeElement;
    opened.current = { id: next.id, trigger: active instanceof HTMLElement ? active : null };
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

  /** The id of the file the dialog shows; read synchronously, e.g. right after an action. */
  const openId = () => opened.current?.id ?? null;

  return { file, open, close, update, openId };
}
