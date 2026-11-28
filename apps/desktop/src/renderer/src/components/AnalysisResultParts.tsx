import type { ProposalView } from '@assetforge/contracts';
import { STALE_TITLE } from '../analysis-result';
import { PROMPT_SELECT_LABEL } from '../labels';
import { AI_CHIP, BUTTON, FOCUS, MUTED } from '../ui';
import { ModelSelect } from './ModelSelect';
import { PromptSelect } from './PromptSelect';
import { ProviderSelect } from './ProviderSelect';
import { SettingsButton } from './SettingsButton';

/** The props of `ProposedTags`. */
interface ProposedTagsProps {
  proposal: ProposalView;
  /** The names switched off. */
  off: ReadonlySet<string>;
  busy: boolean;
  onToggle(name: string): void;
}

/**
 * The proposed tags, each with a checkbox that switches it on or off (fixed while the proposal is stale).
 *
 * @param props the proposal, the names switched off and the toggle
 */
export function ProposedTags({ proposal, off, busy, onToggle }: ProposedTagsProps) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Proposed tags">
      {proposal.tags.map((tag) => {
        const on = !off.has(tag.name);
        return (
          <label
            key={tag.name}
            title="AI tag"
            className={`${AI_CHIP} max-w-full cursor-pointer has-disabled:cursor-default ${on ? '' : 'line-through opacity-50'}`}
          >
            <input
              type="checkbox"
              className={`accent-ai ${FOCUS}`}
              checked={on}
              disabled={proposal.stale || busy}
              onChange={() => onToggle(tag.name)}
            />
            <span className="truncate">{tag.displayName}</span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * The model and prompt that made the proposal, and a marker while it is out of date.
 *
 * @param props.proposal the proposal
 */
export function ProposalFacts({ proposal }: { proposal: ProposalView }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className={`${MUTED} truncate`} title="Model">
        {proposal.model}
      </span>
      {proposal.promptName !== null && (
        <span className={`${MUTED} truncate`} title={PROMPT_SELECT_LABEL}>
          {proposal.promptName}
        </span>
      )}
      {proposal.stale && (
        <span className="text-warning" title={STALE_TITLE}>
          Out of date
        </span>
      )}
    </div>
  );
}

/** The props of `ProposalButtons`. */
interface ProposalButtonsProps {
  proposal: ProposalView;
  /** How many tags are switched on. */
  onCount: number;
  busy: boolean;
  onAccept(): void;
  onDiscard(): void;
}

/**
 * Accept (disabled while stale or with no tag switched on) and Discard.
 *
 * @param props the proposal, the count switched on and the handlers
 */
export function ProposalButtons({ proposal, onCount, busy, onAccept, onDiscard }: ProposalButtonsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className={BUTTON}
        disabled={proposal.stale || onCount === 0 || busy}
        title={proposal.stale ? STALE_TITLE : undefined}
        onClick={onAccept}
      >
        Accept
      </button>
      <button type="button" className={BUTTON} disabled={busy} onClick={onDiscard}>
        Discard
      </button>
    </div>
  );
}

/** The props of `AnalyseRow` apart from its label. */
export interface AnalyseRowProps {
  providerId: string | null;
  model: string | null;
  promptId: string | null;
  busy: boolean;
  /** Why Analyse cannot start, as its tooltip; null when it can. */
  blocked: string | null;
  /** Settings is offered beside Analyse. */
  offerSettings: boolean;
  /** Why the settings screen cannot be shown now; null when it can. */
  settingsBlocked: string | null;
  onProvider(id: string): void;
  onModel(model: string): void;
  onPrompt(id: string): void;
  onAnalyse(): void;
  onOpenSettings(): void;
}

/**
 * The provider, model and prompt selects and the button that starts an analysis.
 *
 * @param props the choice, the gate and the handlers, and the button's label
 */
export function AnalyseRow(props: AnalyseRowProps & { label: string }) {
  const { providerId, model, promptId, busy, blocked, offerSettings, settingsBlocked } = props;
  return (
    <div className="flex flex-col gap-2">
      <ProviderSelect value={providerId} onChange={props.onProvider} disabled={busy} />
      <ModelSelect
        providerId={providerId}
        purpose="tagging"
        value={model}
        onChange={props.onModel}
        disabled={busy || providerId === null}
      />
      <PromptSelect purpose="tagging" value={promptId} onChange={props.onPrompt} disabled={busy} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={blocked !== null || busy}
          title={blocked ?? undefined}
          onClick={props.onAnalyse}
        >
          {props.label}
        </button>
        {offerSettings && <SettingsButton blocked={settingsBlocked} onClick={props.onOpenSettings} />}
      </div>
    </div>
  );
}
