import type { ReactNode } from 'react';
import type { AssetView } from '../list-state';
import { BUTTON, MUTED } from '../ui';
import { FileGridView, TILE_HEIGHT, TILE_WIDTH } from './FileGridView';
import { FileTable } from './FileTable';
import type { FileViewProps } from './FileTile';

// The list part of the file browser: Retry, the skeleton, the empty text or the grid or table view.

/** The number of placeholder tiles before the first page arrives. */
const SKELETON_TILES = 6;
/** What the list part of the browser shows. */
export interface FileListBodyProps {
  pending: boolean;
  /** A failed page while the total is unknown; null when none failed. */
  failedPage: number | null;
  total: number | null;
  /** The view's props; null while the list is unknown or empty. */
  viewProps: FileViewProps | null;
  filtered: boolean;
  emptyText: string;
  emptyAction?: ReactNode;
  view: AssetView;
  onRetry(page: number): void;
}

/**
 * The list part of the browser: Retry, the skeleton, the empty text or the grid or table view.
 *
 * @param props the state of the list
 * @returns the list part
 */
export function FileListBody(props: FileListBodyProps) {
  const { failedPage, total, viewProps, filtered, emptyText } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy={props.pending || undefined}>
      {failedPage !== null ? (
        <div>
          <button type="button" className={BUTTON} onClick={() => props.onRetry(failedPage)}>
            Retry
          </button>
        </div>
      ) : total === null ? (
        <div className="flex flex-wrap gap-4" aria-busy="true">
          {Array.from({ length: SKELETON_TILES }, (_, i) => (
            <div
              key={i}
              data-skeleton=""
              className="animate-pulse rounded-tile bg-raised"
              style={{ width: TILE_WIDTH, height: TILE_HEIGHT }}
            />
          ))}
        </div>
      ) : viewProps === null ? (
        filtered || props.emptyAction === undefined ? (
          <p className={MUTED}>{filtered ? 'No matching files' : emptyText}</p>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p className={MUTED}>{emptyText}</p>
            {props.emptyAction}
          </div>
        )
      ) : props.view === 'grid' ? (
        <FileGridView key={viewProps.viewKey} {...viewProps} />
      ) : (
        <FileTable key={viewProps.viewKey} {...viewProps} />
      )}
    </div>
  );
}
