import { ArrowLeft, FolderOpen, Inbox, ListChecks, Package, Settings, Trash2, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { JOB_ERROR_MESSAGES, type JobErrorCode, type PausedProvider } from '@assetforge/contracts';
import { describeError, ApiError, onStorageUnreachable } from '../api';
import {
  laneLabel,
  MOVE_JOBS_LABEL,
  MOVE_JOBS_TITLE,
  RESUME_LABEL,
  RESUME_TITLE,
  TRASH_LABEL,
  trashNavLabel,
} from '../labels';
import { BORDER, BUTTON, FOCUS, MUTED, WARNING, WORKSPACE_TITLE } from '../ui';

/** Pause reasons the user fixes on the settings screen: the banner offers the way there. */
const SETTINGS_REASONS: ReadonlySet<JobErrorCode> = new Set(['provider_unauthorized', 'provider_not_configured']);

export type Section = 'assets' | 'projects' | 'inbox' | 'trash' | 'jobs' | 'settings';

interface Props {
  workspaceName: string;
  rootPath: string;
  section: Section | null;
  busy: boolean;
  /** Queued, running and waiting jobs; shown beside the Jobs entry when above zero. */
  activeJobs: number;
  /** Files in the trash; shown beside the Trash entry when above zero. */
  trashCount?: number | null;
  /** Every provider whose queue stopped claiming work; each gets a line in the pause banner. */
  paused?: readonly PausedProvider[];
  /** Resumes one provider's queue (`jobs:resume`); a rejection shows in its line. */
  onResume?(providerId: string | null): Promise<void>;
  /** Opens the move dialog for one provider's waiting jobs. */
  onMove?(providerId: string | null): void;
  onNavigate(section: Section): void;
  onClose(): void;
  children: ReactNode;
}

const NAV: { section: Section; label: string; icon: LucideIcon }[] = [
  { section: 'assets', label: 'Assets', icon: Package },
  { section: 'projects', label: 'Projects', icon: FolderOpen },
  { section: 'inbox', label: 'Inbox', icon: Inbox },
  { section: 'trash', label: TRASH_LABEL, icon: Trash2 },
  { section: 'jobs', label: 'Jobs', icon: ListChecks },
  { section: 'settings', label: 'Settings', icon: Settings },
];

/** Tooltip of the navigation (and of the dialogs' Settings) while an import runs. */
export const BUSY_TITLE = 'Import in progress';

const UNREACHABLE_MESSAGE = describeError(new ApiError('storage_unreachable', ''));

const NOTHING_PAUSED: readonly PausedProvider[] = [];

/** The application frame: header, navigation, the alert region and the page slot. */
export function AppShell({
  workspaceName,
  rootPath,
  section,
  busy,
  activeJobs,
  trashCount = null,
  paused = NOTHING_PAUSED,
  onResume = async () => {},
  onMove = () => {},
  onNavigate,
  onClose,
  children,
}: Props) {
  const [unreachable, setUnreachable] = useState(false);
  // Bumped by Retry; keys the page so it reloads from scratch.
  const [reloadKey, setReloadKey] = useState(0);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => onStorageUnreachable(() => setUnreachable(true)), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return;
      const field = mainRef.current?.querySelector<HTMLElement>('[data-search-field]');
      if (field === null || field === undefined) return;
      event.preventDefault();
      field.focus();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      <header className={`flex h-[76px] shrink-0 items-center justify-between gap-4 border-b px-6 ${BORDER}`}>
        <div className="min-w-0">
          <h1 className={`truncate ${WORKSPACE_TITLE}`}>{workspaceName}</h1>
          <p title={rootPath} className="truncate text-sm text-accent">
            {rootPath}
          </p>
        </div>
        <button
          type="button"
          className={BUTTON}
          aria-disabled={busy || undefined}
          title={busy ? BUSY_TITLE : undefined}
          onClick={() => {
            if (!busy) onClose();
          }}
        >
          <ArrowLeft size={16} aria-hidden />
          Workspaces
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="Main" className={`flex w-[200px] shrink-0 flex-col gap-1 border-r p-3 ${BORDER}`}>
          {NAV.map(({ section: target, label, icon: Icon }) => {
            const count =
              target === 'jobs' && activeJobs > 0
                ? activeJobs
                : target === 'trash' && trashCount !== null && trashCount > 0
                  ? trashCount
                  : null;
            const name =
              count === null ? undefined : target === 'trash' ? trashNavLabel(count) : `${label}, ${count} active`;
            return (
              <a
                key={target}
                href="#"
                aria-label={name}
                aria-current={section === target ? 'page' : undefined}
                aria-disabled={busy || undefined}
                title={busy ? BUSY_TITLE : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  if (!busy) onNavigate(target);
                }}
                className={`flex h-10 items-center gap-2.5 rounded-control px-3 text-text aria-[current=page]:bg-nav-active aria-disabled:opacity-50 ${
                  busy ? '' : 'hover:bg-raised'
                } ${FOCUS}`}
              >
                <Icon size={18} aria-hidden />
                {label}
                {count !== null && <span className={`ml-auto text-sm tabular-nums ${MUTED}`}>{count}</span>}
              </a>
            );
          })}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {unreachable && (
            <div role="alert" className={`m-6 mb-0 flex items-center justify-between gap-4 ${WARNING}`}>
              <span>{UNREACHABLE_MESSAGE}</span>
              <button
                type="button"
                className={BUTTON}
                onClick={() => {
                  setUnreachable(false);
                  setReloadKey((key) => key + 1);
                }}
              >
                Retry
              </button>
            </div>
          )}
          {paused.length > 0 && (
            <div role="alert" className={`m-6 mb-0 flex flex-col gap-3 ${WARNING}`}>
              {paused.map((entry) => (
                <PauseLine
                  key={entry.providerId ?? ''}
                  entry={entry}
                  busy={busy}
                  onResume={() => onResume(entry.providerId)}
                  onMove={() => onMove(entry.providerId)}
                  onSettings={() => onNavigate('settings')}
                />
              ))}
            </div>
          )}
          <main ref={mainRef} key={reloadKey} className="flex min-h-0 flex-1 flex-col overflow-auto">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

interface PauseLineProps {
  entry: PausedProvider;
  busy: boolean;
  onResume(): Promise<void>;
  onMove(): void;
  onSettings(): void;
}

/** One paused provider in the banner: its name, the reason, Resume, Move jobs and, for the settings reasons, Settings. */
function PauseLine({ entry, busy, onResume, onMove, onSettings }: PauseLineProps) {
  const name = laneLabel(entry.providerId, entry.providerName);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const resumingRef = useRef(false);
  // A new pause reason drops the error of an earlier resume.
  useEffect(() => setResumeError(null), [entry.reason]);

  async function resume() {
    if (resumingRef.current) return;
    resumingRef.current = true;
    setResuming(true);
    setResumeError(null);
    try {
      await onResume();
    } catch (e) {
      setResumeError(describeError(e));
    } finally {
      resumingRef.current = false;
      setResuming(false);
    }
  }

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
        {entry.kind === 'ollama' && (
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
