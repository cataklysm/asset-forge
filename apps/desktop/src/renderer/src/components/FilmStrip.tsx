import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { VIDEO_LABEL } from '../labels';
import { formatLabel } from '../media-url';
import { MUTED } from '../ui';
import { CoverImage } from './CoverImage';
import type { ViewerList } from './FileBrowser';
import { VideoMark } from './FileTile';

// The film strip of the file detail dialog.

/** The tile size in pixels. */
const TILE = 96;
/** The gap between tiles in pixels. */
const GAP = 8;

/**
 * One row of thumbnails below the stage; a click shows that file. Hidden for fewer than two files.
 *
 * @param props the list the dialog was opened from
 * @returns the strip, or nothing
 */
export function FilmStrip({ list }: { list: ViewerList }) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    horizontal: true,
    count: list.total,
    getScrollElement: () => scroller.current,
    estimateSize: () => TILE,
    gap: GAP,
    overscan: 4,
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index;
  const last = items[items.length - 1]?.index;
  const { want, index } = list;
  useEffect(() => {
    if (first !== undefined && last !== undefined) want(first, last);
  }, [first, last, want]);
  useEffect(() => {
    virtualizer.scrollToIndex(index, { align: 'auto' });
    // The virtualizer instance is stable; only the current index matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  if (list.total < 2) return null;
  return (
    <div
      ref={scroller}
      role="group"
      aria-label="Files"
      className="h-[104px] shrink-0 overflow-x-auto overflow-y-hidden"
    >
      {/* Centred while narrower than the strip; scrolls once wider. */}
      <div className="relative mx-auto h-full" style={{ width: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const slot = list.slot(item.index);
          const current = item.index === list.index;
          const frame = `flex h-24 w-24 items-center justify-center overflow-hidden rounded-control border bg-raised text-xs ${
            current ? 'border-accent' : 'border-line'
          }`;
          const file = slot.kind === 'loaded' ? slot.item : null;
          const name =
            file === null
              ? undefined
              : file.kind === 'video'
                ? `${file.originalName}, ${VIDEO_LABEL}`
                : file.originalName;
          return (
            <button
              key={item.key}
              type="button"
              title={file?.originalName}
              aria-label={name}
              aria-current={current ? 'true' : undefined}
              className="absolute top-1 rounded-control"
              style={{ left: item.start, width: TILE, height: TILE }}
              onClick={() => list.show(item.index)}
            >
              {file === null ? (
                <span className={frame} />
              ) : file.status === 'complete' && file.thumbnail ? (
                <CoverImage fileId={file.id} size="thumb" fallback={formatLabel(file.originalName)} className={frame} />
              ) : (
                <span className={`${frame} ${MUTED}`}>
                  {file.status === 'complete' ? formatLabel(file.originalName) : ''}
                </span>
              )}
              {file?.kind === 'video' && <VideoMark className="absolute bottom-1 left-1" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
