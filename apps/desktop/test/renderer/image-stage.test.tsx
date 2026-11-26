import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImageStage, type ViewerControls } from '../../src/renderer/src/components/ImageStage';
import { ViewerToolbar } from '../../src/renderer/src/components/ViewerToolbar';
import { fileRecord } from './fixtures';

const STAGE = { width: 1000, height: 800 };

const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!;
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')!;

function setDpr(value: number) {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value });
}

beforeEach(() => {
  // The stage measures 1000 × 800; every other element keeps the size from setup.ts.
  const isStage = (element: HTMLElement) => element.getAttribute('aria-label') === 'Image';
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return isStage(this) ? STAGE.width : 1280;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isStage(this) ? STAGE.height : 800;
    },
  });
  setDpr(1);
});

afterEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalHeight);
  setDpr(1);
});

function Viewer({ file }: { file: FileRecord }) {
  const [controls, setControls] = useState<ViewerControls | null>(null);
  return (
    <div>
      {controls && <ViewerToolbar controls={controls} fullscreen={null} />}
      <ImageStage file={file} onControls={setControls} />
    </div>
  );
}

const png = (width: number | null, height: number | null) =>
  fileRecord({ mimeType: 'image/png', originalName: 'image.png', width, height });

const stage = () => screen.getByRole('region', { name: 'Image' });
const images = () => [...stage().querySelectorAll('img')];
const preview = (file: FileRecord) => images().find((img) => img.src === `assetforge-media://preview/${file.id}?size=detail`);
const large = (file: FileRecord) => images().find((img) => img.src !== `assetforge-media://preview/${file.id}?size=detail`);
const percent = () => document.querySelector('[aria-live="polite"]')?.textContent;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const box = () => images()[0]!.parentElement!;

it('shows the preview at once, then swaps to the original when it has loaded', () => {
  const file = png(4000, 2000);
  render(<Viewer file={file} />);
  expect(percent()).toBe('25%');
  expect(button('Fit').getAttribute('aria-pressed')).toBe('true');
  expect(preview(file)).toBeDefined();
  expect(large(file)?.src).toBe(`assetforge-media://original/${file.id}`);
  expect(box().style.width).toBe('1000px');
  expect(box().style.height).toBe('500px');

  fireEvent.load(large(file)!);
  expect(preview(file)).toBeUndefined();
  expect(images()).toHaveLength(1);
});

it('a failing large image keeps the preview and shows an alert', () => {
  const file = png(4000, 2000);
  render(<Viewer file={file} />);
  fireEvent.error(large(file)!);
  expect(preview(file)).toBeDefined();
  expect(screen.getByRole('alert').textContent).toBe('The image could not be loaded');
});

it('100% shows one image pixel per device pixel, drawn unsmoothed', () => {
  const file = png(4000, 2000);
  const { unmount } = render(<Viewer file={file} />);
  fireEvent.click(button('100%'));
  expect(percent()).toBe('100%');
  expect(button('100%').getAttribute('aria-pressed')).toBe('true');
  expect(large(file)!.style.width).toBe('4000px');
  expect(large(file)!.style.imageRendering).toBe('pixelated');
  expect(preview(file)!.style.imageRendering).toBe('pixelated');
  fireEvent.click(button('Fit'));
  expect(percent()).toBe('25%');
  expect(large(file)!.style.imageRendering).not.toBe('pixelated');
  unmount();

  setDpr(1.25);
  render(<Viewer file={file} />);
  fireEvent.click(button('100%'));
  expect(large(file)!.style.width).toBe('3200px');
});

it('zoom steps from the effective percentage and stays at the ends', () => {
  render(<Viewer file={png(4000, 2000)} />);
  fireEvent.click(button('Zoom in'));
  expect(percent()).toBe('33%');
  expect(button('Fit').getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(button('Zoom out'));
  fireEvent.click(button('Zoom out'));
  expect(percent()).toBe('10%');
  fireEvent.click(button('Zoom out'));
  expect(button('Zoom out').disabled).toBe(false);
  expect(percent()).toBe('10%');
  for (let i = 0; i < 12; i += 1) fireEvent.click(button('Zoom in'));
  expect(button('Zoom in').disabled).toBe(false);
  expect(percent()).toBe('800%');
});

it('double click toggles Fit and 100%; Ctrl+wheel steps, a plain wheel does not zoom', () => {
  render(<Viewer file={png(4000, 2000)} />);
  fireEvent.doubleClick(stage());
  expect(percent()).toBe('100%');
  fireEvent.doubleClick(stage());
  expect(percent()).toBe('25%');

  expect(fireEvent.wheel(stage(), { deltaY: -100, ctrlKey: true })).toBe(false);
  expect(percent()).toBe('33%');
  expect(fireEvent.wheel(stage(), { deltaY: 100, ctrlKey: true })).toBe(false);
  expect(percent()).toBe('25%');
  expect(fireEvent.wheel(stage(), { deltaY: -100 })).toBe(true);
  expect(percent()).toBe('25%');
});

it('dragging with the primary button pans the stage', () => {
  render(<Viewer file={png(4000, 2000)} />);
  fireEvent.click(button('100%'));
  stage().scrollLeft = 500;
  stage().scrollTop = 300;
  fireEvent.pointerDown(stage(), { button: 0, clientX: 400, clientY: 400, pointerId: 1 });
  fireEvent.pointerMove(stage(), { clientX: 350, clientY: 380, pointerId: 1 });
  expect(stage().scrollLeft).toBe(550);
  expect(stage().scrollTop).toBe(320);
  fireEvent.pointerUp(stage(), { pointerId: 1 });
  fireEvent.pointerMove(stage(), { clientX: 0, clientY: 0, pointerId: 1 });
  expect(stage().scrollLeft).toBe(550);
});

it('a press on the scrollbars starts no pan; a press on the image does', () => {
  const file = png(4000, 2000);
  render(<Viewer file={file} />);
  fireEvent.click(button('100%'));
  const capture = vi.fn();
  stage().setPointerCapture = capture;
  stage().scrollLeft = 500;
  stage().scrollTop = 300;

  // The stage's client area is 1000 × 800 inside a 1280 × 800 box: x ≥ 1000 is the vertical scrollbar.
  fireEvent.pointerDown(stage(), { button: 0, clientX: 1005, clientY: 400, pointerId: 1 });
  fireEvent.pointerMove(stage(), { clientX: 1005, clientY: 300, pointerId: 1 });
  expect(stage().scrollLeft).toBe(500);
  expect(stage().scrollTop).toBe(300);
  expect(capture).not.toHaveBeenCalled();
  fireEvent.pointerUp(stage(), { pointerId: 1 });

  fireEvent.pointerDown(large(file)!, { button: 0, clientX: 400, clientY: 400, pointerId: 2 });
  fireEvent.pointerMove(large(file)!, { clientX: 350, clientY: 380, pointerId: 2 });
  expect(stage().scrollLeft).toBe(550);
  expect(stage().scrollTop).toBe(320);
  expect(capture).toHaveBeenCalledWith(2);
});

it('rotate swaps the box and refits', () => {
  const file = png(4000, 2000);
  render(<Viewer file={file} />);
  fireEvent.click(button('Rotate'));
  expect(percent()).toBe('20%');
  expect(box().style.width).toBe('400px');
  expect(box().style.height).toBe('800px');
  expect(large(file)!.style.transform).toBe('rotate(90deg)');
});

const px = (value: string) => {
  expect(value).toMatch(/px$/);
  return Number.parseFloat(value);
};
const onDeviceGrid = (value: string, dpr: number) => {
  const device = px(value) * dpr;
  expect(Math.abs(device - Math.round(device))).toBeLessThan(1e-6);
};

it('without rotation the image layers carry no transform', () => {
  const file = png(4000, 2000);
  render(<Viewer file={file} />);
  expect(images()).toHaveLength(2);
  for (const img of images()) expect(img.style.transform).toBe('');
  fireEvent.click(button('100%'));
  for (const img of images()) expect(img.style.transform).toBe('');
});

it('at 100% with a fractional devicePixelRatio every size and offset lies on the device-pixel grid', () => {
  setDpr(1.25);
  // 1001 × 601 image pixels are 800.8 × 480.8 CSS pixels; centred in 1000 × 800 the offsets would be 99.6 / 159.6.
  const file = png(1001, 601);
  render(<Viewer file={file} />);
  fireEvent.click(button('100%'));
  expect(percent()).toBe('100%');
  for (const element of [box(), ...images()]) {
    for (const value of [element.style.width, element.style.height, element.style.left, element.style.top]) onDeviceGrid(value, 1.25);
  }
  expect(px(large(file)!.style.width) * 1.25).toBeCloseTo(1001, 6);
  expect(px(large(file)!.style.height) * 1.25).toBeCloseTo(601, 6);

  fireEvent.click(button('Rotate'));
  fireEvent.click(button('100%'));
  expect(px(box().style.width) * 1.25).toBeCloseTo(601, 6);
  expect(px(box().style.height) * 1.25).toBeCloseTo(1001, 6);
  for (const element of [box(), ...images()]) {
    for (const value of [element.style.width, element.style.height, element.style.left, element.style.top]) onDeviceGrid(value, 1.25);
  }
  expect(large(file)!.style.transform).toBe('rotate(90deg)');
});

it('the stage does not select text while panning', () => {
  render(<Viewer file={png(4000, 2000)} />);
  expect(stage().className.split(/\s+/)).toContain('select-none');
});

it('TIFF loads its converted rendition; an oversized image its reduced one with a marker', () => {
  const tiff = fileRecord({ mimeType: 'image/tiff', originalName: 'scan.tif', width: 100, height: 100 });
  const { unmount } = render(<Viewer file={tiff} />);
  expect(large(tiff)?.src).toBe(`assetforge-media://preview/${tiff.id}?size=full`);
  expect(percent()).toBe('100%');
  expect(screen.queryByRole('img')).toBeNull();
  unmount();

  const huge = png(12000, 9000);
  render(<Viewer file={huge} />);
  expect(large(huge)?.src).toBe(`assetforge-media://preview/${huge.id}?size=full`);
  const marker = screen.getByRole('img', { name: 'Reduced from 12000 × 9000 px' });
  expect(marker.getAttribute('title')).toBe('Reduced from 12000 × 9000 px');
  expect(percent()).toBe('8%');
  fireEvent.click(button('100%'));
  expect(large(huge)!.style.width).toBe('12000px');
});

it('without dimensions only the preview is shown, relative to its own size', () => {
  const file = png(null, null);
  render(<Viewer file={file} />);
  expect(images()).toHaveLength(1);
  expect(preview(file)).toBeDefined();
  expect(screen.getByRole('img', { name: 'Preview only' })).toBeTruthy();
  expect(button('100%').disabled).toBe(true);

  const img = preview(file)!;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1024 });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 512 });
  fireEvent.load(img);
  expect(percent()).toBe('98%');
  fireEvent.doubleClick(stage());
  expect(percent()).toBe('98%');
  expect(button('Fit').getAttribute('aria-pressed')).toBe('true');
});

it('another file resets zoom and rotation and mounts exactly one large image', () => {
  const first = png(4000, 2000);
  const second = png(4000, 2000);
  const { rerender } = render(<Viewer file={first} />);
  fireEvent.click(button('Rotate'));
  fireEvent.click(button('100%'));
  rerender(<Viewer file={second} />);
  expect(percent()).toBe('25%');
  expect(button('Fit').getAttribute('aria-pressed')).toBe('true');
  expect(box().style.width).toBe('1000px');
  const larges = images().filter((img) => img.src.startsWith('assetforge-media://original/'));
  expect(larges.map((img) => img.src)).toEqual([`assetforge-media://original/${second.id}`]);
});
