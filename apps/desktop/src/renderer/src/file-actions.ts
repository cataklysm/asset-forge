import type { FileRecord } from '@assetforge/contracts';
import { analysable } from './analysis';
import { call, describeError } from './api';
import type { MenuItem } from './components/Menu';
import type { StudioState } from './studio-context';
import {
  ANALYSE_LABEL,
  ANALYSE_TITLE,
  DELETE_LABEL,
  DELETE_TITLE,
  GENERATE_LABEL,
  GENERATE_TITLE,
  IMAGE_TO_PROMPT_LABEL,
  PURGE_LABEL,
  PURGE_TITLE,
  RESTORE_LABEL,
  RESTORE_TITLE,
  IMAGE_TO_PROMPT_TITLE,
  REVIEW_TAGS_LABEL,
  REVIEW_TAGS_TITLE,
  UPSCALE_TITLE,
  upscaleLabel,
} from './labels';

// The "…" menu of one file: which actions a file offers where, in a fixed order.

/**
 * Whether a file shows the proposal marker: only outside the trash, where Review tags is offered.
 *
 * @param file the file
 * @returns true when the file has a proposal and is not in the trash
 */
export function showsProposal(file: FileRecord): boolean {
  return file.hasProposal && file.deletedAt === null;
}

/** What the host of a file menu offers. */
export interface FileActionContext {
  /** The file's cover state within its asset; null where there is no asset (the inbox). */
  cover: { isEffective: boolean; isChosen: boolean } | null;
  /** Opens the file detail dialog; Details is offered only with it (the dialog itself has none). */
  onDetails?(): void;
  /** A file id makes it the chosen cover, null returns to the automatic cover. */
  onSetCover?(fileId: string | null): void;
  /** Moves the file out of its asset into the inbox. */
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
  /** Moves a live file to the trash; offered for every status except `pending`. */
  onDelete?(): void;
  /** Puts a trashed file back; offered only for files in the trash. */
  onRestore?(): void;
  /** Removes a trashed file from disk; offered only for files in the trash. */
  onPurge?(): void;
  /** Offers Generate from image and the upscales for a complete previewable file; disabled with its `blocked` as tooltip. */
  studio?: StudioState;
  /** True while another action of the host runs behind the same guard: the cover, Detach and Delete items are disabled. */
  actionBusy?: boolean;
}

/**
 * A menu item that is disabled with the reason as its tooltip while something blocks it.
 *
 * @param blocked why the action cannot be used; null when it can
 * @param label the item's label
 * @param title the item's tooltip while it can be used
 * @param onSelect the action
 * @returns the item
 */
function blockable(blocked: string | null, label: string, title: string, onSelect: () => void): MenuItem {
  return blocked === null ? { label, title, onSelect } : { label, title: blocked, disabled: true, onSelect };
}

/**
 * Analyse, Review tags (with a proposal) and Image to prompt, for an analysable image.
 *
 * @param file the file
 * @param context what the host offers
 * @returns the items; none for another file
 */
function analysisItems(file: FileRecord, context: FileActionContext): MenuItem[] {
  const items: MenuItem[] = [];
  if (!analysable(file)) return items;
  const { onAnalyse, onReviewTags, onImageToPrompt } = context;
  const blocked = context.analysisBlocked ?? null;
  if (onAnalyse !== undefined) items.push(blockable(blocked, ANALYSE_LABEL, ANALYSE_TITLE, onAnalyse));
  if (onReviewTags !== undefined && file.hasProposal) {
    items.push({ label: REVIEW_TAGS_LABEL, title: REVIEW_TAGS_TITLE, onSelect: onReviewTags });
  }
  if (onImageToPrompt !== undefined)
    items.push(blockable(blocked, IMAGE_TO_PROMPT_LABEL, IMAGE_TO_PROMPT_TITLE, onImageToPrompt));
  return items;
}

/**
 * Generate from image and the two upscales, for a complete previewable file.
 *
 * @param file the file
 * @param context what the host offers
 * @returns the items; none without the studio or for another file
 */
function studioItems(file: FileRecord, context: FileActionContext): MenuItem[] {
  const { studio } = context;
  if (studio === undefined || file.status !== 'complete' || !file.previewable) return [];
  const items = [blockable(studio.blocked, GENERATE_LABEL, GENERATE_TITLE, () => studio.open(file))];
  for (const scale of [2, 4] as const) {
    items.push(
      blockable(studio.blocked, upscaleLabel(scale), UPSCALE_TITLE, () => {
        studio.upscale(file, scale).catch((error: unknown) => context.onError?.(describeError(error)));
      }),
    );
  }
  return items;
}

/**
 * Use automatic cover for the chosen cover, otherwise Use as cover for a complete file with a thumbnail.
 *
 * @param file the file
 * @param context what the host offers
 * @returns the item; none outside an asset
 */
function coverItems(file: FileRecord, context: FileActionContext): MenuItem[] {
  const { cover, onSetCover } = context;
  if (cover === null || onSetCover === undefined) return [];
  const disabled = busyFlag(context);
  if (cover.isChosen)
    return [
      {
        label: 'Use automatic cover',
        title: 'Return to the first image as the cover',
        onSelect: () => onSetCover(null),
        ...disabled,
      },
    ];
  if (file.status !== 'complete' || !file.thumbnail) return [];
  const title = file.kind === 'video' ? 'Show this video as the asset cover' : 'Show this image as the asset cover';
  return [{ label: 'Use as cover', title, onSelect: () => onSetCover(file.id), ...disabled }];
}

/**
 * The disabled flag of an item behind the host's guard while another action runs.
 *
 * @param context what the host offers
 * @returns `{ disabled: true }` while the host is busy, else nothing
 */
function busyFlag(context: FileActionContext): { disabled?: true } {
  return context.actionBusy === true ? { disabled: true } : {};
}

/**
 * The actions of one file's "…" menu. Details comes first wherever the host offers it. A trashed file offers only
 * Restore and Delete permanently besides it. A live file offers Open externally and Show in folder for completely
 * imported files (opening only when the type may be opened); Analyse, Review tags (with a proposal) and Image to
 * prompt for analysable images when the host offers them; Generate from image and the upscales for complete
 * previewable files when the host offers the studio; the cover choice where the file belongs to an asset; Detach
 * when the host offers it; Delete last.
 *
 * @param file the file
 * @param context what the host offers
 * @returns the menu's items in order
 */
export function fileMenuItems(file: FileRecord, context: FileActionContext): MenuItem[] {
  const complete = file.status === 'complete';
  const shell = (channel: 'files:openExternal' | 'files:showInFolder') => () => {
    call(channel, { fileId: file.id }).catch((error: unknown) => context.onError?.(describeError(error)));
  };
  const items: MenuItem[] = context.onDetails === undefined ? [] : [{ label: 'Details', onSelect: context.onDetails }];
  if (file.deletedAt !== null) {
    if (context.onRestore !== undefined)
      items.push({ label: RESTORE_LABEL, title: RESTORE_TITLE, onSelect: context.onRestore });
    if (context.onPurge !== undefined)
      items.push({ label: PURGE_LABEL, title: PURGE_TITLE, onSelect: context.onPurge });
    return items;
  }
  if (complete && file.openable) items.push({ label: 'Open externally', onSelect: shell('files:openExternal') });
  if (complete) items.push({ label: 'Show in folder', onSelect: shell('files:showInFolder') });
  items.push(...analysisItems(file, context), ...studioItems(file, context), ...coverItems(file, context));
  const disabled = busyFlag(context);
  if (context.onDetach !== undefined)
    items.push({
      label: 'Detach',
      title: 'The file is kept and moves to the inbox',
      onSelect: context.onDetach,
      ...disabled,
    });
  if (context.onDelete !== undefined && file.status !== 'pending') {
    items.push({ label: DELETE_LABEL, title: DELETE_TITLE, onSelect: context.onDelete, ...disabled });
  }
  return items;
}
