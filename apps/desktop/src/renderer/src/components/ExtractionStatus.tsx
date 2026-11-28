import { Check, CircleAlert, Download, LoaderCircle, Minus } from 'lucide-react';
import type { SiteCrawlTaskSummary } from '@assetforge/contracts';
import { extractionStatus, processedDownloads } from './extraction-presentation';

/** @param task workflow phase @returns an icon whose meaning matches the phase */
function statusIcon(task: SiteCrawlTaskSummary) {
  switch (task.status) {
    case 'completed':
      return Check;
    case 'ready':
      return Download;
    case 'failed':
    case 'import_failed':
      return CircleAlert;
    case 'cancelled':
      return Minus;
    default:
      return LoaderCircle;
  }
}

/**
 * A compact phase badge that distinguishes completion, attention and work in progress without relying on color alone.
 * @param props saved extraction
 * @returns status badge
 */
export function ExtractionStatus({ task }: { task: SiteCrawlTaskSummary }) {
  const failed = task.status === 'failed' || task.status === 'import_failed';
  const Icon = statusIcon(task);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ${failed ? 'bg-danger-soft text-danger' : task.status === 'completed' ? 'bg-accent-soft text-accent' : 'bg-raised text-muted'}`}
    >
      <Icon size={12} aria-hidden className={task.status === 'running' ? 'animate-spin' : undefined} />
      {extractionStatus(task)}
    </span>
  );
}

/**
 * A bounded import progress bar with accessible numeric values.
 * @param props saved extraction with tracked counts
 * @returns progress indicator, or nothing before import tracking
 */
export function ExtractionProgress({ task }: { task: SiteCrawlTaskSummary }) {
  const processed = processedDownloads(task);
  if (processed === null || task.downloads == null || task.downloads.total === 0) return null;
  return (
    <span
      role="progressbar"
      aria-label="Download progress"
      aria-valuemin={0}
      aria-valuemax={task.downloads.total}
      aria-valuenow={processed}
      className="block h-1.5 overflow-hidden rounded-full bg-raised"
    >
      <span
        className={`block h-full rounded-full transition-[width] ${task.status === 'import_failed' ? 'bg-warning' : 'bg-accent'}`}
        style={{ width: `${task.downloads.total === 0 ? 0 : (processed / task.downloads.total) * 100}%` }}
      />
    </span>
  );
}
