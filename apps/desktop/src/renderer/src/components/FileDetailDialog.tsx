import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { fileMenuItems, showsProposal, type FileActionContext } from '../file-actions';
import { label } from '../labels';
import { formatLabel } from '../media-url';
import { BORDER, ICON_BUTTON, MUTED, SECTION_TITLE } from '../ui';
import { exitFullscreen, useFullscreen } from '../hooks/useFullscreen';
import { useMeasuredFile, type Measured } from '../hooks/useMeasuredFile';
import { useStageFocus } from '../hooks/useStageFocus';
import { useViewerKeys } from '../hooks/useViewerKeys';
import { Dialog } from './Dialog';
import { FileDetailsPanel, type DialogAsset } from './FileDetailsPanel';
import { FilmStrip } from './FilmStrip';
import type { ViewerList } from './FileBrowser';
import { ImageStage, type ViewerControls } from './ImageStage';
import { ProposalMarker } from './ProposalMarker';
import { VideoStage, videoControls } from './VideoStage';
import { ViewerToolbar } from './ViewerToolbar';

// The file detail dialog: the details column beside the zoomable image or the video stage, stepping through the list
// it was opened from.

export type { Measured };

/** The props of the dialog. */
interface Props {
  /** The record to show. */
  file: FileRecord;
  /** `null` in the inbox. */
  asset: DialogAsset | null;
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
  /** Opens the file's asset. */
  onOpenAsset?(assetId: string): void;
  /** The list of the file browser the dialog was opened from; steps through it. */
  list: ViewerList | null;
  /** A counter; every change brings the open dialog to the top again, without a remount. */
  raise?: number;
  /** Closes the dialog. */
  onClose(): void;
}

/**
 * Wraps an action of the More menu so that its failure shows in the dialog; cover, detach and trash callers may be
 * asynchronous.
 *
 * @param action the action; undefined stays undefined
 * @param setError clears the dialog's error before the action
 * @param report shows a failure
 * @returns the wrapped action
 */
function guarded<A extends unknown[]>(
  action: ((...args: A) => unknown) | undefined,
  setError: (message: string | null) => void,
  report: (message: string) => void,
): ((...args: A) => void) | undefined {
  if (action === undefined) return undefined;
  return (...actionArguments: A) => {
    setError(null);
    Promise.resolve()
      .then(() => action(...actionArguments))
      .catch((error: unknown) => report(describeError(error)));
  };
}

/**
 * The action of the Delete key: Delete permanently for a trashed file, nothing for a pending one or while the
 * host's guarded actions are busy (as the More menu's Delete is disabled then), else Delete.
 *
 * @param file the shown record
 * @param actions the dialog's actions
 * @returns the action, or undefined when the key does nothing
 */
function removeActionOf(file: FileRecord, actions: FileActionContext): (() => void) | undefined {
  if (file.deletedAt !== null) return actions.onPurge;
  return file.status !== 'pending' && actions.actionBusy !== true ? actions.onDelete : undefined;
}

/**
 * The file detail dialog.
 *
 * @param props the file, its asset, the actions, the role control, the list, the raise counter and the callbacks
 * @returns the dialog
 */
export function FileDetailDialog({
  file: given,
  asset,
  actions,
  roleControl,
  onFileChange,
  onMeasured,
  onOpenAsset,
  list,
  raise,
  onClose,
}: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Error and viewer controls belong to the file they came from; stepping on leaves them behind.
  const [failure, setFailure] = useState<{ fileId: string; message: string } | null>(null);
  const [stage, setStage] = useState<{ fileId: string; controls: ViewerControls } | null>(null);
  const file = useMeasuredFile(given, onMeasured);
  const error = failure?.fileId === file.id ? failure.message : null;
  const controls = stage?.fileId === file.id ? stage.controls : null;
  const fileId = file.id;
  const setError = (message: string | null) => setFailure(message === null ? null : { fileId, message });
  const setControls = (next: ViewerControls) => setStage({ fileId, controls: next });

  const complete = file.status === 'complete';
  const trashed = file.deletedAt !== null;
  const viewable = complete && file.previewable;
  // A video plays in the video stage; its toolbar has only the fullscreen button.
  const playable = complete && file.kind === 'video';
  const staged = viewable || playable;

  // Fullscreen shows the toolbar and the stage.
  const rootRef = useRef<HTMLDivElement>(null);
  const stageBox = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(stageBox);
  // Esc and Close leave fullscreen first.
  const close = () => {
    if (document.fullscreenElement) {
      exitFullscreen();
      return;
    }
    onClose();
  };
  const stageFocus = useStageFocus();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const video = playable ? videoControls(videoRef) : null;
  // The Delete key does what the More menu offers: Delete, or Delete permanently (which asks) in the trash.
  const removeAction = removeActionOf(file, actions);
  useViewerKeys(rootRef, {
    previous: () => list?.show(list.index - 1),
    next: () => list?.show(list.index + 1),
    zoomIn: () => controls?.zoomIn(),
    zoomOut: () => controls?.zoomOut(),
    fit: () => controls?.fit(),
    actual: () => controls?.actual(),
    rotate: () => controls?.rotate(),
    fullscreen: () => {
      if (controls !== null || playable) fullscreen.toggle();
    },
    ...(video === null ? {} : { seek: video.seek, togglePlayback: video.togglePlayback }),
    ...(removeAction === undefined ? {} : { remove: () => guard(removeAction)?.() }),
  });

  const title = asset === null ? file.originalName : `${file.originalName} | ${asset.name}`;
  const report = (message: string) => {
    setError(message);
    actions.onError?.(message);
  };
  const guard = <A extends unknown[]>(action: ((...args: A) => unknown) | undefined) =>
    guarded(action, setError, report);
  // The dialog is the details: its More menu has no Details entry.
  const items = fileMenuItems(file, {
    ...actions,
    onDetails: undefined,
    onSetCover: guard(actions.onSetCover),
    onDetach: guard(actions.onDetach),
    onDelete: guard(actions.onDelete),
    onRestore: guard(actions.onRestore),
    onPurge: guard(actions.onPurge),
    onError: report,
  });

  // The same action and rule as Open externally in the More menu.
  const canOpenExternally = complete && file.openable && !trashed;
  const openExternally = () => {
    setError(null);
    call('files:openExternal', { fileId: file.id }).catch((error: unknown) => report(describeError(error)));
  };

  async function changeTag(channel: 'files:addTag' | 'files:removeTag', name: string) {
    onFileChange(await call(channel, { fileId: file.id, name }));
  }

  const browsing = list !== null && list.total >= 2 ? list : null;

  return (
    <Dialog open title={title} onClose={close} initialFocusRef={closeRef} size="detail" raise={raise}>
      <div ref={rootRef} className="flex h-full flex-col">
        <DetailHeader
          file={file}
          assetName={asset?.name ?? null}
          title={title}
          list={list}
          closeRef={closeRef}
          stageRef={stageFocus.areaRef}
          onClose={close}
        />
        <div className="flex min-h-0 flex-1">
          <FileDetailsPanel
            file={file}
            asset={asset}
            roleControl={roleControl}
            error={error}
            items={items}
            onChangeTag={changeTag}
            onOpenAsset={onOpenAsset}
            focusFallbackRef={stageFocus.areaRef}
          />
          <div ref={stageBox} className="flex min-w-0 flex-1 flex-col bg-surface">
            {staged && (
              <div className="shrink-0 px-4 py-3">
                <div className="h-9">
                  {(controls !== null || playable) && <ViewerToolbar controls={controls} fullscreen={fullscreen} />}
                </div>
              </div>
            )}
            <div
              ref={stageFocus.areaRef}
              tabIndex={-1}
              onFocus={stageFocus.onFocus}
              onBlur={stageFocus.onBlur}
              className={`relative min-h-0 flex-1 outline-none ${staged ? 'border-t' : ''} ${browsing !== null ? 'border-b' : ''} ${BORDER}`}
            >
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
                  <StepButton
                    list={browsing}
                    direction={-1}
                    className={`absolute left-4 top-1/2 -translate-y-1/2 ${ICON_BUTTON}`}
                    name="Previous file"
                    fallbackRef={stageFocus.areaRef}
                  />
                  <StepButton
                    list={browsing}
                    direction={1}
                    className={`absolute right-4 top-1/2 -translate-y-1/2 ${ICON_BUTTON}`}
                    name="Next file"
                    fallbackRef={stageFocus.areaRef}
                  />
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

/** The props of the dialog's header. */
interface DetailHeaderProps {
  /** The shown record. */
  file: FileRecord;
  /** The asset's name; null in the inbox. */
  assetName: string | null;
  /** The dialog's title, also the heading's tooltip and name. */
  title: string;
  /** The list the dialog steps through; null shows no position or step buttons. */
  list: ViewerList | null;
  /** The Close button, which takes the initial focus. */
  closeRef: RefObject<HTMLButtonElement | null>;
  /** The stage area; it takes the focus from a step button that becomes disabled. */
  stageRef: RefObject<HTMLElement | null>;
  /** Closes the dialog, leaving fullscreen first. */
  onClose(): void;
}

/**
 * The header: the file name with the proposal marker and the asset's name, the position in the list, the step
 * buttons and Close.
 *
 * @param props the file, the asset's name, the title, the list, the Close and stage refs and the close action
 * @returns the header
 */
function DetailHeader({ file, assetName, title, list, closeRef, stageRef, onClose }: DetailHeaderProps) {
  return (
    // A plain block: a <header> here would count as the page's banner landmark.
    <div className={`flex shrink-0 items-center gap-4 border-b py-3 pl-5 pr-4 ${BORDER}`}>
      <h2 title={title} aria-label={title} className={`${SECTION_TITLE} flex min-w-0 flex-1 items-center gap-3`}>
        <span className="truncate">{file.originalName}</span>
        {showsProposal(file) && <ProposalMarker />}
        {assetName !== null && (
          <>
            <span aria-hidden className={`h-5 shrink-0 border-l ${BORDER}`} />
            <span className="truncate font-normal">{assetName}</span>
          </>
        )}
      </h2>
      <div className="flex shrink-0 items-center gap-2">
        {list !== null && (
          <>
            <span className={`mr-2 text-sm tabular-nums ${MUTED}`}>
              {list.index + 1} / {list.total}
            </span>
            <StepButton list={list} direction={-1} className={ICON_BUTTON} fallbackRef={stageRef} />
            <StepButton list={list} direction={1} className={ICON_BUTTON} fallbackRef={stageRef} />
          </>
        )}
        <button
          ref={closeRef}
          type="button"
          aria-label="Close"
          title="Close"
          className={`ml-2 ${ICON_BUTTON}`}
          onClick={onClose}
        >
          <X size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** The props of a step button. */
interface StepButtonProps {
  /** The list to step through. */
  list: ViewerList;
  /** Back or on. */
  direction: -1 | 1;
  /** The classes that place it. */
  className: string;
  /** The accessible name; absent uses the tooltip. */
  name?: string;
  /** Takes the focus when the focused button becomes disabled. */
  fallbackRef: RefObject<HTMLElement | null>;
}

/**
 * Previous or Next file. The header pair and the on-stage pair have the same behaviour and tooltips and distinct
 * accessible names.
 *
 * @param props the list, the direction, the classes, the accessible name and the element that takes the focus at
 *   the end of the list
 * @returns the button
 */
function StepButton({ list, direction, className, name, fallbackRef }: StepButtonProps) {
  const tooltip = direction < 0 ? 'Previous file (←)' : 'Next file (→)';
  const disabled = direction < 0 ? list.index <= 0 : list.index >= list.total - 1;
  const buttonRef = useRef<HTMLButtonElement>(null);
  // A focused button that becomes disabled would drop the focus to the body, out of reach of the viewer keys.
  useLayoutEffect(() => {
    if (disabled && buttonRef.current !== null && buttonRef.current === document.activeElement)
      fallbackRef.current?.focus({ preventScroll: true });
  }, [disabled, fallbackRef]);
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={name ?? tooltip}
      title={tooltip}
      className={className}
      disabled={disabled}
      onClick={() => list.show(list.index + direction)}
    >
      {direction < 0 ? <ChevronLeft size={18} aria-hidden /> : <ChevronRight size={18} aria-hidden />}
    </button>
  );
}
