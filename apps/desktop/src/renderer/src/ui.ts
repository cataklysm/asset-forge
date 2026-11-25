// Shared class strings, so both screens look the same in light and dark mode.

export const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500';

/** Hover background of list items that are links (tiles, table rows). */
export const ITEM_HOVER = 'hover:bg-slate-100 dark:hover:bg-slate-800';

/**
 * The one button style: every button in the application looks the same. A toggle button
 * (`aria-pressed`) shows its pressed state through the same style.
 */
export const BUTTON = `rounded border border-slate-300 bg-slate-100 px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-200 disabled:opacity-50 aria-pressed:border-slate-500 aria-pressed:bg-slate-300 aria-pressed:font-medium dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:aria-pressed:border-slate-400 dark:aria-pressed:bg-slate-600 ${FOCUS}`;

export const INPUT = `rounded border border-slate-300 bg-transparent px-2 py-1.5 placeholder:text-slate-500 dark:border-slate-700 ${FOCUS}`;

export const MUTED = 'text-slate-600 dark:text-slate-400';

export const BORDER = 'border-slate-300 dark:border-slate-700';

export const ALERT =
  'rounded border border-red-300 bg-red-50 p-3 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200';
