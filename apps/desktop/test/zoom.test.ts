import { describe, expect, it } from 'vitest';
import {
  anchoredScroll,
  cssSize,
  effectivePercent,
  fitPercent,
  rotated,
  stepPercent,
  ZOOM_STEPS,
} from '../src/renderer/src/viewer/zoom';

const WIDE = { width: 4000, height: 2000 };
const STAGE = { width: 1000, height: 800 };

describe('zoom', () => {
  it('has the agreed steps', () => {
    expect(ZOOM_STEPS).toEqual([10, 25, 33, 50, 67, 100, 150, 200, 300, 400, 800]);
  });

  it('rotated swaps the edges at 90 and 270 degrees', () => {
    expect(rotated(WIDE, 0)).toEqual(WIDE);
    expect(rotated(WIDE, 90)).toEqual({ width: 2000, height: 4000 });
    expect(rotated(WIDE, 180)).toEqual(WIDE);
    expect(rotated(WIDE, 270)).toEqual({ width: 2000, height: 4000 });
  });

  it('fitPercent scales into the stage in device pixels and honours the rotation', () => {
    expect(fitPercent(WIDE, STAGE, 1, 0)).toBe(25);
    expect(fitPercent(WIDE, STAGE, 2, 0)).toBe(50);
    expect(fitPercent(WIDE, STAGE, 1, 90)).toBe(20);
  });

  it('fitPercent never exceeds 100 and is 100 for an empty stage or image', () => {
    expect(fitPercent({ width: 100, height: 50 }, STAGE, 1, 0)).toBe(100);
    expect(fitPercent(WIDE, { width: 0, height: 0 }, 1, 0)).toBe(100);
    expect(fitPercent({ width: 0, height: 0 }, STAGE, 1, 0)).toBe(100);
  });

  it('stepPercent moves to the next step and stays at the ends', () => {
    expect(stepPercent(25, 1)).toBe(33);
    expect(stepPercent(26, 1)).toBe(33);
    expect(stepPercent(100, 1)).toBe(150);
    expect(stepPercent(800, 1)).toBe(800);
    expect(stepPercent(100, -1)).toBe(67);
    expect(stepPercent(84, -1)).toBe(67);
    expect(stepPercent(10, -1)).toBe(10);
    expect(stepPercent(7, -1)).toBe(7);
    expect(stepPercent(7, 1)).toBe(10);
  });

  it('cssSize divides the pixel size by the device pixel ratio', () => {
    expect(cssSize({ width: 1600, height: 2000 }, 100, 1.25)).toEqual({ width: 1280, height: 1600 });
    expect(cssSize({ width: 1600, height: 2000 }, 50, 1)).toEqual({ width: 800, height: 1000 });
  });

  it('anchoredScroll keeps the point under the pointer fixed', () => {
    expect(anchoredScroll(100, 200, 1000, 2000)).toBe(400);
    expect(anchoredScroll(100, 200, 0, 2000)).toBe(0);
  });

  it('effectivePercent is the chosen percentage or the fit', () => {
    expect(effectivePercent({ mode: 'percent', percent: 150 }, WIDE, STAGE, 1, 0)).toBe(150);
    expect(effectivePercent({ mode: 'fit' }, WIDE, STAGE, 1, 90)).toBe(fitPercent(WIDE, STAGE, 1, 90));
  });
});
