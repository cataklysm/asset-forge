import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FileRecord, TagAssignment } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { fileMenuItems, type FileActionContext } from '../file-actions';
import { formatBytes, formatDateTime, formatDuration } from '../format';
import { DELETED_LABEL, DURATION_LABEL, label, ORIGIN_LABEL } from '../labels';
import { formatLabel } from '../media-url';
import { ALERT, BORDER, ICON_BUTTON, LABEL, MUTED, PANEL_TITLE, SECTION_TITLE } from '../ui';
import { useViewerKeys } from '../hooks/useViewerKeys';
import { Dialog } from './Dialog';
import { FilmStrip } from './FilmStrip';
import { FileOrigins } from './FileOrigins';
import { fileOrigin } from './FileTile';
import { GenerationDetails } from './GenerationDetails';
import type { ViewerList } from './FileBrowser';
import { ImageStage, type ViewerControls } from './ImageStage';
import { Link } from './Link';
import { Menu } from './Menu';
import { ProposalMarker } from './ProposalMarker';
import { TagList } from './TagList';
import { TagRow } from './TagRow';
import { VideoStage, videoControls } from './VideoStage';
import { ViewerToolbar } from './ViewerToolbar';

interface Props {
  file: FileRecord;
  /** `null` in the inbox. */
  asset: { id: string; name: string; tags: readonly TagAssignment[] } | null;
  /** Drives the "More" menu; its "Details" entry is not offered here. */
  actions: FileActionContext;
  /** Asset files: the role select. Inbox files: the assign control. Not shown for a trashed file; null shows no section. */
  roleControl: ReactNode;
  /** Receives the updated file after `files:addTag` / `files:removeTag`. */
  onFileChange(file: FileRecord): void;
  /**
   * Receives the dimensions (and for a video the duration) `files:measure` found for the file with
   * id `fileId`; merges only them into the shown record and must not reload the list.
   */
  onMeasured(fileId: string, size: Measured): void;
  onOpenAsset?(assetId: string): void;
  /** The list of the file browser the dialog was opened from; steps through it. */
  list: ViewerList | null;
  onClose(): void;
}

interface Dimensions {
  width: number;
  height: number;
}

/** What a measurement adds to the record: the dimensions, for a video also the duration. */
export type Measured = Dimensions & { durationMs?: number | null };

export function FileDetailDialog({
  file: given,
  asset,
  actions,
  roleControl,
  onFileChange,
  onMeasured,
  onOpenAsset,
  list,
  onClose,
}: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Files imported before dimensions were stored are measured once per dialog. The result is
  // remembered, so a record without dimensions (the list's, when the viewer steps back to the file)
  // shows it at once; failed measurements are not repeated and show nothing.
  const measured = useRef(new Map<string, Measured | 'pending' | 'failed'>());
  const remembered = measured.current.get(given.id);
  const file = given.width === null && typeof remembered === 'object' ? { ...given, ...remembered } : given;
  // Error and viewer controls belong to the file they came from; stepping on leaves them behind.
  const [failure, setFailure] = useState<{ fileId: string; message: string } | null>(null);
  const [stage, setStage] = useState<{ fileId: string; controls: ViewerControls } | null>(null);
  const error = failure?.fileId === file.id ? failure.message : null;
  const controls = stage?.fileId === file.id ? stage.controls : null;
  const fileId = file.id;
  const setError = (message: string | null) => setFailure(message === null ? null : { fileId, message });
  const setControls = (next: ViewerControls) => setStage({ fileId, controls: next });

  const complete = file.status === 'complete';
  // A file in the trash: read-only, without a role or assign control.
  const trashed = file.deletedAt !== null;
  const viewable = complete && file.previewable;
  // A video plays in the video stage; its toolbar has only the fullscreen button.
  const playable = complete && file.kind === 'video';
  const staged = viewable || playable;

  const onMeasuredRef = useRef(onMeasured);
  onMeasuredRef.current = onMeasured;
  const unmeasured = staged && file.width === null;
  useEffect(() => {
    if (!unmeasured || measured.current.has(fileId)) return;
    const results = measured.current;
    results.set(fileId, 'pending');
    call('files:measure', { fileId }).then(
      (record) => {
        if (record.width === null || record.height === null) {
          results.set(fileId, 'failed');
          return;
        }
        const size: Measured =
          record.kind === 'video'
            ? { width: record.width, height: record.height, durationMs: record.durationMs }
            : { width: record.width, height: record.height };
        results.set(fileId, size);
        onMeasuredRef.current(fileId, size);
      },
      () => results.set(fileId, 'failed'),
    );
  }, [fileId, unmeasured]);

  // Fullscreen shows the toolbar and the stage; the state follows the browser's event.
  const rootRef = useRef<HTMLDivElement>(null);
  const stageBox = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === stageBox.current && stageBox.current !== null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      Promise.resolve(document.exitFullscreen?.()).catch(() => {});
      return;
    }
    try {
      Promise.resolve(stageBox.current?.requestFullscreen?.()).catch(() => {});
    } catch {
      // Fullscreen is refused; the button stays unpressed.
    }
  };
  // Esc and Close leave fullscreen first.
  const close = () => {
    if (document.fullscreenElement) {
      Promise.resolve(document.exitFullscreen?.()).catch(() => {});
      return;
    }
    onClose();
  };
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const video = playable ? videoControls(videoRef) : null;
  useViewerKeys(rootRef, {
    previous: () => list?.show(list.index - 1),
    next: () => list?.show(list.index + 1),
    zoomIn: () => controls?.zoomIn(),
    zoomOut: () => controls?.zoomOut(),
    fit: () => controls?.fit(),
    actual: () => controls?.actual(),
    rotate: () => controls?.rotate(),
    fullscreen: () => {
      if (controls !== null || playable) toggleFullscreen();
    },
    ...(video === null ? {} : { seek: video.seek, togglePlayback: video.togglePlayback }),
  });

  const title = asset === null ? file.originalName : `${file.originalName} | ${asset.name}`;
  const report = (message: string) => {
    setError(message);
    actions.onError?.(message);
  };
  // Cover, detach and trash callers may be asynchronous; their failures show in the dialog.
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
    onDelete: guard(actions.onDelete),
    onRestore: guard(actions.onRestore),
    onPurge: guard(actions.onPurge),
    onError: report,
  }).filter((item) => item.label !== 'Details');

  // The same action and rule as Open externally in the More menu.
  const canOpenExternally = complete && file.openable && !trashed;
  const openExternally = () => {
    setError(null);
    call('files:openExternal', { fileId: file.id }).catch((e: unknown) => report(describeError(e)));
  };

  async function changeTag(channel: 'files:addTag' | 'files:removeTag', name: string) {
    onFileChange(await call(channel, { fileId: file.id, name }));
  }

  const image = file.kind === 'image';
  const tagsLabel = image ? 'Image tags' : 'File tags';
  const browsing = list !== null && list.total >= 2 ? list : null;
  // The header pair and the on-stage pair: same behaviour and tooltips, distinct accessible names.
  const step = (direction: -1 | 1, look: { className: string; name?: string }) =>
    list === null ? null : (
      <button
        type="button"
        aria-label={look.name ?? (direction < 0 ? 'Previous file (←)' : 'Next file (→)')}
        title={direction < 0 ? 'Previous file (←)' : 'Next file (→)'}
        className={look.className}
        disabled={direction < 0 ? list.index <= 0 : list.index >= list.total - 1}
        onClick={() => list.show(list.index + direction)}
      >
        {direction < 0 ? <ChevronLeft size={18} aria-hidden /> : <ChevronRight size={18} aria-hidden />}
      </button>
    );

  return (
    <Dialog open title={title} onClose={close} initialFocusRef={closeRef} size="detail">
      <div ref={rootRef} className="flex h-full flex-col">
        <header className={`flex shrink-0 items-center gap-4 border-b py-3 pl-5 pr-4 ${BORDER}`}>
          <h2 title={title} aria-label={title} className={`${SECTION_TITLE} flex min-w-0 flex-1 items-center gap-3`}>
            <span className="truncate">{file.originalName}</span>
            {file.hasProposal && <ProposalMarker />}
            {asset !== null && (
              <>
                <span aria-hidden className={`h-5 shrink-0 border-l ${BORDER}`} />
                <span className="truncate font-normal">{asset.name}</span>
              </>
            )}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {list !== null && (
              <>
                <span className={`mr-2 text-sm tabular-nums ${MUTED}`}>
                  {list.index + 1} / {list.total}
                </span>
                {step(-1, { className: ICON_BUTTON })}
                {step(1, { className: ICON_BUTTON })}
              </>
            )}
            <button ref={closeRef} type="button" aria-label="Close" title="Close" className={`ml-2 ${ICON_BUTTON}`} onClick={close}>
              <X size={18} aria-hidden />
            </button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <div className={`flex w-88 shrink-0 flex-col gap-6 overflow-y-auto border-r p-5 ${BORDER}`}>
            <section aria-label="Details" className="space-y-2">
              <h3 className={PANEL_TITLE}>{image ? 'Image details' : 'File details'}</h3>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
                <dt className={LABEL}>Filename</dt>
                <dd className="break-all">{file.originalName}</dd>
                <dt className={LABEL}>Format</dt>
                <dd title={file.mimeType}>{formatLabel(file.originalName)}</dd>
                <dt className={LABEL}>Dimensions</dt>
                <dd>{file.width !== null && file.height !== null ? `${file.width} × ${file.height} px` : '–'}</dd>
                {file.durationMs !== null && (
                  <>
                    <dt className={LABEL}>{DURATION_LABEL}</dt>
                    <dd className="tabular-nums">{formatDuration(file.durationMs)}</dd>
                  </>
                )}
                <dt className={LABEL}>Size</dt>
                <dd>{formatBytes(file.sizeBytes)}</dd>
                <dt className={LABEL}>Imported</dt>
                <dd>{formatDateTime(file.importedAt)}</dd>
                {file.deletedAt !== null && (
                  <>
                    <dt className={LABEL}>{DELETED_LABEL}</dt>
                    <dd>{formatDateTime(file.deletedAt)}</dd>
                    <dt className={LABEL}>{ORIGIN_LABEL}</dt>
                    <dd className="break-words">{fileOrigin(file)}</dd>
                  </>
                )}
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
            {/* The inbox's assign control shows only for complete files. */}
            {!trashed && roleControl !== null && (asset !== null || complete) && (
              <section className="space-y-2">
                <h3 className={PANEL_TITLE}>{asset !== null ? 'Role' : 'Assign'}</h3>
                {/* Keyed by file: stepping on starts the controls afresh. */}
                <Fragment key={`role-${file.id}`}>{roleControl}</Fragment>
              </section>
            )}
            {/* In the trash the tags are kept but cannot be changed. */}
            {trashed && file.tags.length > 0 && (
              <section aria-label={tagsLabel} className="space-y-2">
                <h3 className={PANEL_TITLE}>{tagsLabel}</h3>
                <TagList tags={file.tags} kind="file" max={Number.MAX_SAFE_INTEGER} wrap />
              </section>
            )}
            {!trashed && complete && (
              <TagRow
                key={`tags-${file.id}`}
                label={tagsLabel}
                kind="file"
                layout="stacked"
                tags={file.tags}
                onAdd={(name) => changeTag('files:addTag', name)}
                onRemove={(name) => changeTag('files:removeTag', name)}
              />
            )}
            {/* Keyed by file: stepping on loads the next file's addresses afresh. */}
            <FileOrigins key={`origins-${file.id}`} fileId={file.id} />
            {complete && <GenerationDetails key={`generation-${file.id}`} fileId={file.id} />}
            {asset !== null && (
              <>
                <hr className={`border-t ${BORDER}`} />
                <section className="space-y-2">
                  <h3 className={PANEL_TITLE}>Asset</h3>
                  <div className="break-words">
                    {onOpenAsset ? <Link onFollow={() => onOpenAsset(asset.id)}>{asset.name}</Link> : <span>{asset.name}</span>}
                  </div>
                </section>
                {asset.tags.length > 0 && (
                  <section className="space-y-2">
                    <h3 className={PANEL_TITLE}>Asset tags</h3>
                    <TagList tags={asset.tags} kind="asset" max={Number.MAX_SAFE_INTEGER} wrap />
                  </section>
                )}
              </>
            )}
            {error !== null && (
              <p role="alert" className={ALERT}>
                {error}
              </p>
            )}
            <div>
              <Menu label="More" items={items} align="start" side="top" trigger="labelled" />
            </div>
          </div>
          <div ref={stageBox} className="flex min-w-0 flex-1 flex-col bg-surface">
            {staged && (
              <div className="shrink-0 px-4 py-3">
                <div className="h-9">
                  {(controls !== null || playable) && (
                    <ViewerToolbar controls={controls} fullscreen={{ active: fullscreen, toggle: toggleFullscreen }} />
                  )}
                </div>
              </div>
            )}
            <div className={`relative min-h-0 flex-1 ${staged ? 'border-t' : ''} ${browsing !== null ? 'border-b' : ''} ${BORDER}`}>
              {playable ? (
                <VideoStage
                  key={file.id}
                  file={file}
                  videoRef={videoRef}
                  canOpenExternally={canOpenExternally}
                  onOpenExternally={openExternally}
                />
              ) : viewable ? (
                <ImageStage file={file} onControls={setControls} />
              ) : (
                <div className={`flex h-full w-full items-center justify-center bg-raised text-lg ${MUTED}`}>
                  {complete ? formatLabel(file.originalName) : label(file.status)}
                </div>
              )}
              {browsing !== null && (
                <>
                  {step(-1, { className: `absolute left-4 top-1/2 -translate-y-1/2 ${ICON_BUTTON}`, name: 'Previous file' })}
                  {step(1, { className: `absolute right-4 top-1/2 -translate-y-1/2 ${ICON_BUTTON}`, name: 'Next file' })}
                </>
              )}
            </div>
            {browsing !== null && (
              <div className="shrink-0 px-4 py-3">
                <FilmStrip list={browsing} />
              </div>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
