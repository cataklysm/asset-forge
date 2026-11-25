import type { FileRecord } from '@assetforge/contracts';
import { formatLabel } from '../media-url';
import { label } from '../labels';
import { BORDER, FOCUS, ITEM_HOVER, MUTED } from '../ui';
import { CoverImage } from './CoverImage';

interface Props {
  file: FileRecord;
  isCover: boolean;
  onSelect(file: FileRecord, trigger: HTMLElement): void;
}

/** One file as a tile: thumbnail, format label or import status, and the original name. */
export function FileTile({ file, isCover, onSelect }: Props) {
  const complete = file.status === 'complete';
  const frame = 'h-28 w-full';
  return (
    <button
      type="button"
      data-file-tile=""
      data-file-id={file.id}
      aria-haspopup="dialog"
      title={file.originalName}
      className={`flex min-w-0 flex-col gap-1 rounded border p-2 text-left text-sm ${BORDER} ${ITEM_HOVER} ${FOCUS}`}
      onClick={(e) => onSelect(file, e.currentTarget)}
    >
      {!complete ? (
        <span
          className={`flex items-center justify-center rounded bg-slate-100 text-xs dark:bg-slate-800 ${frame} ${
            file.status === 'failed' ? 'text-red-800 dark:text-red-300' : MUTED
          }`}
        >
          {label(file.status)}
        </span>
      ) : file.previewable ? (
        <CoverImage
          fileId={file.id}
          size="thumb"
          fallback={formatLabel(file.originalName)}
          className={frame}
        />
      ) : (
        <span
          className={`flex items-center justify-center rounded bg-slate-100 text-xs dark:bg-slate-800 ${frame} ${MUTED}`}
        >
          {formatLabel(file.originalName)}
        </span>
      )}
      <span className="truncate">{file.originalName}</span>
      {isCover && <span className={`text-xs font-medium ${MUTED}`}>Cover</span>}
    </button>
  );
}
