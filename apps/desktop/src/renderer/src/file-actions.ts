import type { FileRecord } from '@assetforge/contracts';
import { call, describeError } from './api';
import type { MenuItem } from './components/Menu';

export interface FileActionContext {
  /** The file's cover state within its asset; null where there is no asset (the inbox). */
  cover: { isEffective: boolean; isChosen: boolean } | null;
  onDetails(): void;
  /** A file id makes it the chosen cover, null returns to the automatic cover. */
  onSetCover?(fileId: string | null): void;
  onDetach?(): void;
  /** Receives the message when opening or revealing the file fails. */
  onError?(message: string): void;
}

/**
 * The actions of one file's "…" menu: Details; Open externally and Show in folder for completely
 * imported files (opening only when the type may be opened); the cover choice where the file
 * belongs to an asset; Detach when the host offers it.
 */
export function fileMenuItems(file: FileRecord, ctx: FileActionContext): MenuItem[] {
  const complete = file.status === 'complete';
  const shell = (channel: 'files:openExternal' | 'files:showInFolder') => () => {
    call(channel, { fileId: file.id }).catch((error: unknown) => ctx.onError?.(describeError(error)));
  };
  const items: MenuItem[] = [{ label: 'Details', onSelect: ctx.onDetails }];
  if (complete && file.openable) items.push({ label: 'Open externally', onSelect: shell('files:openExternal') });
  if (complete) items.push({ label: 'Show in folder', onSelect: shell('files:showInFolder') });
  const { cover, onSetCover, onDetach } = ctx;
  if (cover !== null && onSetCover !== undefined) {
    if (cover.isChosen) items.push({ label: 'Use automatic cover', onSelect: () => onSetCover(null) });
    else if (complete && file.previewable) items.push({ label: 'Use as cover', onSelect: () => onSetCover(file.id) });
  }
  if (onDetach !== undefined) items.push({ label: 'Detach', onSelect: onDetach });
  return items;
}
