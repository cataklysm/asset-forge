// Shared class strings. The application is dark only; colours come from the design tokens in index.css.

export const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

/** Hover background of list items that are links (tiles, table rows). */
export const ITEM_HOVER = 'hover:bg-raised';

/**
 * The one button look: every button in the application looks the same, only its size differs.
 * A toggle button (`aria-pressed`) shows its pressed state through the same look.
 */
export const BUTTON_LOOK = `inline-flex items-center justify-center gap-2 rounded-control border border-line bg-raised text-sm text-text hover:border-line-strong disabled:opacity-50 aria-pressed:border-accent aria-pressed:bg-nav-active ${FOCUS}`;

export const BUTTON = `${BUTTON_LOOK} h-9 px-3.5`;
export const ICON_BUTTON = `${BUTTON_LOOK} h-9 w-9`;
/** Compact variants for use inside rows and tiles. */
export const BUTTON_INLINE = `${BUTTON_LOOK} h-8 px-3.5`;
export const ICON_BUTTON_INLINE = `${BUTTON_LOOK} h-8 w-8`;

export const INPUT = `h-9 rounded-control border border-line bg-surface px-2.5 text-text placeholder:text-muted ${FOCUS}`;

export const SELECT = `h-9 rounded-control border border-line bg-surface px-2.5 text-text ${FOCUS}`;

const CHIP_BASE = 'inline-flex h-[26px] items-center gap-1 rounded-control border bg-transparent px-2.5 text-[13px] font-normal';

export const CHIP = `${CHIP_BASE} border-line-strong text-text`;

export const FILTER_CHIP = `${CHIP_BASE} border-accent text-accent`;

export const MUTED = 'text-muted';

export const BORDER = 'border-line';

export const ALERT = 'rounded-control border border-danger bg-danger-soft p-3 text-danger';

export const WARNING = 'rounded-control border border-warning bg-surface p-3 text-warning';

export const LABEL = 'text-sm font-normal text-muted';

export const PAGE_TITLE = 'text-[28px] font-semibold text-text';

/** Workspace name in the header: 24/600. */
export const WORKSPACE_TITLE = 'text-2xl font-semibold text-text';

export const SECTION_TITLE = 'text-lg font-semibold text-text';

export const TILE_TITLE = 'truncate text-[17px] font-semibold text-text';

export const COUNT = 'text-[28px] font-normal tabular-nums text-muted';
