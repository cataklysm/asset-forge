import { Maximize, Minimize, RotateCw, TriangleAlert, ZoomIn, ZoomOut } from 'lucide-react';
import { BUTTON, ICON_BUTTON } from '../ui';
import type { ViewerControls } from './ImageStage';

interface Props {
  /** `null` (a video) renders only the fullscreen button. */
  controls: ViewerControls | null;
  /** `null` renders no fullscreen button. */
  fullscreen: { active: boolean; toggle(): void } | null;
}

/** Zoom, rotation and fullscreen controls above the stage. */
export function ViewerToolbar({ controls, fullscreen }: Props) {
  return (
    <div role="toolbar" aria-label="Viewer" className="flex items-center gap-2">
      {controls !== null && <ImageControls controls={controls} />}
      {fullscreen !== null && (
        <button
          type="button"
          className={ICON_BUTTON}
          title={fullscreen.active ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
          aria-label="Fullscreen"
          aria-pressed={fullscreen.active}
          onClick={fullscreen.toggle}
        >
          {fullscreen.active ? <Minimize size={18} aria-hidden /> : <Maximize size={18} aria-hidden />}
        </button>
      )}
    </div>
  );
}

function ImageControls({ controls }: { controls: ViewerControls }) {
  const { zoom, percent, marker, canActual } = controls;
  return (
    <>
      <button type="button" className={BUTTON} title="Fit (0)" aria-pressed={zoom.mode === 'fit'} onClick={controls.fit}>
        Fit
      </button>
      <button
        type="button"
        className={BUTTON}
        title="Actual pixels (1)"
        aria-pressed={zoom.mode === 'percent' && zoom.percent === 100}
        disabled={!canActual}
        onClick={controls.actual}
      >
        100%
      </button>
      <button type="button" className={ICON_BUTTON} title="Zoom out (−)" aria-label="Zoom out" onClick={controls.zoomOut}>
        <ZoomOut size={18} aria-hidden />
      </button>
      <span aria-live="polite" className="inline-flex min-w-16 items-center justify-center gap-1 text-sm tabular-nums">
        {percent}%
        {marker !== null && (
          <span role="img" title={marker} aria-label={marker} className="inline-flex text-warning">
            <TriangleAlert size={16} aria-hidden />
          </span>
        )}
      </span>
      <button type="button" className={ICON_BUTTON} title="Zoom in (+)" aria-label="Zoom in" onClick={controls.zoomIn}>
        <ZoomIn size={18} aria-hidden />
      </button>
      <button type="button" className={ICON_BUTTON} title="Rotate (R)" aria-label="Rotate" onClick={controls.rotate}>
        <RotateCw size={18} aria-hidden />
      </button>
    </>
  );
}
