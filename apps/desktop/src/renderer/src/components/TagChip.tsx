import type { TagOrigin } from '@assetforge/contracts';
import { Pencil, X } from 'lucide-react';
import { RENAME_LABEL, renameTagLabel } from '../labels';
import { AI_CHIP, CHIP, FILTER_CHIP, FOCUS, MATCHED_CHIP } from '../ui';

/** The props of `TagChip`. */
interface Props {
  /** The tag; `origin` absent for a tag that has none (a filter name). */
  tag: { name: string; displayName: string; origin?: TagOrigin };
  /** Removes the tag; absent hides the remove button. */
  onRemove?(): void;
  /** Renames the tag workspace-wide; the pencil sits before the remove button. */
  onRename?(): void;
  /** The look of a filter chip. */
  filter?: boolean;
  /** The look of a chip that matches the current filter. */
  matched?: boolean;
}

/** The classes of the pencil and remove buttons. */
const CHIP_BUTTON = `inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm opacity-80 hover:opacity-100 ${FOCUS}`;

/**
 * The chip classes: filter before matched before AI before the plain look.
 *
 * @param filter whether the chip is a filter chip
 * @param matched whether it matches the current filter
 * @param ai whether it shows an AI tag
 * @returns the class constant
 */
function chipLook(filter: boolean, matched: boolean, ai: boolean): string {
  if (filter) return FILTER_CHIP;
  if (matched) return MATCHED_CHIP;
  return ai ? AI_CHIP : CHIP;
}

/**
 * One tag, an AI tag in its own look; `origin` is also exposed as `data-origin`.
 *
 * @param props the tag, its look and the optional rename and remove callbacks
 * @returns the chip
 */
export function TagChip({ tag, onRemove, onRename, filter = false, matched = false }: Props) {
  const ai = tag.origin === 'ai' && !filter && !matched;
  const look = chipLook(filter, matched, ai);
  return (
    <span
      data-origin={tag.origin}
      data-matched={matched || undefined}
      title={ai ? 'AI tag' : undefined}
      className={`${look} max-w-full`}
    >
      <span className="truncate">{tag.displayName}</span>
      {onRename && (
        <button
          type="button"
          data-rename=""
          aria-label={renameTagLabel(tag.displayName)}
          title={RENAME_LABEL}
          onClick={onRename}
          className={onRemove ? CHIP_BUTTON : `-mr-1 ${CHIP_BUTTON}`}
        >
          <Pencil size={12} aria-hidden />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          data-remove=""
          aria-label={ai ? `Remove AI tag ${tag.displayName}` : `Remove ${tag.displayName}`}
          onClick={onRemove}
          className={`-mr-1 ${CHIP_BUTTON}`}
        >
          <X size={14} aria-hidden />
        </button>
      )}
    </span>
  );
}
