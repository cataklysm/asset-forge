// Pure zoom arithmetic of the image viewer. A percentage always refers to image pixels:
// 100 % is one image pixel per device pixel, so CSS sizes are divided by `devicePixelRatio`.

/** The percentages the zoom buttons and keys step through. */
export const ZOOM_STEPS = [10, 25, 33, 50, 67, 100, 150, 200, 300, 400, 800] as const;

/** A width and height in pixels. */
export interface Size {
  /** The width. */
  width: number;
  /** The height. */
  height: number;
}

/** Fit to the stage, or a fixed percentage. */
export type Zoom = { mode: 'fit' } | { mode: 'percent'; percent: number };

/** The rotation in degrees clockwise. */
export type Rotation = 0 | 90 | 180 | 270;

/**
 * Image pixel size after rotation (90 and 270 swap).
 *
 * @param image the image size
 * @param rotation the rotation
 * @returns the rotated size
 */
export function rotated(image: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270 ? { width: image.height, height: image.width } : image;
}

/**
 * Largest percentage ≤ 100 at which the rotated image fits the stage; 100 for an empty stage or image.
 *
 * @param image the image size
 * @param stage the stage size in CSS pixels
 * @param dpr the device pixel ratio
 * @param rotation the rotation
 * @returns the percentage
 */
export function fitPercent(image: Size, stage: Size, dpr: number, rotation: Rotation): number {
  const { width, height } = rotated(image, rotation);
  if (width <= 0 || height <= 0 || stage.width <= 0 || stage.height <= 0) return 100;
  const scale = Math.min((stage.width * dpr) / width, (stage.height * dpr) / height);
  return Math.min(100, scale * 100);
}

/**
 * The percentage a zoom shows.
 *
 * @param zoom the zoom
 * @param image the image size
 * @param stage the stage size in CSS pixels
 * @param dpr the device pixel ratio
 * @param rotation the rotation
 * @returns the fit percentage, or the fixed one
 */
export function effectivePercent(zoom: Zoom, image: Size, stage: Size, dpr: number, rotation: Rotation): number {
  return zoom.mode === 'fit' ? fitPercent(image, stage, dpr, rotation) : zoom.percent;
}

/**
 * Next step above (+1) or below (−1) `percent`; stays at 800 / at min(10, percent).
 *
 * @param percent the current percentage
 * @param direction up or down
 * @returns the next percentage
 */
export function stepPercent(percent: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_STEPS.find((step) => step > percent) ?? 800;
  return [...ZOOM_STEPS].reverse().find((step) => step < percent) ?? Math.min(ZOOM_STEPS[0], percent);
}

/**
 * CSS pixel size of the unrotated image element at `percent`.
 *
 * @param image the image size
 * @param percent the percentage
 * @param dpr the device pixel ratio
 * @returns the element size
 */
export function cssSize(image: Size, percent: number, dpr: number): Size {
  return { width: (image.width * percent) / 100 / dpr, height: (image.height * percent) / 100 / dpr };
}

/**
 * Scroll offset that keeps the image point under `pointer` (stage coordinates) fixed when the content size changes.
 *
 * @param scroll the scroll offset before
 * @param pointer the pointer position on the stage
 * @param before the content size before
 * @param after the content size after
 * @returns the new scroll offset
 */
export function anchoredScroll(scroll: number, pointer: number, before: number, after: number): number {
  if (before <= 0) return 0;
  return ((scroll + pointer) * after) / before - pointer;
}
