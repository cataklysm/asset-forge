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

/** The props of {@link StudioResults}. */
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

/** The mark of each tile state without a ready output. */
const MARKS: Record<Exclude<TileState, 'ready'>, string> = {
  queued: GENERATION_STATUS_LABELS.pending,
  running: GENERATION_STATUS_LABELS.running,
  failed: GENERATION_STATUS_LABELS.failed,
  cancelled: GENERATION_STATUS_LABELS.cancelled,
  trashed: TRASHED_MARK,
  deleted: DELETED_MARK,
};

/** The upscale factors offered. */
const SCALES: readonly UpscaleScale[] = [2, 4];

/** The look of a mark tile. */
const TILE = `flex aspect-square w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-control border bg-raised p-2 ${BORDER}`;

/** The props of {@link MarkTile}. */
interface MarkTileProps {
  g: Generation;
  busy: boolean;
  onRetry(g: Generation): void;
  onRemove(g: Generation): void;
}

/**
 * A tile of a generation that has no ready output: its mark, the name of a gone output, Retry and Remove when settled.
 *
 * @param props the generation, the busy flag and the callbacks
 * @returns the tile
 */
function MarkTile({ g, busy, onRetry, onRemove }: MarkTileProps) {
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

/** The tile grid. */
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3';

/**
 * The file of a generation's ready output.
 *
 * @param g the generation
 * @returns the output and its file, or null while the generation has no ready output
 */
function readyOutput(g: Generation): { name: string; fileId: string } | null {
  const output = g.outputs[0];
  if (tileState(g) !== 'ready' || output === undefined || output.fileId === null) return null;
  return { name: output.name, fileId: output.fileId };
}

/** The props of {@link UpscaleTiles}. */
interface UpscaleTilesProps {
  upscales: readonly Generation[];
  busy: boolean;
  onOpen(fileId: string): void;
  onDelete(fileId: string): void;
  onRetry(g: Generation): void;
  onRemove(g: Generation): void;
}

/**
 * The upscales of the selected result as tiles with Open and Delete.
 *
 * @param props the upscales, the busy flag and the callbacks
 * @returns the list
 */
function UpscaleTiles({ upscales, busy, onOpen, onDelete, onRetry, onRemove }: UpscaleTilesProps) {
  return (
    <ul aria-label={UPSCALES_LABEL} className={GRID}>
      {upscales.map((g) => {
        const output = readyOutput(g);
        if (output === null) return <MarkTile key={g.id} g={g} busy={busy} onRetry={onRetry} onRemove={onRemove} />;
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
  );
}

/** The props of {@link SelectedResult}. */
interface SelectedResultProps extends Omit<Props, 'generations' | 'selectedId' | 'onSelect'> {
  selected: Generation;
  /** The name of its output. */
  name: string;
  /** The file of its output. */
  fileId: string;
}

/**
 * The selected ready result large with its actions and, below it, its upscales.
 *
 * @param props the result, its upscales and the callbacks
 * @returns the section
 */
function SelectedResult(props: SelectedResultProps) {
  const { selected, name, fileId, busy, upscaleBlocked } = props;
  return (
    <section aria-label={name} className="flex flex-col gap-3">
      <CoverImage fileId={fileId} size="detail" fallback={formatLabel(name)} className="h-96 w-full" />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} onClick={() => props.onOpen(fileId)}>
          {OPEN_LABEL}
        </button>
        {SCALES.map((scale) => (
          <button
            key={scale}
            type="button"
            className={BUTTON}
            disabled={busy || upscaleBlocked !== null}
            title={upscaleBlocked ?? undefined}
            onClick={() => props.onUpscale(fileId, scale)}
          >
            {upscaleLabel(scale)}
          </button>
        ))}
        <button type="button" className={BUTTON} disabled={busy} onClick={() => props.onUseSettings(selected)}>
          {USE_SETTINGS_LABEL}
        </button>
        <button type="button" className={BUTTON} title={DELETE_TITLE} disabled={busy} onClick={() => props.onDelete(fileId)}>
          {DELETE_LABEL}
        </button>
      </div>
      {props.upscales.length > 0 && (
        <UpscaleTiles
          upscales={props.upscales}
          busy={busy}
          onOpen={props.onOpen}
          onDelete={props.onDelete}
          onRetry={props.onRetry}
          onRemove={props.onRemove}
        />
      )}
    </section>
  );
}

/**
 * The results of the studio as tiles, and the selected ready result large with its actions and,
 * below it, the upscales made from it (one level, no upscales of upscales).
 *
 * @param props the results, the selection and the callbacks
 * @returns the results column
 */
export function StudioResults(props: Props) {
  const { generations, selectedId, onSelect, busy, onRetry, onRemove } = props;
  const selected = generations.find((g) => g.id === selectedId && tileState(g) === 'ready') ?? null;
  const selectedOutput = selected?.outputs[0] ?? null;
  const selectedFileId = selectedOutput?.fileId ?? null;

  return (
    <div className="flex flex-col gap-4">
      <h3 className={PANEL_TITLE}>{RESULTS_LABEL}</h3>
      {selected !== null && selectedOutput !== null && selectedFileId !== null && (
        <SelectedResult {...props} selected={selected} name={selectedOutput.name} fileId={selectedFileId} />
      )}
      <ul aria-label={RESULTS_LABEL} className={GRID}>
        {generations.map((g) => {
          const output = readyOutput(g);
          if (output === null) return <MarkTile key={g.id} g={g} busy={busy} onRetry={onRetry} onRemove={onRemove} />;
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
                  fileId={output.fileId}
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
