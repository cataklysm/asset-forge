import type { FileRecord } from '@assetforge/contracts';
import { analysable } from './analysis';
import { call, describeError } from './api';
import type { MenuItem } from './components/Menu';
import {
  ANALYSE_LABEL,
  ANALYSE_TITLE,
  IMAGE_TO_PROMPT_LABEL,
  IMAGE_TO_PROMPT_TITLE,
  REVIEW_TAGS_LABEL,
  REVIEW_TAGS_TITLE,
} from './labels';

export interface FileActionContext {
  /** The file's cover state within its asset; null where there is no asset (the inbox). */
  cover: { isEffective: boolean; isChosen: boolean } | null;
  onDetails(): void;
  /** A file id makes it the chosen cover, null returns to the automatic cover. */
  onSetCover?(fileId: string | null): void;
  onDetach?(): void;
  /** Opens the single-image analysis; offered only for analysable images. */
  onAnalyse?(): void;
  /** Opens the proposal of the file; offered only when it has one. */
  onReviewTags?(): void;
  /** Opens Image2Prompt for the file; offered only for analysable images. */
  onImageToPrompt?(): void;
  /** Why the provider cannot be used (e.g. not configured): Analyse and Image to prompt are disabled with it as tooltip. */
  analysisBlocked?: string | null;
  /** Receives the message when opening or revealing the file fails. */
  onError?(message: string): void;
}

/**
 * The actions of one file's "…" menu: Details; Open externally and Show in folder for completely
 * imported files (opening only when the type may be opened); Analyse, Review tags (with a
 * proposal) and Image to prompt for analysable images when the host offers them; the cover choice
 * where the file belongs to an asset; Detach when the host offers it.
 */
export function fileMenuItems(file: FileRecord, ctx: FileActionContext): MenuItem[] {
  const complete = file.status === 'complete';
  const shell = (channel: 'files:openExternal' | 'files:showInFolder') => () => {
    call(channel, { fileId: file.id }).catch((error: unknown) => ctx.onError?.(describeError(error)));
  };
  const items: MenuItem[] = [{ label: 'Details', onSelect: ctx.onDetails }];
  if (complete && file.openable) items.push({ label: 'Open externally', onSelect: shell('files:openExternal') });
  if (complete) items.push({ label: 'Show in folder', onSelect: shell('files:showInFolder') });
  const { cover, onSetCover, onDetach, onAnalyse, onReviewTags, onImageToPrompt } = ctx;
  const blocked = ctx.analysisBlocked ?? null;
  const provider = (label: string, title: string, onSelect: () => void): MenuItem =>
    blocked === null ? { label, title, onSelect } : { label, title: blocked, disabled: true, onSelect };
  if (analysable(file)) {
    if (onAnalyse !== undefined) items.push(provider(ANALYSE_LABEL, ANALYSE_TITLE, onAnalyse));
    if (onReviewTags !== undefined && file.hasProposal) {
      items.push({ label: REVIEW_TAGS_LABEL, title: REVIEW_TAGS_TITLE, onSelect: onReviewTags });
    }
    if (onImageToPrompt !== undefined) items.push(provider(IMAGE_TO_PROMPT_LABEL, IMAGE_TO_PROMPT_TITLE, onImageToPrompt));
  }
  if (cover !== null && onSetCover !== undefined) {
    if (cover.isChosen) items.push({ label: 'Use automatic cover', title: 'Return to the first image as the cover', onSelect: () => onSetCover(null) });
    else if (complete && file.previewable) items.push({ label: 'Use as cover', title: 'Show this image as the asset cover', onSelect: () => onSetCover(file.id) });
  }
  if (onDetach !== undefined) items.push({ label: 'Detach', title: 'The file is kept and moves to the inbox', onSelect: onDetach });
  return items;
}
