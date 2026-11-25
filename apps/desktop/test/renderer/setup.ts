import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    const rect = { width: 1280, height: 800 } as DOMRectReadOnly;
    const entry = { target, contentRect: rect } as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

for (const property of ['clientWidth', 'offsetWidth'])
  Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get: () => 1280 });
for (const property of ['clientHeight', 'offsetHeight'])
  Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get: () => 800 });
HTMLElement.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 800, width: 1280, height: 800, toJSON: () => ({}) }) as DOMRect;

// jsdom implements <dialog> only partly.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  if (!this.open) return;
  this.open = false;
  this.dispatchEvent(new Event('close'));
};
Element.prototype.scrollTo = () => {};

afterEach(() => cleanup());
