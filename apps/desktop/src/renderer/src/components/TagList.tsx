import { Image as ImageIcon } from 'lucide-react';
import { CHIP } from '../ui';
import { TagChip } from './TagChip';

/** The props of `TagList`. */
interface Props {
  /** The tags, in order. */
  tags: readonly { name: string; displayName: string }[];
  /** Whose tags these are; file tags get the image icon. */
  kind: 'asset' | 'file' | 'prompt';
  /** The most chips shown; the rest is one `+n` chip with every name as tooltip. Without it all are shown. */
  max?: number;
  /** The names shown in the matched look. */
  matched?: ReadonlySet<string>;
  /** Wraps onto further lines instead of clipping at the end of one line. */
  wrap?: boolean;
}

/**
 * The accessible name of the list; file tags are named by the image icon instead.
 *
 * @param kind whose tags these are
 * @returns the name, or undefined for file tags
 */
function listLabel(kind: Props['kind']): string | undefined {
  if (kind === 'asset') return 'Asset tags';
  return kind === 'prompt' ? 'Prompt tags' : undefined;
}

/**
 * A read-only line of tags; file tags are preceded by one image icon. Renders nothing without tags.
 *
 * @param props the tags, their owner kind, the limit, the matched names and the wrap flag
 * @returns the line, or null without tags
 */
export function TagList({ tags, kind, max, matched, wrap = false }: Props) {
  if (tags.length === 0) return null;
  const shown = max !== undefined && tags.length > max ? tags.slice(0, max) : tags;
  const hidden = tags.length - shown.length;
  return (
    <div className={`flex min-w-0 items-center gap-1.5 ${wrap ? '' : 'overflow-hidden whitespace-nowrap'}`}>
      {kind === 'file' && <ImageIcon size={16} role="img" aria-label="Image tags" className="shrink-0 text-muted" />}
      <ul aria-label={listLabel(kind)} className={`flex min-w-0 items-center gap-1.5 ${wrap ? 'flex-wrap' : ''}`}>
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
