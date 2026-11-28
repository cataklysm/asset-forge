import { Film } from 'lucide-react';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { formatBytes } from '../format';
import type { ViewHandle, ViewRestore, VirtualRows, VisibleRows } from '../hooks/useVirtualRows';
import { formatLabel } from '../media-url';
import { INBOX_LABEL, label, VIDEO_LABEL } from '../labels';
import type { PagedState } from '../paged-list';
import { FOCUS, MUTED } from '../ui';
import { CoverImage } from './CoverImage';
import type { MenuItem } from './Menu';

// The parts the grid and the table view of the file browser share: the picture, the meta line,
// the props and the pointer and keyboard handling of an item.

/**
 * The picture of a file: its thumbnail, its format label, or the import status while not complete.
 *
 * @param props the file and the classes of the frame
 * @returns the picture, with the film icon for a video
 */
export function FileFrame({ file, className }: { file: FileRecord; className: string }) {
  const plain = `flex items-center justify-center rounded bg-raised text-xs ${className}`;
  if (file.status !== 'complete') {
    return (
      <span className={`${plain} ${file.status === 'failed' ? 'text-danger' : MUTED}`} title={file.error ?? undefined}>
        {label(file.status)}
      </span>
    );
  }
  const picture = file.thumbnail ? (
    <CoverImage fileId={file.id} size="thumb" fallback={formatLabel(file.originalName)} className={className} />
  ) : (
    <span className={`${plain} ${MUTED}`}>{formatLabel(file.originalName)}</span>
  );
  if (file.kind !== 'video') return picture;
  return (
    <span className={`relative block ${className}`}>
      {picture}
      <VideoMark className="absolute bottom-2 left-2" />
    </span>
  );
}

/**
 * The film icon in a corner of a video's tile or film strip entry; named only for assistive technology and the tooltip.
 *
 * @param props the classes that place it
 * @returns the icon
 */
export function VideoMark({ className }: { className: string }) {
  return (
    <span role="img" aria-label={VIDEO_LABEL} title={VIDEO_LABEL} className={`flex rounded-control bg-surface/85 p-1 text-text ${className}`}>
      <Film size={16} aria-hidden />
    </span>
  );
}

/**
 * Where a trashed file came from: the name of its former asset, or the inbox.
 *
 * @param file the trashed file
 * @returns the asset name or the inbox label
 */
export function fileOrigin(file: FileRecord): string {
  return file.trashedAssetId === null ? INBOX_LABEL : (file.trashedAssetName ?? INBOX_LABEL);
}

/**
 * "Role · FORMAT · size" for asset files, "Origin · FORMAT · size" in the trash, "FORMAT | size"
 * where files have neither (the inbox).
 *
 * @param file the file
 * @param showRole whether the file belongs to an asset
 * @param showOrigin whether the file is in the trash
 * @returns the meta line
 */
export function fileMeta(file: FileRecord, showRole: boolean, showOrigin = false): string {
  const format = formatLabel(file.originalName);
  const size = formatBytes(file.sizeBytes);
  if (showOrigin) return [fileOrigin(file), format, size].join(' · ');
  if (!showRole) return `${format} | ${size}`;
  return [file.role === null ? null : label(file.role), format, size].filter((part) => part !== null).join(' · ');
}

/** Props shared by the grid and the table view of the file browser. */
export interface FileViewProps {
  /** The mounted view: the displayed list's key and the view kind. */
  viewKey: string;
  /** The displayed list's pages. */
  paged: PagedState<FileRecord>;
  /** The number of files in the list. */
  total: number;
  /** Where the view starts when it mounts. */
  restore: ViewRestore;
  /** Files belong to an asset: the role is shown. */
  showRole: boolean;
  /** Files in the trash: the deletion date and the origin are shown. */
  showOrigin: boolean;
  /** The asset's cover file, marked `Cover`; null without one. */
  coverFileId: string | null;
  /** The selected files by id. */
  selected: ReadonlyMap<string, FileRecord>;
  /** A click on an item, with Ctrl (or Meta) and Shift. */
  onClickItem(index: number, modifiers: { ctrl: boolean; shift: boolean }): void;
  /** Toggles an item's selection. */
  onToggle(index: number): void;
  /** Ctrl+A. */
  onSelectAll(): void;
  /** Clears the selection; false when there was nothing to clear. */
  onClear(): boolean;
  /** Opens a file in the viewer. */
  onOpen(file: FileRecord): void;
  /** The menu of a file. */
  menuItems(file: FileRecord): MenuItem[];
  /** Reports the rows in the viewport. */
  onRows(rows: VisibleRows): void;
  /** Loads a failed page again. */
  onRetry(page: number): void;
  /** The handle of the mounted view, for its scroll position. */
  positionRef: { current: ViewHandle | null };
  /** The Delete key on a focused item. */
  onDeleteKey?(): void;
}

/** Marks the controls inside an item (checkbox, menu, magnifier) whose events the item ignores. */
export const ITEM_CONTROL = { 'data-item-control': '' } as const;

/**
 * Whether an event came from a control inside the item.
 *
 * @param event the pointer event on the item
 * @returns true when its target lies in an ITEM_CONTROL of the item
 */
function fromControl(event: MouseEvent): boolean {
  const control = (event.target as Element).closest('[data-item-control]');
  return control !== null && event.currentTarget.contains(control);
}

/**
 * Whether a key was pressed without a modifier.
 *
 * @param event the key event
 * @returns true without Alt, Ctrl, Meta and Shift
 */
function plainKey(event: KeyboardEvent): boolean {
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

/**
 * Pointer and keyboard handling of one item of a file view: click, Ctrl+click and Shift+click
 * select, Space toggles, Ctrl+A selects all, Esc clears, Enter and double click open, Delete
 * calls `onDeleteKey` where the host offers it. Events
 * of the controls inside the item are left to them.
 *
 * @param props the view's props
 * @param rows the row windowing, which moves the focus
 * @param index the item's list index
 * @param file the item's file; null while it is not loaded
 * @returns the handlers to spread onto the item
 */
export function fileItemHandlers(props: FileViewProps, rows: VirtualRows, index: number, file: FileRecord | null) {
  return {
    onClick: (event: MouseEvent) => {
      if (file === null || fromControl(event)) return;
      props.onClickItem(index, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
    },
    onDoubleClick: (event: MouseEvent) => {
      if (file !== null && !fromControl(event)) props.onOpen(file);
    },
    onKeyDown: (event: KeyboardEvent) => onItemKey(event, props, rows, index, file),
    onFocus: () => rows.onItemFocus(index),
  };
}

/**
 * The keys of an item; keys of its inner controls are left to them, the rest moves the focus.
 *
 * @param event the key event
 * @param props the view's props
 * @param rows the row windowing, which moves the focus
 * @param index the item's list index
 * @param file the item's file; null while it is not loaded
 */
function onItemKey(event: KeyboardEvent, props: FileViewProps, rows: VirtualRows, index: number, file: FileRecord | null): void {
  if (event.target !== event.currentTarget) return;
  if (event.key === 'Enter' && plainKey(event)) {
    event.preventDefault();
    if (file !== null) props.onOpen(file);
    return;
  }
  if (event.key === ' ' && plainKey(event)) {
    event.preventDefault();
    if (file !== null) props.onToggle(index);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    props.onSelectAll();
    return;
  }
  if (event.key === 'Escape' && plainKey(event)) {
    if (props.onClear()) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  if (event.key === 'Delete' && plainKey(event) && props.onDeleteKey !== undefined) {
    event.preventDefault();
    props.onDeleteKey();
    return;
  }
  rows.onItemKeyDown(index, event);
}

/**
 * The selection checkbox of an item; reached by Space on the item, so not a tab stop of its own.
 *
 * @param props the file, its index, whether it is selected and the toggle
 * @returns the checkbox
 */
export function SelectBox({
  file,
  index,
  checked,
  onToggle,
}: {
  file: FileRecord;
  index: number;
  checked: boolean;
  onToggle(index: number): void;
}) {
  return (
    <input
      {...ITEM_CONTROL}
      type="checkbox"
      tabIndex={-1}
      aria-label={`Select ${file.originalName}`}
      checked={checked}
      onChange={(event) => {
        onToggle(index);
        // Keyboard handling stays with the item.
        event.currentTarget.closest<HTMLElement>('[data-index]')?.focus({ preventScroll: true });
      }}
      className={`h-4 w-4 accent-accent ${FOCUS}`}
    />
  );
}
