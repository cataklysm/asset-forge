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

/** The picture of a file: its thumbnail, its format label, or the import status while not complete. */
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

/** The film icon in a corner of a video's tile or film strip entry; named only for assistive technology and the tooltip. */
export function VideoMark({ className }: { className: string }) {
  return (
    <span role="img" aria-label={VIDEO_LABEL} title={VIDEO_LABEL} className={`flex rounded-control bg-surface/85 p-1 text-text ${className}`}>
      <Film size={16} aria-hidden />
    </span>
  );
}

/** Where a trashed file came from: the name of its former asset, or the inbox. */
export function fileOrigin(file: FileRecord): string {
  return file.trashedAssetId === null ? INBOX_LABEL : (file.trashedAssetName ?? INBOX_LABEL);
}

/**
 * "Role · FORMAT · size" for asset files, "Origin · FORMAT · size" in the trash, "FORMAT | size"
 * where files have neither (the inbox).
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
  viewKey: string;
  paged: PagedState<FileRecord>;
  total: number;
  restore: ViewRestore;
  /** Files belong to an asset: the role is shown. */
  showRole: boolean;
  /** Files in the trash: the deletion date and the origin are shown. */
  showOrigin: boolean;
  coverFileId: string | null;
  selected: ReadonlyMap<string, FileRecord>;
  onClickItem(index: number, mods: { ctrl: boolean; shift: boolean }): void;
  onToggle(index: number): void;
  onSelectAll(): void;
  /** Clears the selection; false when there was nothing to clear. */
  onClear(): boolean;
  onOpen(file: FileRecord): void;
  menuItems(file: FileRecord): MenuItem[];
  onRows(rows: VisibleRows): void;
  onRetry(page: number): void;
  positionRef: { current: ViewHandle | null };
  /** The Delete key on a focused item. */
  onDeleteKey?(): void;
}

/** Marks the controls inside an item (checkbox, menu, magnifier) whose events the item ignores. */
export const ITEM_CONTROL = { 'data-item-control': '' } as const;

function fromControl(event: MouseEvent): boolean {
  const control = (event.target as Element).closest('[data-item-control]');
  return control !== null && event.currentTarget.contains(control);
}

function plainKey(event: KeyboardEvent): boolean {
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

/**
 * Pointer and keyboard handling of one item of a file view: click, Ctrl+click and Shift+click
 * select, Space toggles, Ctrl+A selects all, Esc clears, Enter and double click open, Delete
 * calls `onDeleteKey` where the host offers it. Events
 * of the controls inside the item are left to them.
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
    onKeyDown: (event: KeyboardEvent) => {
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
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'a'
      ) {
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
    },
    onFocus: () => rows.onItemFocus(index),
  };
}

/** The selection checkbox of an item; reached by Space on the item, so not a tab stop of its own. */
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
