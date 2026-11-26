import { JOB_ERROR_MESSAGES, type Generation, type UpscaleScale } from '@assetforge/contracts';
import {
  DELETE_LABEL,
  DELETE_TITLE,
  DELETED_MARK,
  GENERATION_STATUS_LABELS,
  OPEN_LABEL,
  REMOVE_LABEL,
  RESULTS_LABEL,
  RETRY_LABEL,
  TRASHED_MARK,
  UPSCALES_LABEL,
  USE_SETTINGS_LABEL,
  upscaleLabel,
} from '../labels';
import { formatLabel } from '../media-url';
import { tileState, type TileState } from '../studio-state';
import { BORDER, BUTTON, BUTTON_INLINE, FOCUS, MUTED, PANEL_TITLE } from '../ui';
import { CoverImage } from './CoverImage';

interface Props {
  /** Newest first. */
  generations: readonly Generation[];
  /** The upscales of the selected result, newest first. */
  upscales: readonly Generation[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  onOpen(fileId: string): void;
  onUpscale(fileId: string, scale: UpscaleScale): void;
  /** Why an upscale cannot start, as the tooltip of both buttons; null when it can. */
  upscaleBlocked: string | null;
  onUseSettings(g: Generation): void;
  onDelete(fileId: string): void;
  onRetry(g: Generation): void;
  onRemove(g: Generation): void;
  busy: boolean;
}

const MARKS: Record<Exclude<TileState, 'ready'>, string> = {
  queued: GENERATION_STATUS_LABELS.pending,
  running: GENERATION_STATUS_LABELS.running,
  failed: GENERATION_STATUS_LABELS.failed,
  cancelled: GENERATION_STATUS_LABELS.cancelled,
  trashed: TRASHED_MARK,
  deleted: DELETED_MARK,
};

const SCALES: readonly UpscaleScale[] = [2, 4];

const TILE = `flex aspect-square w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-control border bg-raised p-2 ${BORDER}`;

/** A tile of a generation that has no ready output: its mark, the name of a gone output, Retry and Remove when settled. */
function MarkTile({ g, busy, onRetry, onRemove }: { g: Generation; busy: boolean; onRetry(g: Generation): void; onRemove(g: Generation): void }) {
  const state = tileState(g);
  const output = g.outputs[0];
  const mark = MARKS[state as Exclude<TileState, 'ready'>];
  const message = state === 'failed' ? JOB_ERROR_MESSAGES[g.errorCode ?? 'internal_error'] : (output?.name ?? undefined);
  const settled = state === 'failed' || state === 'cancelled';
  const gone = (state === 'trashed' || state === 'deleted') && output !== undefined;
  return (
    <li aria-label={mark} aria-description={message} className={TILE}>
      <span title={message} className={`text-sm ${state === 'failed' ? 'text-danger' : MUTED}`}>
        {mark}
      </span>
      {gone && (
        <span title={output.name} className={`w-full truncate text-center text-xs ${MUTED}`}>
          {output.name}
        </span>
      )}
      {settled && (
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" className={BUTTON_INLINE} disabled={busy} onClick={() => onRetry(g)}>
            {RETRY_LABEL}
          </button>
          <button type="button" className={BUTTON_INLINE} disabled={busy} onClick={() => onRemove(g)}>
            {REMOVE_LABEL}
          </button>
        </div>
      )}
    </li>
  );
}

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3';

/**
 * The results of the studio as tiles, and the selected ready result large with its actions and,
 * below it, the upscales made from it (one level, no upscales of upscales).
 */
export function StudioResults({
  generations,
  upscales,
  selectedId,
  onSelect,
  onOpen,
  onUpscale,
  upscaleBlocked,
  onUseSettings,
  onDelete,
  onRetry,
  onRemove,
  busy,
}: Props) {
  const selected = generations.find((g) => g.id === selectedId && tileState(g) === 'ready') ?? null;
  const selectedOutput = selected?.outputs[0] ?? null;
  const selectedFileId = selectedOutput?.fileId ?? null;

  return (
    <div className="flex flex-col gap-4">
      <h3 className={PANEL_TITLE}>{RESULTS_LABEL}</h3>
      {selected !== null && selectedOutput !== null && selectedFileId !== null && (
        <section aria-label={selectedOutput.name} className="flex flex-col gap-3">
          <CoverImage fileId={selectedFileId} size="detail" fallback={formatLabel(selectedOutput.name)} className="h-96 w-full" />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} onClick={() => onOpen(selectedFileId)}>
              {OPEN_LABEL}
            </button>
            {SCALES.map((scale) => (
              <button
                key={scale}
                type="button"
                className={BUTTON}
                disabled={busy || upscaleBlocked !== null}
                title={upscaleBlocked ?? undefined}
                onClick={() => onUpscale(selectedFileId, scale)}
              >
                {upscaleLabel(scale)}
              </button>
            ))}
            <button type="button" className={BUTTON} disabled={busy} onClick={() => onUseSettings(selected)}>
              {USE_SETTINGS_LABEL}
            </button>
            <button type="button" className={BUTTON} title={DELETE_TITLE} disabled={busy} onClick={() => onDelete(selectedFileId)}>
              {DELETE_LABEL}
            </button>
          </div>
          {upscales.length > 0 && (
            <ul aria-label={UPSCALES_LABEL} className={GRID}>
              {upscales.map((g) => {
                const output = g.outputs[0];
                if (tileState(g) !== 'ready' || output === undefined || output.fileId === null) {
                  return <MarkTile key={g.id} g={g} busy={busy} onRetry={onRetry} onRemove={onRemove} />;
                }
                const fileId = output.fileId;
                return (
                  <li key={g.id} aria-label={output.name} title={output.name} className="flex flex-col gap-2">
                    <CoverImage fileId={fileId} size="thumb" fallback={formatLabel(output.name)} className={`aspect-square w-full border ${BORDER}`} />
                    <div className="flex flex-wrap justify-center gap-2">
                      <button type="button" className={BUTTON_INLINE} onClick={() => onOpen(fileId)}>
                        {OPEN_LABEL}
                      </button>
                      <button type="button" className={BUTTON_INLINE} title={DELETE_TITLE} disabled={busy} onClick={() => onDelete(fileId)}>
                        {DELETE_LABEL}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      <ul aria-label={RESULTS_LABEL} className={GRID}>
        {generations.map((g) => {
          const output = g.outputs[0];
          if (tileState(g) !== 'ready' || output === undefined || output.fileId === null) {
            return <MarkTile key={g.id} g={g} busy={busy} onRetry={onRetry} onRemove={onRemove} />;
          }
          const fileId = output.fileId;
          const pressed = g.id === selectedId;
          return (
            <li key={g.id} aria-label={output.name} title={output.name}>
              <button
                type="button"
                aria-label={output.name}
                aria-pressed={pressed}
                className={`block w-full rounded-control ${FOCUS}`}
                onClick={() => onSelect(pressed ? null : g.id)}
              >
                <CoverImage
                  fileId={fileId}
                  size="thumb"
                  fallback={formatLabel(output.name)}
                  className={`aspect-square w-full border ${pressed ? 'border-accent' : BORDER}`}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
