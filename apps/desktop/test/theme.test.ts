import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, nativeTheme: { themeSource: 'system' } }));

import { WINDOW_APPEARANCE } from '../src/main/window.js';
import {
  BUTTON,
  BUTTON_INLINE,
  BUTTON_LOOK,
  CHIP,
  COUNT,
  FILTER_CHIP,
  ICON_BUTTON,
  ICON_BUTTON_INLINE,
  PAGE_TITLE,
  PANEL_TITLE,
  SECTION_TITLE,
  TILE_TITLE,
  WORKSPACE_TITLE,
} from '../src/renderer/src/ui.js';

const RENDERER_SRC = fileURLToPath(new URL('../src/renderer/src/', import.meta.url));

/** Every .ts, .tsx and .css file under the renderer source, as absolute paths. */
function renderedSources(dir = RENDERER_SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return renderedSources(`${path}/`);
    return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

/** The relative luminance (WCAG 2) of a colour token written as `#rrggbb` in `css`. */
function luminance(css: string, name: string): number {
  const match = css.match(new RegExp(`--color-${name}: *#([0-9a-f]{6});`, 'i'));
  if (!match) throw new Error(`token ${name} missing`);
  const [red, green, blue] = [0, 2, 4]
    .map((start) => parseInt(match[1]!.slice(start, start + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** The contrast ratio (WCAG 2) of two colour tokens of `css`. */
function contrast(css: string, first: string, second: string): number {
  const [high, low] = [luminance(css, first), luminance(css, second)].sort((a, b) => b - a) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

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
      ai: '#b9a3ff',
    }))
      expect(css).toMatch(new RegExp(`--color-${name}: *${value};`, 'i'));
  });

  it('the AI colour has a contrast of at least 4.5 on the page and surface backgrounds', () => {
    const css = readFileSync(new URL('../src/renderer/src/index.css', import.meta.url), 'utf8');
    expect(contrast(css, 'ai', 'bg')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(css, 'ai', 'surface')).toBeGreaterThanOrEqual(4.5);
  });

  it('the window background equals the page token and the minimum size is 1024 × 680', () => {
    expect(WINDOW_APPEARANCE).toEqual({ backgroundColor: '#060b1d', minWidth: 1024, minHeight: 680 });
  });

  it('every button style shares one look and ui.ts has no light/dark literals', () => {
    for (const s of [BUTTON, ICON_BUTTON, BUTTON_INLINE, ICON_BUTTON_INLINE]) expect(s).toContain(BUTTON_LOOK);
    expect(readUi()).not.toMatch(/dark:|slate-/);
  });

  it('pins the button, chip and type specs', () => {
    const tokens = (s: string) => s.split(' ').filter(Boolean);
    for (const c of [
      'border-line',
      'bg-raised',
      'text-text',
      'rounded-control',
      'hover:border-line-strong',
      'aria-pressed:bg-nav-active',
      'aria-pressed:border-accent',
      'disabled:opacity-50',
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent',
    ])
      expect(tokens(BUTTON_LOOK)).toContain(c);
    expect(BUTTON_LOOK).not.toMatch(/hover:bg-/);
    expect(tokens(BUTTON)).toEqual(expect.arrayContaining(['h-9', 'px-3.5']));
    expect(tokens(ICON_BUTTON)).toEqual(expect.arrayContaining(['h-9', 'w-9']));
    expect(tokens(BUTTON_INLINE)).toEqual(expect.arrayContaining(['h-8', 'px-3.5']));
    expect(tokens(ICON_BUTTON_INLINE)).toEqual(expect.arrayContaining(['h-8', 'w-8']));
    expect(tokens(CHIP)).toEqual(
      expect.arrayContaining([
        'h-[26px]',
        'px-2.5',
        'text-[13px]',
        'font-normal',
        'rounded-control',
        'border-line-strong',
        'bg-transparent',
      ]),
    );
    expect(tokens(FILTER_CHIP)).toEqual(expect.arrayContaining(['border-accent', 'text-accent']));
    for (const chip of [CHIP, FILTER_CHIP]) {
      const t = tokens(chip);
      expect(t.filter((x) => x.startsWith('border-'))).toHaveLength(1);
      expect(t.filter((x) => /^bg-/.test(x))).toHaveLength(1);
      expect(t.filter((x) => /^text-(text|muted|accent)/.test(x))).toHaveLength(1);
    }
    expect(PAGE_TITLE).toContain('text-[28px] font-semibold');
    expect(WORKSPACE_TITLE).toContain('text-2xl font-semibold');
    expect(SECTION_TITLE).toContain('text-lg font-semibold');
    expect(PANEL_TITLE).toContain('text-base font-semibold');
    expect(TILE_TITLE).toContain('text-[17px] font-semibold');
    expect(COUNT).toContain('text-[28px] font-normal');
    expect(COUNT).toContain('text-muted');
  });

  it('no renderer source uses light/dark literals', () => {
    const files = renderedSources();
    expect(files.length).toBeGreaterThan(20);
    // The word boundary keeps utilities such as `translate-y-1/2` from matching `slate-`.
    for (const file of files)
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\bdark:|\bslate-|bg-white|text-black/);
  });
});
