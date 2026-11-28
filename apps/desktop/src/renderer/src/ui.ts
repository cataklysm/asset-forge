// Shared class strings. The application is dark only; colours come from the design tokens in index.css.

/** The keyboard focus ring of every interactive element. */
export const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

/** Hover background of list items that are links (tiles, table rows). */
export const ITEM_HOVER = 'hover:bg-raised';

/**
 * The one button look: every button in the application looks the same, only its size differs.
 * A toggle button (`aria-pressed`) shows its pressed state through the same look.
 */
export const BUTTON_LOOK = `inline-flex items-center justify-center gap-2 rounded-control border border-line bg-raised text-sm text-text hover:border-line-strong disabled:opacity-50 aria-disabled:opacity-50 aria-pressed:border-accent aria-pressed:bg-nav-active ${FOCUS}`;

/** The standard button. */
export const BUTTON = `${BUTTON_LOOK} h-9 px-3.5`;
/** A square button that holds only an icon. */
export const ICON_BUTTON = `${BUTTON_LOOK} h-9 w-9`;
/** Compact variants for use inside rows and tiles. */
export const BUTTON_INLINE = `${BUTTON_LOOK} h-8 px-3.5`;
/** The compact icon button. */
export const ICON_BUTTON_INLINE = `${BUTTON_LOOK} h-8 w-8`;

/** A single-line text field. */
export const INPUT = `h-9 rounded-control border border-line bg-surface px-2.5 text-text placeholder:text-muted ${FOCUS}`;

/** A multi-line text field in the look of `INPUT`. */
export const TEXTAREA = `min-h-40 resize-y rounded-control border border-line bg-surface p-2.5 text-text placeholder:text-muted ${FOCUS}`;

/** An input that reads as an action in a row of chips ("+ Add tag"); its box shows while focused. */
export const INLINE_INPUT = `h-[26px] w-28 rounded-control border border-transparent bg-transparent px-1 text-sm text-text placeholder:text-accent focus:border-line ${FOCUS}`;

/** A select in the look of `INPUT`. */
export const SELECT = `h-9 rounded-control border border-line bg-surface px-2.5 text-text ${FOCUS}`;

/** Shape and type shared by every chip; each chip adds one border and one text colour. */
const CHIP_BASE =
  'inline-flex h-[26px] items-center gap-1 rounded-control border bg-transparent px-2.5 text-[13px] font-normal';

/** A manual tag. */
export const CHIP = `${CHIP_BASE} border-line-strong text-text`;

/** A tag proposed by the AI: its own colour, so it stays distinguishable from manual tags. */
export const AI_CHIP = `${CHIP_BASE} border-ai text-ai`;

/** An active filter value. */
export const FILTER_CHIP = `${CHIP_BASE} border-accent text-accent`;

/** A tag that matched the active tag filter: accent border, normal text. */
export const MATCHED_CHIP = `${CHIP_BASE} border-accent text-text`;

/** Secondary text. */
export const MUTED = 'text-muted';

/** The colour of separators and box borders. */
export const BORDER = 'border-line';

/** A box holding an error message. */
export const ALERT = 'rounded-control border border-danger bg-danger-soft p-3 text-danger';

/** A box holding a warning. */
export const WARNING = 'rounded-control border border-warning bg-surface p-3 text-warning';

/** The caption of a form field or a detail row. */
export const LABEL = 'text-sm font-normal text-muted';

/** The heading of a screen. */
export const PAGE_TITLE = 'text-[28px] font-semibold text-text';

/** Workspace name in the header: 24/600. */
export const WORKSPACE_TITLE = 'text-2xl font-semibold text-text';

/** The heading of a section within a screen or dialog. */
export const SECTION_TITLE = 'text-lg font-semibold text-text';

/** Headings inside a side panel (the details column of the file dialog). */
export const PANEL_TITLE = 'text-base font-semibold text-text';

/** The name on a tile, cut to one line. */
export const TILE_TITLE = 'truncate text-[17px] font-semibold text-text';

/** A count beside a page title. */
export const COUNT = 'text-[28px] font-normal tabular-nums text-muted';
