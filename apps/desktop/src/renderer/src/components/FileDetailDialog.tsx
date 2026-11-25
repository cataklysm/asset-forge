import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { formatBytes, formatDateTime } from '../format';
import { label } from '../labels';
import { formatLabel } from '../media-url';
import { ALERT, BORDER, BUTTON, MUTED } from '../ui';
import { CoverImage } from './CoverImage';

interface Props {
  file: FileRecord;
  /** `null` in the inbox: no cover actions. */
  cover: { coverFileId: string | null; coverIsChosen: boolean } | null;
  onSetCover?(fileId: string | null): Promise<void>;
  extraControls?: ReactNode;
  onClose(): void;
}

export function FileDetailDialog({ file, cover, onSetCover, extraControls, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const complete = file.status === 'complete';
  const isChosenCover = cover !== null && cover.coverIsChosen && cover.coverFileId === file.id;
  const frame = 'h-72 w-full';

  return (
    <dialog
      ref={ref}
      aria-label={file.originalName}
      onClose={onClose}
      className={`m-auto w-[min(92vw,44rem)] rounded border bg-white p-4 text-slate-900 backdrop:bg-black/50 dark:bg-slate-900 dark:text-slate-100 ${BORDER}`}
    >
      <div className="space-y-3">
        {complete && file.previewable ? (
          <CoverImage
            fileId={file.id}
            size="detail"
            fallback={formatLabel(file.originalName)}
            className={frame}
          />
        ) : (
          <div
            className={`flex items-center justify-center rounded bg-slate-100 text-lg dark:bg-slate-800 ${frame} ${MUTED}`}
          >
            {complete ? formatLabel(file.originalName) : label(file.status)}
          </div>
        )}
        <h2 className="break-all text-lg font-semibold">{file.originalName}</h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className={MUTED}>Role</dt>
          <dd>{file.role === null ? '–' : label(file.role)}</dd>
          <dt className={MUTED}>Size</dt>
          <dd>{formatBytes(file.sizeBytes)}</dd>
          <dt className={MUTED}>Imported</dt>
          <dd>{formatDateTime(file.importedAt)}</dd>
          {!complete && (
            <>
              <dt className={MUTED}>Status</dt>
              <dd>{label(file.status)}</dd>
            </>
          )}
        </dl>
        {file.error !== null && (
          <p role="alert" className={ALERT}>
            {file.error}
          </p>
        )}
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {file.openable && (
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => void act(() => call('files:openExternal', { fileId: file.id }))}
            >
              Open externally
            </button>
          )}
          {complete && (
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => void act(() => call('files:showInFolder', { fileId: file.id }))}
            >
              Show in folder
            </button>
          )}
          {cover !== null && onSetCover !== undefined && complete && file.previewable && (
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              title={
                isChosenCover
                  ? 'Return to the first image as the cover'
                  : 'Show this image as the asset cover'
              }
              onClick={() => void act(() => onSetCover(isChosenCover ? null : file.id))}
            >
              {isChosenCover ? 'Use automatic cover' : 'Use as cover'}
            </button>
          )}
          {extraControls}
          <button
            type="button"
            className={`${BUTTON} ml-auto`}
            onClick={() => ref.current?.close()}
          >
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
