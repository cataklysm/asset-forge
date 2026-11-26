import type { FileRecord } from '@assetforge/contracts';
import { analysable } from './analysis';
import { call, describeError } from './api';
import type { MenuItem } from './components/Menu';

export interface FileActionContext {
  /** The file's cover state within its asset; null where there is no asset (the inbox). */
  cover: { isEffective: boolean; isChosen: boolean } | null;
  onDetails(): void;
  /** A file id makes it the chosen cover, null returns to the automatic cover. */
  onSetCover?(fileId: string | null): void;
  onDetach?(): void;
  /** Enqueues an analysis of the file; offered only for analysable images. */
  onAnalyse?(): void;
  /** Receives the message when opening or revealing the file fails. */
  onError?(message: string): void;
}

/**
 * The actions of one file's "…" menu: Details; Open externally and Show in folder for completely
 * imported files (opening only when the type may be opened); Analyse for analysable images when
 * the host offers it; the cover choice where the file
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
  const { cover, onSetCover, onDetach, onAnalyse } = ctx;
  if (onAnalyse !== undefined && analysable(file)) {
    items.push({ label: 'Analyse', title: 'Tag this image with the vision model', onSelect: onAnalyse });
  }
  if (cover !== null && onSetCover !== undefined) {
    if (cover.isChosen) items.push({ label: 'Use automatic cover', title: 'Return to the first image as the cover', onSelect: () => onSetCover(null) });
    else if (complete && file.previewable) items.push({ label: 'Use as cover', title: 'Show this image as the asset cover', onSelect: () => onSetCover(file.id) });
  }
  if (onDetach !== undefined) items.push({ label: 'Detach', title: 'The file is kept and moves to the inbox', onSelect: onDetach });
  return items;
}
