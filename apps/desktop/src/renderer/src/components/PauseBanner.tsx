import {
  JOB_ERROR_MESSAGES,
  purposeOf,
  type JobErrorCode,
  type PausedHost,
  type PausedProvider,
} from '@assetforge/contracts';
import { useResume } from '../hooks/useResume';
import {
  laneLabel,
  MOVE_JOBS_LABEL,
  MOVE_JOBS_TITLE,
  OPEN_SITE_LABEL,
  OPEN_SITE_TITLE,
  RESUME_LABEL,
  RESUME_TITLE,
} from '../labels';
import { BUTTON, WARNING } from '../ui';
import { BUSY_TITLE } from './busy-title';

/** Pause reasons the user fixes on the settings screen: the banner offers the way there. */
const SETTINGS_REASONS: ReadonlySet<JobErrorCode> = new Set(['provider_unauthorized', 'provider_not_configured']);

/** The props of `PauseBanner`. */
interface PauseBannerProps {
  /** Every paused provider; each gets a line. */
  paused: readonly PausedProvider[];
  /** Every paused download host; each gets a line after the provider lines. */
  pausedHosts: readonly PausedHost[];
  /** True while an import runs: Settings is then disabled. */
  busy: boolean;
  /** The paused hosts that are the site of a profile: a browser check there offers Open site. */
  checkHosts: ReadonlySet<string>;
  /** Resumes one provider's queue. */
  onResume(providerId: string | null): Promise<void>;
  /** Opens the move dialog for one provider's waiting jobs. */
  onMove(providerId: string | null): void;
  /** Resumes one host. */
  onResumeHost(host: string): Promise<void>;
  /** Opens the site check of one host. */
  onOpenCheck(host: string): Promise<void>;
  /** Opens the settings screen. */
  onSettings(): void;
}

/**
 * The pause banner: one line per paused provider, then one per paused download host.
 *
 * @param props the paused lanes and their actions
 * @returns the alert region
 */
export function PauseBanner({
  paused,
  pausedHosts,
  busy,
  checkHosts,
  onResume,
  onMove,
  onResumeHost,
  onOpenCheck,
  onSettings,
}: PauseBannerProps) {
  return (
    <div role="alert" className={`m-6 mb-0 flex flex-col gap-3 ${WARNING}`}>
      {paused.map((entry) => (
        <PauseLine
          key={entry.providerId ?? ''}
          entry={entry}
          busy={busy}
          onResume={() => onResume(entry.providerId)}
          onMove={() => onMove(entry.providerId)}
          onSettings={onSettings}
        />
      ))}
      {pausedHosts.map((entry) => (
        <HostPauseLine
          key={`host:${entry.host}`}
          entry={entry}
          onResume={() => onResumeHost(entry.host)}
          onOpenCheck={
            entry.reason === 'download_browser_check' && checkHosts.has(entry.host)
              ? () => onOpenCheck(entry.host)
              : null
          }
        />
      ))}
    </div>
  );
}

/** The props of `HostPauseLine`. */
interface HostPauseLineProps {
  /** The paused host and its reason. */
  entry: PausedHost;
  /** Resumes the host. */
  onResume(): Promise<void>;
  /** Opens the site check; null hides Open site. */
  onOpenCheck: (() => Promise<void>) | null;
}

/** The action `useResume` gets when a line has no Open site. */
const NO_CHECK = async () => {};

/**
 * One paused download host in the banner: the host, the reason, Open site for a browser check and Resume.
 *
 * @param props the host and its actions
 * @returns the line
 */
function HostPauseLine({ entry, onResume, onOpenCheck }: HostPauseLineProps) {
  const { resuming, resumeError, resume } = useResume(entry.reason, onResume);
  const check = useResume(entry.reason, onOpenCheck ?? NO_CHECK);
  return (
    <div role="group" aria-label={entry.host} className="flex items-center justify-between gap-4">
      <span className="min-w-0 break-words">
        <span className="font-semibold">{entry.host}</span>{' '}
        {resumeError ?? check.resumeError ?? JOB_ERROR_MESSAGES[entry.reason]}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        {onOpenCheck !== null && (
          <button
            type="button"
            className={BUTTON}
            title={OPEN_SITE_TITLE}
            disabled={check.resuming}
            onClick={() => void check.resume()}
          >
            {OPEN_SITE_LABEL}
          </button>
        )}
        <button type="button" className={BUTTON} title={RESUME_TITLE} disabled={resuming} onClick={() => void resume()}>
          {RESUME_LABEL}
        </button>
      </div>
    </div>
  );
}

/** The props of `PauseLine`. */
interface PauseLineProps {
  /** The paused provider and its reason. */
  entry: PausedProvider;
  /** True while an import runs: Settings is then disabled. */
  busy: boolean;
  /** Resumes the provider. */
  onResume(): Promise<void>;
  /** Opens the move dialog. */
  onMove(): void;
  /** Opens the settings screen. */
  onSettings(): void;
}

/**
 * One paused provider in the banner: its name, the reason, Resume, Move jobs and, for the settings reasons, Settings.
 *
 * @param props the provider and its actions
 * @returns the line
 */
function PauseLine({ entry, busy, onResume, onMove, onSettings }: PauseLineProps) {
  const name = laneLabel(entry.providerId, entry.providerName);
  const { resuming, resumeError, resume } = useResume(entry.reason, onResume);

  return (
    <div role="group" aria-label={name} className="flex items-center justify-between gap-4">
      <span className="min-w-0">
        <span className="font-semibold">{name}</span> {resumeError ?? JOB_ERROR_MESSAGES[entry.reason]}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        {SETTINGS_REASONS.has(entry.reason) && (
          <button
            type="button"
            className={BUTTON}
            aria-disabled={busy || undefined}
            title={busy ? BUSY_TITLE : undefined}
            onClick={() => {
              if (!busy) onSettings();
            }}
          >
            Settings
          </button>
        )}
        {/* Only analysis jobs move; an image provider's generation jobs stay on it. */}
        {purposeOf(entry.kind) === 'vision' && (
          <button type="button" className={BUTTON} title={MOVE_JOBS_TITLE} onClick={onMove}>
            {MOVE_JOBS_LABEL}
          </button>
        )}
        <button type="button" className={BUTTON} title={RESUME_TITLE} disabled={resuming} onClick={() => void resume()}>
          {RESUME_LABEL}
        </button>
      </div>
    </div>
  );
}
