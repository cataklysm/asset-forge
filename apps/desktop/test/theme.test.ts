import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, nativeTheme: { themeSource: 'system' } }));

import { WINDOW_APPEARANCE } from '../src/main/window.js';
import { BUTTON, BUTTON_INLINE, BUTTON_LOOK, ICON_BUTTON, ICON_BUTTON_INLINE } from '../src/renderer/src/ui.js';

const readUi = () => readFileSync(new URL('../src/renderer/src/ui.ts', import.meta.url), 'utf8');

describe('design tokens and window appearance', () => {
  it('declares every design token with the spec value', () => {
    const css = readFileSync(new URL('../src/renderer/src/index.css', import.meta.url), 'utf8');
    for (const [name, value] of Object.entries({
      bg: '#060b1d',
      surface: '#0c1428',
      raised: '#131d36',
      'nav-active': '#26324d',
      line: '#2a3550',
      'line-strong': '#4a5670',
      text: '#e8ebf2',
      muted: '#97a1b5',
      accent: '#38c6f4',
      'accent-soft': '#0f2b3d',
      danger: '#f87171',
      'danger-soft': '#2a1015',
      warning: '#fbbf24',
    }))
      expect(css).toMatch(new RegExp(`--color-${name}: *${value};`, 'i'));
  });

  it('the window background equals the page token and the minimum size is 1024 × 680', () => {
    expect(WINDOW_APPEARANCE).toEqual({ backgroundColor: '#060b1d', minWidth: 1024, minHeight: 680 });
  });

  it('every button style shares one look and ui.ts has no light/dark literals', () => {
    for (const s of [BUTTON, ICON_BUTTON, BUTTON_INLINE, ICON_BUTTON_INLINE]) expect(s).toContain(BUTTON_LOOK);
    expect(readUi()).not.toMatch(/dark:|slate-/);
  });
});
