import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
} from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { useDevicePixelRatio } from '../hooks/useDevicePixelRatio';
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

// The zoomable image of the file detail dialog: fit, exact percentages on the device-pixel grid, Ctrl+wheel zoom
// about the pointer, drag pan and rotation.

/** What the stage offers the toolbar and the keys. */
export interface ViewerControls {
  /** Fits the image into the stage. */
  fit(): void;
  /** Shows the image at 100 %; nothing for the `preview` source. */
  actual(): void;
  /** One step larger. */
  zoomIn(): void;
  /** One step smaller. */
  zoomOut(): void;
  /** Turns the image by 90 degrees clockwise. */
  rotate(): void;
  /** Rounded, as displayed. */
  percent: number;
  /** The current zoom. */
  zoom: Zoom;
  /** False for the `preview` source. */
  canActual: boolean;
  /** "Reduced from 12000 × 9000 px" | "Preview only" | null */
  marker: string | null;
}

interface Props {
  /** The shown file. */
  file: FileRecord;
  /** Receives the controls whenever they change. */
  onControls(controls: ViewerControls): void;
}

/**
 * The zoomable image of the file detail dialog; its state resets when another file is shown.
 *
 * @param props the file and the receiver of the controls
 * @returns the stage
 */
export function ImageStage({ file, onControls }: Props) {
  return <Stage key={file.id} file={file} onControls={onControls} />;
}

const EMPTY: Size = { width: 0, height: 0 };

/** A position in CSS pixels. */
interface Point {
  x: number;
  y: number;
}

/** The scroll position and layout before a zoom change, to keep the anchor point in place after it. */
interface Anchor extends Point {
  scrollLeft: number;
  scrollTop: number;
  box: Size;
  /** Where the box sits inside the scrolled content. */
  offset: Point;
}

/** Where the image lies on the stage. */
interface Layout {
  /** The exact percentage shown. */
  exact: number;
  /** The unrotated image element's size. */
  element: Size;
  /** The rotated element's bounding box. */
  box: Size;
  /** The area the box is centred in. */
  stage: Size;
  /** Where the box sits inside the scrolled content. */
  offset: Point;
  /** Rounds a CSS length down onto the device-pixel grid. */
  snap(value: number): number;
}

/** What `layoutOf` needs. */
interface LayoutInput {
  /** The basis of every percentage. */
  image: Size;
  /** The space the stage has. */
  frame: Size;
  /** The stage's client area. */
  client: Size;
  zoom: Zoom;
  rotation: Rotation;
  /** The device pixel ratio. */
  dpr: number;
}

/**
 * Lays the image out on the stage.
 *
 * @param input the image, the stage sizes, the zoom and the rotation
 * @returns the layout
 */
function layoutOf({ image, frame, client, zoom, rotation, dpr }: LayoutInput): Layout {
  // Sizes and offsets lie on the device-pixel grid: a fractional one would make the browser
  // resample, and with `pixelated` it doubles or drops a row or column at 100 %. They are rounded
  // down, so a box fitted into the stage never ends up larger than it (the epsilon keeps exact
  // image-pixel sizes such as 1001 device pixels at 100 % from dropping a pixel to float error).
  const snap = (value: number) => Math.floor(value * dpr + 1e-6) / dpr;
  const exact = effectivePercent(zoom, image, frame, dpr, rotation);
  const unsnapped = cssSize(image, exact, dpr);
  const element: Size = { width: snap(unsnapped.width), height: snap(unsnapped.height) };
  const box = rotated(element, rotation);
  // Fit never scrolls, so the stage's client area is the frame; a percentage centres in the client area.
  const stage = zoom.mode === 'fit' ? frame : client;
  // The box is centred in a stage larger than itself.
  const offset: Point = {
    x: snap(Math.max(0, stage.width - box.width) / 2),
    y: snap(Math.max(0, stage.height - box.height) / 2),
  };
  return { exact, element, box, stage, offset, snap };
}

/**
 * The style of an image layer: unrotated, the layers fill the box and carry no transform; rotated, they are centred
 * in the box and turned about their centre.
 *
 * @param layout the layout
 * @param rotation the rotation
 * @returns the inline style
 */
function layerStyle({ element, box, exact, snap }: Layout, rotation: Rotation) {
  return {
    width: `${element.width}px`,
    height: `${element.height}px`,
    left: `${snap((box.width - element.width) / 2)}px`,
    top: `${snap((box.height - element.height) / 2)}px`,
    ...(rotation === 0 ? {} : { transform: `rotate(${rotation}deg)` }),
    imageRendering: exact >= 100 ? 'pixelated' : 'auto',
  } as const;
}

/**
 * Runs after every render: a pending zoom change moves the scroll position so the anchor stays put.
 *
 * @param stageRef the scrolling stage
 * @param anchor the pending anchor; cleared once applied
 * @param layout the layout of this render
 */
function useAnchoredScroll(
  stageRef: RefObject<HTMLDivElement | null>,
  anchor: MutableRefObject<Anchor | null>,
  { box, offset }: Layout,
): void {
  useLayoutEffect(() => {
    const pending = anchor.current;
    const scroller = stageRef.current;
    if (pending === null || scroller === null) return;
    anchor.current = null;
    const axis = (
      scroll: number,
      pointer: number,
      before: number,
      beforeOffset: number,
      after: number,
      afterOffset: number,
    ) => anchoredScroll(scroll - beforeOffset, pointer, before, after) + afterOffset;
    scroller.scrollLeft = axis(pending.scrollLeft, pending.x, pending.box.width, pending.offset.x, box.width, offset.x);
    scroller.scrollTop = axis(pending.scrollTop, pending.y, pending.box.height, pending.offset.y, box.height, offset.y);
  });
}

/**
 * Ctrl+wheel zooms instead of the browser. React registers wheel listeners as passive; preventing the browser zoom
 * needs a non-passive one.
 *
 * @param stageRef the stage
 * @param onWheel the zoom of the latest render
 */
function useCtrlWheel(
  stageRef: RefObject<HTMLDivElement | null>,
  onWheel: MutableRefObject<{ wheel(event: WheelEvent): void }>,
): void {
  useEffect(() => {
    const scroller = stageRef.current;
    if (scroller === null) return;
    const listener = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      onWheel.current.wheel(event);
    };
    scroller.addEventListener('wheel', listener, { passive: false });
    return () => scroller.removeEventListener('wheel', listener);
  }, []);
}

/**
 * Pans the stage by dragging with the primary button.
 *
 * @returns the pointer handlers of the stage
 */
function useDragPan() {
  const drag = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const scroller = event.currentTarget;
    // A press on the stage's own scrollbars belongs to the native scrolling, not to a pan. Measured
    // against the stage's client area, so it holds whichever child the press lands on.
    const rect = scroller.getBoundingClientRect();
    const x = event.clientX - rect.left - scroller.clientLeft;
    const y = event.clientY - rect.top - scroller.clientTop;
    if (x < 0 || y < 0 || x >= scroller.clientWidth || y >= scroller.clientHeight) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
    };
    scroller.setPointerCapture?.(event.pointerId);
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
  return { onPointerDown, onPointerMove, endDrag };
}

/**
 * The stage of one file.
 *
 * @param props the file and the receiver of the controls
 * @returns the stage
 */
function Stage({ file, onControls }: Props) {
  // The frame's size is the space the stage has; it does not depend on the stage's scrollbars, so
  // fitting into it cannot feed back into itself. The stage's own client area (smaller by the
  // scrollbars a percentage may need) only centres the box.
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frame = useElementSize(frameRef) ?? EMPTY;
  const client = useElementSize(stageRef) ?? EMPTY;
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
  const dpr = useDevicePixelRatio();
  const fit = zoom.mode === 'fit';
  const layout = layoutOf({ image, frame, client, zoom, rotation, dpr });
  const { exact, box, stage, offset } = layout;
  const marker =
    source === 'reduced' ? `Reduced from ${file.width} × ${file.height} px` : large === null ? 'Preview only' : null;

  const anchor = useRef<Anchor | null>(null);
  useAnchoredScroll(stageRef, anchor, layout);

  function zoomTo(next: Zoom, at?: Point) {
    const scroller = stageRef.current;
    const point = at ?? { x: stage.width / 2, y: stage.height / 2 };
    anchor.current = {
      ...point,
      scrollLeft: scroller?.scrollLeft ?? 0,
      scrollTop: scroller?.scrollTop ?? 0,
      box,
      offset,
    };
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
    rotate: () => setRotation((current) => ((current + 90) % 360) as Rotation),
    wheel: (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      zoomTo({ mode: 'percent', percent: stepPercent(exact, event.deltaY < 0 ? 1 : -1) }, pointerOf(event));
    },
  };
  const latest = useRef(handlers);
  latest.current = handlers;
  useCtrlWheel(stageRef, latest);

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
  useEffect(() => {
    onControlsRef.current(controls);
  }, [controls]);

  const { onPointerDown, onPointerMove, endDrag } = useDragPan();
  const layer = layerStyle(layout, rotation);
  const layerClass = 'absolute max-w-none select-none';

  return (
    <div ref={frameRef} className="relative h-full w-full">
      <div
        ref={stageRef}
        role="region"
        aria-label="Image"
        tabIndex={0}
        className={`h-full w-full cursor-grab select-none ${fit ? 'overflow-hidden' : 'overflow-auto'} bg-raised active:cursor-grabbing ${FOCUS}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => {
          if (canActual)
            zoomTo(zoom.mode === 'fit' ? { mode: 'percent', percent: 100 } : { mode: 'fit' }, pointerOf(event));
        }}
      >
        {/* As large as the box, at least the client area: it overflows only when the box really does. */}
        <div
          className="relative"
          style={{ minWidth: '100%', minHeight: '100%', width: `${box.width}px`, height: `${box.height}px` }}
        >
          <div
            className="absolute"
            style={{ left: `${offset.x}px`, top: `${offset.y}px`, width: `${box.width}px`, height: `${box.height}px` }}
          >
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
