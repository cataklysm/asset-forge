import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { useElementSize } from '../hooks/useVirtualRows';
import { previewUrl, viewUrl } from '../media-url';
import { ALERT, FOCUS } from '../ui';
import {
  anchoredScroll,
  cssSize,
  effectivePercent,
  rotated,
  stepPercent,
  type Rotation,
  type Size,
  type Zoom,
} from '../viewer/zoom';

export interface ViewerControls {
  fit(): void;
  actual(): void;
  zoomIn(): void;
  zoomOut(): void;
  rotate(): void;
  /** Rounded, as displayed. */
  percent: number;
  zoom: Zoom;
  /** False for the `preview` source. */
  canActual: boolean;
  /** "Reduced from 12000 × 9000 px" | "Preview only" | null */
  marker: string | null;
}

interface Props {
  file: FileRecord;
  onControls(controls: ViewerControls): void;
}

/** The zoomable image of the file detail dialog; its state resets when another file is shown. */
export function ImageStage({ file, onControls }: Props) {
  return <Stage key={file.id} file={file} onControls={onControls} />;
}

const EMPTY: Size = { width: 0, height: 0 };

interface Point {
  x: number;
  y: number;
}

/** The scroll position and layout before a zoom change, to keep the anchor point in place after it. */
interface Anchor extends Point {
  scrollLeft: number;
  scrollTop: number;
  box: Size;
  content: Size;
}

function Stage({ file, onControls }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const stage = useElementSize(stageRef) ?? EMPTY;
  const [zoom, setZoom] = useState<Zoom>({ mode: 'fit' });
  const [rotation, setRotation] = useState<Rotation>(0);
  const [natural, setNatural] = useState<Size>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const { source, url } = viewUrl(file);
  const large = source === 'preview' || source === 'none' ? null : url;
  const canActual = large !== null;
  // The basis of every percentage: the stored size, or the preview's own size when that is all there is.
  const image: Size = large !== null ? { width: file.width ?? 0, height: file.height ?? 0 } : natural;
  const dpr = window.devicePixelRatio || 1;
  const exact = effectivePercent(zoom, image, stage, dpr, rotation);
  const element = cssSize(image, exact, dpr);
  const box = rotated(element, rotation);
  const content: Size = { width: Math.max(stage.width, box.width), height: Math.max(stage.height, box.height) };
  const marker =
    source === 'reduced' ? `Reduced from ${file.width} × ${file.height} px` : large === null ? 'Preview only' : null;

  const anchor = useRef<Anchor | null>(null);
  // Runs after every render: a pending zoom change moves the scroll position so the anchor stays put.
  useLayoutEffect(() => {
    const pending = anchor.current;
    const el = stageRef.current;
    if (pending === null || el === null) return;
    anchor.current = null;
    const axis = (scroll: number, pointer: number, before: number, beforeContent: number, after: number, afterContent: number) =>
      anchoredScroll(scroll - (beforeContent - before) / 2, pointer, before, after) + (afterContent - after) / 2;
    el.scrollLeft = axis(pending.scrollLeft, pending.x, pending.box.width, pending.content.width, box.width, content.width);
    el.scrollTop = axis(pending.scrollTop, pending.y, pending.box.height, pending.content.height, box.height, content.height);
  });

  function zoomTo(next: Zoom, at?: Point) {
    const el = stageRef.current;
    const point = at ?? { x: stage.width / 2, y: stage.height / 2 };
    anchor.current = { ...point, scrollLeft: el?.scrollLeft ?? 0, scrollTop: el?.scrollTop ?? 0, box, content };
    setZoom(next);
  }

  function pointerOf(event: { clientX: number; clientY: number }): Point {
    const rect = stageRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }

  const handlers = {
    fit: () => zoomTo({ mode: 'fit' }),
    actual: () => {
      if (canActual) zoomTo({ mode: 'percent', percent: 100 });
    },
    zoomIn: () => zoomTo({ mode: 'percent', percent: stepPercent(exact, 1) }),
    zoomOut: () => zoomTo({ mode: 'percent', percent: stepPercent(exact, -1) }),
    rotate: () => setRotation((r) => ((r + 90) % 360) as Rotation),
    wheel: (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      zoomTo({ mode: 'percent', percent: stepPercent(exact, event.deltaY < 0 ? 1 : -1) }, pointerOf(event));
    },
  };
  const latest = useRef(handlers);
  latest.current = handlers;

  // React registers wheel listeners as passive; preventing the browser zoom needs a non-passive one.
  useEffect(() => {
    const el = stageRef.current;
    if (el === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      latest.current.wheel(event);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const percent = Math.round(exact);
  const controls = useMemo<ViewerControls>(
    () => ({
      fit: () => latest.current.fit(),
      actual: () => latest.current.actual(),
      zoomIn: () => latest.current.zoomIn(),
      zoomOut: () => latest.current.zoomOut(),
      rotate: () => latest.current.rotate(),
      percent,
      zoom,
      canActual,
      marker,
    }),
    [percent, zoom, canActual, marker],
  );
  const onControlsRef = useRef(onControls);
  onControlsRef.current = onControls;
  useEffect(() => onControlsRef.current(controls), [controls]);

  const drag = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const el = event.currentTarget;
    drag.current = { x: event.clientX, y: event.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
    el.setPointerCapture?.(event.pointerId);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (start === null) return;
    event.currentTarget.scrollLeft = start.scrollLeft - (event.clientX - start.x);
    event.currentTarget.scrollTop = start.scrollTop - (event.clientY - start.y);
  }
  const endDrag = () => {
    drag.current = null;
  };

  const layer = {
    width: `${element.width}px`,
    height: `${element.height}px`,
    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
    imageRendering: exact >= 100 ? 'pixelated' : 'auto',
  } as const;
  const layerClass = 'absolute left-1/2 top-1/2 max-w-none select-none';

  return (
    <div className="relative h-full w-full">
      <div
        ref={stageRef}
        role="region"
        aria-label="Image"
        tabIndex={0}
        className={`h-full w-full cursor-grab overflow-auto rounded-control bg-raised active:cursor-grabbing ${FOCUS}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => {
          if (canActual) zoomTo(zoom.mode === 'fit' ? { mode: 'percent', percent: 100 } : { mode: 'fit' }, pointerOf(event));
        }}
      >
        <div className="flex items-center justify-center" style={{ width: `${content.width}px`, height: `${content.height}px` }}>
          <div className="relative shrink-0" style={{ width: `${box.width}px`, height: `${box.height}px` }}>
            {(!loaded || large === null) && (
              <img
                src={previewUrl(file.id, 'detail')}
                alt=""
                draggable={false}
                className={layerClass}
                style={layer}
                onLoad={(event) => {
                  const { naturalWidth, naturalHeight } = event.currentTarget;
                  if (large === null && naturalWidth > 0 && naturalHeight > 0)
                    setNatural({ width: naturalWidth, height: naturalHeight });
                }}
              />
            )}
            {large !== null && !failed && (
              <img
                src={large}
                alt=""
                decoding="async"
                draggable={false}
                className={`${layerClass} ${loaded ? '' : 'invisible'}`}
                style={layer}
                onLoad={() => setLoaded(true)}
                onError={() => setFailed(true)}
              />
            )}
          </div>
        </div>
      </div>
      {failed && (
        <p role="alert" className={`${ALERT} absolute left-3 top-3`}>
          The image could not be loaded
        </p>
      )}
    </div>
  );
}
