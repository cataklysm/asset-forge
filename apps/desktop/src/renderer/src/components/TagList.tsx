import { Image as ImageIcon } from 'lucide-react';
import { CHIP } from '../ui';
import { TagChip } from './TagChip';

interface Props {
  tags: readonly { name: string; displayName: string }[];
  kind: 'asset' | 'file' | 'prompt';
  max: number;
  matched?: ReadonlySet<string>;
  /** Wraps onto further lines instead of clipping at the end of one line. */
  wrap?: boolean;
}

/** A read-only line of tags; file tags are preceded by one image icon. Renders nothing without tags. */
export function TagList({ tags, kind, max, matched, wrap = false }: Props) {
  if (tags.length === 0) return null;
  const shown = tags.length > max ? tags.slice(0, max) : tags;
  const hidden = tags.length - shown.length;
  return (
    <div className={`flex min-w-0 items-center gap-1.5 ${wrap ? '' : 'overflow-hidden whitespace-nowrap'}`}>
      {kind === 'file' && <ImageIcon size={16} role="img" aria-label="Image tags" className="shrink-0 text-muted" />}
      <ul aria-label={kind === 'asset' ? 'Asset tags' : kind === 'prompt' ? 'Prompt tags' : undefined} className={`flex min-w-0 items-center gap-1.5 ${wrap ? 'flex-wrap' : ''}`}>
        {shown.map((tag) => (
          <li key={tag.name} className="min-w-0">
            <TagChip tag={tag} matched={matched?.has(tag.name) ?? false} />
          </li>
        ))}
        {hidden > 0 && (
          <li className="shrink-0">
            <span className={CHIP} title={tags.map((tag) => tag.displayName).join(', ')}>
              +{hidden}
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}
