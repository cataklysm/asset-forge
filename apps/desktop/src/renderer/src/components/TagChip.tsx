import type { TagOrigin } from '@assetforge/contracts';
import { Pencil, X } from 'lucide-react';
import { RENAME_LABEL, renameTagLabel } from '../labels';
import { AI_CHIP, CHIP, FILTER_CHIP, FOCUS, MATCHED_CHIP } from '../ui';

interface Props {
  tag: { name: string; displayName: string; origin?: TagOrigin };
  onRemove?(): void;
  /** Renames the tag workspace-wide; the pencil sits before the remove button. */
  onRename?(): void;
  filter?: boolean;
  matched?: boolean;
}

const CHIP_BUTTON = `inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm opacity-80 hover:opacity-100 ${FOCUS}`;

/** One tag, an AI tag in its own look; `origin` is also exposed as `data-origin`. */
export function TagChip({ tag, onRemove, onRename, filter = false, matched = false }: Props) {
  const ai = tag.origin === 'ai' && !filter && !matched;
  const look = filter ? FILTER_CHIP : matched ? MATCHED_CHIP : ai ? AI_CHIP : CHIP;
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
