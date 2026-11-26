import { useEffect, useRef, useState } from 'react';
import { JOB_ERROR_MESSAGES, type ProviderList, type WaitingByProvider } from '@assetforge/contracts';
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
import { defaultModelOf, defaultProviderId, providerStatus, useProviders, type ProvidersState } from '../provider-context';
import { ALERT, BUTTON, LABEL, SELECT } from '../ui';
import { Dialog } from './Dialog';
import { ModelSelect } from './ModelSelect';
import { ProviderSelect } from './ProviderSelect';

interface Props {
  /** The lane whose waiting jobs move: undefined offers a select over the lanes; null is the jobs without a provider. */
  source: string | null | undefined;
  onClose(): void;
}

/** The name of lane `id`: the entry's current name when it is listed, else the stored one, else a fixed label. */
export function laneName(list: ProviderList | null, id: string | null, stored: string | null): string {
  const entry = id === null ? undefined : list?.providers.find((p) => p.id === id);
  return entry?.name ?? laneLabel(id, stored);
}

/** The value of a lane in the From select; the lane without a provider is the empty string. */
const laneValue = (id: string | null) => id ?? '';

/** Whether `id` names a listed `ollama` entry: only those take analysis jobs. */
const isTarget = (list: ProviderList | null, id: string | null) =>
  id !== null && list?.providers.some((p) => p.id === id && p.kind === 'ollama') === true;

/** The target a move preselects: the default `ollama` entry unless it is the source, else the first other one. */
function pickTarget(state: Pick<ProvidersState, 'list'>, source: string | null | undefined): string | null {
  const preferred = defaultProviderId(state, 'ollama');
  if (preferred !== null && preferred !== source) return preferred;
  return state.list?.providers.find((p) => p.kind === 'ollama' && p.id !== source)?.id ?? null;
}

/**
 * Moves every waiting analysis job of one provider onto another provider and model (`jobs:reroute`).
 * Mounted while open; after a move it polls the job summary and closes, a refusal stays in the dialog.
 */
export function MoveJobsDialog({ source, onClose }: Props) {
  const providers = useProviders();
  const { refresh } = useJobs();
  const [lanes, setLanes] = useState<WaitingByProvider[] | null>(null);
  const [lanesError, setLanesError] = useState<string | null>(null);
  // The From choice when no source is given; undefined until one is chosen.
  const [chosenSource, setChosenSource] = useState<string | null | undefined>(undefined);
  // The user's target and model; null while the preselection applies.
  const [choice, setChoice] = useState<{ target: string | null; model: string | null } | null>(null);
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
      (e) => {
        if (!disposed.current) setLanesError(describeError(e));
      },
    );
    return () => {
      disposed.current = true;
    };
    // The states and the counts are asked once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fixed = source !== undefined;
  const from: string | null | undefined = fixed
    ? source
    : chosenSource !== undefined && lanes?.some((l) => l.providerId === chosenSource)
      ? chosenSource
      : lanes?.[0]?.providerId;
  const lane = from === undefined ? undefined : lanes?.find((l) => l.providerId === from);
  const waiting = lanes === null ? null : (lane?.waiting ?? 0);
  const fromName = from === undefined ? null : laneName(providers.list, from, lane?.providerName ?? null);

  const listed = (id: string | null) => id !== from && isTarget(providers.list, id);
  const effective =
    choice !== null && listed(choice.target)
      ? choice
      : (() => {
          const target = pickTarget(providers, from);
          return { target, model: defaultModelOf(providers, target, 'tagging') };
        })();
  const { target, model } = effective;

  function blockedReason(): string | null {
    if (target === null) return JOB_ERROR_MESSAGES.provider_not_configured;
    const status = providerStatus(providers, target);
    if (status !== 'ready') return PROVIDER_STATE_LABELS[status];
    if (model === null) return CHOOSE_MODEL;
    const answer = providers.models[target];
    if (answer !== undefined && answer.ok) {
      const entry = answer.models.find((m) => m.name === model);
      if (entry === undefined) return MODEL_NOT_LISTED;
      if (entry.vision === false) return MODEL_NOT_VISION;
    }
    if (waiting === null) return lanesError === null ? COUNTING_WAITING_JOBS : null;
    if (waiting === 0 || from === undefined) return NO_WAITING_JOBS;
    return null;
  }
  const blocked = blockedReason();
  const canMove = blocked === null && !moving && waiting !== null && from !== undefined;

  async function move() {
    if (movingRef.current || !canMove || target === null || model === null || from === undefined) return;
    movingRef.current = true;
    setMoving(true);
    setError(null);
    try {
      await call('jobs:reroute', { fromProviderId: from, toProviderId: target, model });
      refresh();
      if (!disposed.current) onClose();
    } catch (e) {
      if (!disposed.current) setError(describeError(e));
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
              onChange={(e) => {
                const next = lanes?.find((l) => laneValue(l.providerId) === e.target.value);
                if (next !== undefined) setChosenSource(next.providerId);
              }}
            >
              {(lanes ?? []).map((l) => (
                <option key={laneValue(l.providerId)} value={laneValue(l.providerId)}>
                  {laneName(providers.list, l.providerId, l.providerName)}
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
              kind="ollama"
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
