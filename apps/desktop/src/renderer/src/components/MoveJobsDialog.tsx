import { useEffect, useRef, useState } from 'react';
import {
  JOB_ERROR_MESSAGES,
  isVisionKind,
  purposeOf,
  type ProviderList,
  type WaitingByProvider,
} from '@assetforge/contracts';
import { call, describeError } from '../api';
import { useJobs } from '../jobs-context';
import {
  CANCEL_LABEL,
  CHOOSE_MODEL,
  COUNTING_WAITING_JOBS,
  laneLabel,
  MODEL_NOT_LISTED,
  MODEL_NOT_VISION,
  MOVE_FROM,
  MOVE_JOBS_LABEL,
  MOVE_LABEL,
  MOVE_TO,
  NO_WAITING_JOBS,
  PROVIDER_STATE_LABELS,
  WAITING_COUNT,
} from '../labels';
import {
  defaultModelOf,
  defaultProviderId,
  providerStatus,
  useProviders,
  type ProvidersState,
} from '../provider-context';
import { ALERT, BUTTON, LABEL, SELECT } from '../ui';
import { Dialog } from './Dialog';
import { ModelSelect } from './ModelSelect';
import { ProviderSelect } from './ProviderSelect';

/** The props of `MoveJobsDialog`. */
interface Props {
  /** The lane whose waiting jobs move: undefined offers a select over the lanes; null is the jobs without a provider. */
  source: string | null | undefined;
  onClose(): void;
}

/** The target entry and model of a move. */
interface MoveChoice {
  target: string | null;
  model: string | null;
}

/**
 * The name of lane `id`: the entry's current name when it is listed, else the stored one, else a fixed label.
 *
 * @param list the provider list; null while not loaded
 * @param id the lane; null is the jobs without a provider
 * @param stored the provider name stored with the jobs
 * @returns the name
 */
export function laneName(list: ProviderList | null, id: string | null, stored: string | null): string {
  const entry = id === null ? undefined : list?.providers.find((provider) => provider.id === id);
  return entry?.name ?? laneLabel(id, stored);
}

/**
 * The value of a lane in the From select.
 *
 * @param id the lane; null is the jobs without a provider
 * @returns the value; the lane without a provider is the empty string
 */
const laneValue = (id: string | null) => id ?? '';

/**
 * Whether `id` names a listed vision entry (Ollama or OpenAI-compatible): only those take analysis jobs.
 *
 * @param list the provider list; null while not loaded
 * @param id the entry
 * @returns true for a listed vision entry
 */
const isTarget = (list: ProviderList | null, id: string | null) =>
  id !== null && list?.providers.some((provider) => provider.id === id && isVisionKind(provider.kind)) === true;

/**
 * Whether `id` names a listed image entry: its generation jobs never move, so it is no source either.
 *
 * @param list the provider list; null while not loaded
 * @param id the lane
 * @returns true for a listed image entry
 */
const isImageLane = (list: ProviderList | null, id: string | null) =>
  id !== null &&
  list?.providers.some((provider) => provider.id === id && purposeOf(provider.kind) === 'image') === true;

/**
 * The target a move preselects: the default vision entry unless it is the source, else the first other one.
 *
 * @param state the provider list
 * @param source the lane the jobs move from
 * @returns the target, null when there is none
 */
function pickTarget(state: Pick<ProvidersState, 'list'>, source: string | null | undefined): string | null {
  const preferred = defaultProviderId(state, 'vision');
  if (preferred !== null && preferred !== source) return preferred;
  return state.list?.providers.find((provider) => isVisionKind(provider.kind) && provider.id !== source)?.id ?? null;
}

/**
 * The lane the jobs move from: the fixed source, else the chosen lane while it has waiting jobs, else the first.
 *
 * @param source the source given to the dialog; undefined offers a choice
 * @param chosenSource the lane chosen in the From select; undefined until one is chosen
 * @param lanes the lanes with waiting jobs; null while counting
 * @returns the lane, undefined when there is none yet
 */
function fromLane(
  source: string | null | undefined,
  chosenSource: string | null | undefined,
  lanes: readonly WaitingByProvider[] | null,
): string | null | undefined {
  if (source !== undefined) return source;
  if (chosenSource !== undefined && lanes?.some((lane) => lane.providerId === chosenSource)) return chosenSource;
  return lanes?.[0]?.providerId;
}

/**
 * The target and model in force: the user's choice while its target is a listed vision entry other than the
 * source, otherwise the preselection with the target's default tagging model.
 *
 * @param providers the provider state
 * @param choice the user's choice; null while the preselection applies
 * @param from the lane the jobs move from
 * @returns the target and model
 */
function effectiveChoice(
  providers: ProvidersState,
  choice: MoveChoice | null,
  from: string | null | undefined,
): MoveChoice {
  if (choice !== null && choice.target !== from && isTarget(providers.list, choice.target)) return choice;
  const target = pickTarget(providers, from);
  return { target, model: defaultModelOf(providers, target, 'tagging') };
}

/**
 * Why the move cannot start, as the tooltip of the disabled Move button.
 *
 * @param providers the provider state
 * @param choice the target and model in force
 * @param waiting the count of waiting jobs; null while counting
 * @param lanesError why the counts could not be read; null when they could
 * @param from the lane the jobs move from
 * @returns the reason, null when it can start
 */
function blockedReason(
  providers: ProvidersState,
  { target, model }: MoveChoice,
  waiting: number | null,
  lanesError: string | null,
  from: string | null | undefined,
): string | null {
  if (target === null) return JOB_ERROR_MESSAGES.provider_not_configured;
  const status = providerStatus(providers, target);
  if (status !== 'ready') return PROVIDER_STATE_LABELS[status];
  if (model === null) return CHOOSE_MODEL;
  const answer = providers.models[target];
  if (answer !== undefined && answer.ok) {
    const entry = answer.models.find((listed) => listed.name === model);
    if (entry === undefined) return MODEL_NOT_LISTED;
    if (entry.vision === false) return MODEL_NOT_VISION;
  }
  if (waiting === null) return lanesError === null ? COUNTING_WAITING_JOBS : null;
  if (waiting === 0 || from === undefined) return NO_WAITING_JOBS;
  return null;
}

/**
 * Moves every waiting analysis job of one provider onto another provider and model (`jobs:reroute`).
 * Mounted while open; after a move it polls the job summary and closes, a refusal stays in the dialog.
 *
 * @param props the source lane and the close handler
 */
export function MoveJobsDialog({ source, onClose }: Props) {
  const providers = useProviders();
  const { refresh } = useJobs();
  const [allLanes, setLanes] = useState<WaitingByProvider[] | null>(null);
  const lanes = allLanes === null ? null : allLanes.filter((lane) => !isImageLane(providers.list, lane.providerId));
  const [lanesError, setLanesError] = useState<string | null>(null);
  // The From choice when no source is given; undefined until one is chosen.
  const [chosenSource, setChosenSource] = useState<string | null | undefined>(undefined);
  // The user's target and model; null while the preselection applies.
  const [choice, setChoice] = useState<MoveChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
  const disposed = useRef(false);

  const { checkAll } = providers;
  useEffect(() => {
    disposed.current = false;
    checkAll();
    call('jobs:waitingByProvider', {}).then(
      (answer) => {
        if (!disposed.current) setLanes(answer);
      },
      (failure) => {
        if (!disposed.current) setLanesError(describeError(failure));
      },
    );
    return () => {
      disposed.current = true;
    };
    // The states and the counts are asked once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fixed = source !== undefined;
  const from = fromLane(source, chosenSource, lanes);
  const lane = from === undefined ? undefined : lanes?.find((listed) => listed.providerId === from);
  const waiting = lanes === null ? null : (lane?.waiting ?? 0);
  const fromName = from === undefined ? null : laneName(providers.list, from, lane?.providerName ?? null);

  const effective = effectiveChoice(providers, choice, from);
  const { target, model } = effective;

  const blocked = blockedReason(providers, effective, waiting, lanesError, from);
  const canMove = blocked === null && !moving && waiting !== null && from !== undefined;

  /** Sends the move; closes after it, a refusal stays in the dialog. */
  async function move() {
    if (movingRef.current || !canMove || target === null || model === null || from === undefined) return;
    movingRef.current = true;
    setMoving(true);
    setError(null);
    try {
      await call('jobs:reroute', { fromProviderId: from, toProviderId: target, model });
      refresh();
      if (!disposed.current) onClose();
    } catch (failure) {
      if (!disposed.current) setError(describeError(failure));
    } finally {
      movingRef.current = false;
      if (!disposed.current) setMoving(false);
    }
  }

  return (
    <Dialog open title={MOVE_JOBS_LABEL} onClose={() => !moving && onClose()}>
      <div className="flex flex-col gap-4">
        {(error ?? lanesError) !== null && (
          <p role="alert" className={ALERT}>
            {error ?? lanesError}
          </p>
        )}
        <div className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3">
          <span className={LABEL}>{MOVE_FROM}</span>
          {fixed ? (
            <span className="truncate" title={fromName ?? undefined}>
              {fromName}
            </span>
          ) : (
            <select
              className={`min-w-0 ${SELECT}`}
              aria-label={MOVE_FROM}
              value={from === undefined ? '' : laneValue(from)}
              disabled={moving || lanes === null || lanes.length === 0}
              aria-busy={lanes === null || undefined}
              onChange={(event) => {
                const next = lanes?.find((listed) => laneValue(listed.providerId) === event.target.value);
                if (next !== undefined) setChosenSource(next.providerId);
              }}
            >
              {(lanes ?? []).map((listed) => (
                <option key={laneValue(listed.providerId)} value={laneValue(listed.providerId)}>
                  {laneName(providers.list, listed.providerId, listed.providerName)}
                </option>
              ))}
            </select>
          )}
          <span className="text-sm tabular-nums" aria-live="polite">
            {waiting === null ? '' : WAITING_COUNT(waiting)}
          </span>
          <span className={LABEL}>{MOVE_TO}</span>
          <div className="col-span-2 flex min-w-0 flex-col gap-3">
            <ProviderSelect
              purpose="vision"
              value={target}
              exclude={from ?? null}
              disabled={moving}
              onChange={(id) => setChoice({ target: id, model: defaultModelOf(providers, id, 'tagging') })}
            />
            <ModelSelect
              providerId={target}
              purpose="tagging"
              value={model}
              disabled={moving || target === null}
              onChange={(next) => setChoice({ target, model: next })}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} disabled={moving} onClick={onClose}>
            {CANCEL_LABEL}
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={!canMove}
            title={blocked ?? undefined}
            onClick={() => void move()}
          >
            {MOVE_LABEL}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
