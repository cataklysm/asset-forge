import type { TagOrigin } from '@assetforge/contracts';
import { X } from 'lucide-react';
import { CHIP, FILTER_CHIP, FOCUS, MATCHED_CHIP } from '../ui';

interface Props {
  tag: { name: string; displayName: string; origin?: TagOrigin };
  onRemove?(): void;
  filter?: boolean;
  matched?: boolean;
}

/** One tag. `origin` is exposed as `data-origin` so that AI tags can be styled apart later. */
export function TagChip({ tag, onRemove, filter = false, matched = false }: Props) {
  const look = filter ? FILTER_CHIP : matched ? MATCHED_CHIP : CHIP;
  return (
    <span data-origin={tag.origin} data-matched={matched || undefined} className={`${look} max-w-full`}>
      <span className="truncate">{tag.displayName}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${tag.displayName}`}
          onClick={onRemove}
          className={`-mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm opacity-80 hover:opacity-100 ${FOCUS}`}
        >
          <X size={14} aria-hidden />
        </button>
      )}
    </span>
  );
}
