import { X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FileRecord, TagAssignment } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { fileMenuItems, type FileActionContext } from '../file-actions';
import { formatBytes, formatDateTime } from '../format';
import { label } from '../labels';
import { formatLabel } from '../media-url';
import { ALERT, BORDER, ICON_BUTTON, LABEL, MUTED } from '../ui';
import { Dialog } from './Dialog';
import { ImageStage, type ViewerControls } from './ImageStage';
import { Link } from './Link';
import { Menu } from './Menu';
import { TagList } from './TagList';
import { TagRow } from './TagRow';
import { ViewerToolbar } from './ViewerToolbar';

interface Props {
  file: FileRecord;
  /** `null` in the inbox. */
  asset: { id: string; name: string; tags: readonly TagAssignment[] } | null;
  /** Drives the "More" menu; its "Details" entry is not offered here. */
  actions: FileActionContext;
  /** Asset files: the role select. Inbox files: the assign control. */
  roleControl: ReactNode;
  /** Receives the updated file after `files:addTag` / `files:removeTag`. */
  onFileChange(file: FileRecord): void;
  /** Receives the file with its dimensions after `files:measure`; must not reload the list. */
  onMeasured(file: FileRecord): void;
  onOpenAsset?(assetId: string): void;
  onClose(): void;
}

export function FileDetailDialog({
  file,
  asset,
  actions,
  roleControl,
  onFileChange,
  onMeasured,
  onOpenAsset,
  onClose,
}: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [controls, setControls] = useState<ViewerControls | null>(null);

  const complete = file.status === 'complete';
  const viewable = complete && file.previewable;

  // Files imported before dimensions were stored are measured once when shown; failures are ignored.
  const measured = useRef(new Set<string>());
  const onMeasuredRef = useRef(onMeasured);
  onMeasuredRef.current = onMeasured;
  const unmeasured = viewable && file.width === null;
  useEffect(() => {
    if (!unmeasured || measured.current.has(file.id)) return;
    measured.current.add(file.id);
    call('files:measure', { fileId: file.id }).then(
      (record) => {
        if (record.width !== null && record.height !== null) onMeasuredRef.current(record);
      },
      () => {},
    );
  }, [file.id, unmeasured]);

  const title = asset === null ? file.originalName : `${file.originalName} | ${asset.name}`;
  const report = (message: string) => {
    setError(message);
    actions.onError?.(message);
  };
  // Cover and detach callers may be asynchronous; their failures show in the dialog.
  const guard = <A extends unknown[]>(action: ((...args: A) => unknown) | undefined) =>
    action === undefined
      ? undefined
      : (...args: A) => {
          setError(null);
          Promise.resolve()
            .then(() => action(...args))
            .catch((e: unknown) => report(describeError(e)));
        };
  const items = fileMenuItems(file, {
    ...actions,
    onSetCover: guard(actions.onSetCover),
    onDetach: guard(actions.onDetach),
    onError: report,
  }).filter((item) => item.label !== 'Details');

  async function changeTag(channel: 'files:addTag' | 'files:removeTag', name: string) {
    onFileChange(await call(channel, { fileId: file.id, name }));
  }

  return (
    <Dialog open title={title} onClose={onClose} initialFocusRef={closeRef} size="detail">
      <button
        ref={closeRef}
        type="button"
        aria-label="Close"
        title="Close"
        className={`${ICON_BUTTON} absolute right-4 top-4`}
        onClick={onClose}
      >
        <X size={18} aria-hidden />
      </button>
      <div className="flex h-full min-h-0 gap-5">
        <div className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto pr-1">
          <section aria-label="Details" className="space-y-2">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              <dt className={LABEL}>Name</dt>
              <dd className="break-all">{file.originalName}</dd>
              <dt className={LABEL}>Type</dt>
              <dd className="break-all">{file.mimeType}</dd>
              <dt className={LABEL}>Dimensions</dt>
              <dd>{file.width !== null && file.height !== null ? `${file.width} × ${file.height} px` : '–'}</dd>
              <dt className={LABEL}>Size</dt>
              <dd>{formatBytes(file.sizeBytes)}</dd>
              <dt className={LABEL}>Imported</dt>
              <dd>{formatDateTime(file.importedAt)}</dd>
              {!complete && (
                <>
                  <dt className={LABEL}>Status</dt>
                  <dd>{label(file.status)}</dd>
                </>
              )}
            </dl>
            {file.error !== null && (
              <p role="alert" className={ALERT}>
                {file.error}
              </p>
            )}
          </section>
          {roleControl}
          {complete && (
            <TagRow
              label="Image tags"
              kind="file"
              tags={file.tags}
              onAdd={(name) => changeTag('files:addTag', name)}
              onRemove={(name) => changeTag('files:removeTag', name)}
            />
          )}
          {asset !== null && (
            <>
              <hr className={`border-t ${BORDER}`} />
              <div className="space-y-2">
                <div>
                  <span className={LABEL}>Asset </span>
                  {onOpenAsset ? <Link onFollow={() => onOpenAsset(asset.id)}>{asset.name}</Link> : <span>{asset.name}</span>}
                </div>
                <TagList tags={asset.tags} kind="asset" max={Number.MAX_SAFE_INTEGER} />
              </div>
            </>
          )}
          {error !== null && (
            <p role="alert" className={ALERT}>
              {error}
            </p>
          )}
          <div>
            <Menu label="More" items={items} align="start" side="top" />
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {viewable ? (
            <>
              <div className="h-9 shrink-0">{controls !== null && <ViewerToolbar controls={controls} fullscreen={null} />}</div>
              <div className="min-h-0 flex-1">
                <ImageStage file={file} onControls={setControls} />
              </div>
            </>
          ) : (
            <div className={`flex h-full w-full items-center justify-center rounded-control bg-raised text-lg ${MUTED}`}>
              {complete ? formatLabel(file.originalName) : label(file.status)}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
