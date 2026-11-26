import { ArrowLeft, FolderOpen, Inbox, ListChecks, Package, Settings, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { JOB_ERROR_MESSAGES, type JobErrorCode } from '@assetforge/contracts';
import { describeError, ApiError, onStorageUnreachable } from '../api';
import { RESUME_LABEL, RESUME_TITLE } from '../labels';
import { BORDER, BUTTON, FOCUS, MUTED, WARNING, WORKSPACE_TITLE } from '../ui';

/** Pause reasons the user fixes on the settings screen: the banner offers the way there. */
const SETTINGS_REASONS: ReadonlySet<JobErrorCode> = new Set(['provider_unauthorized', 'provider_not_configured']);

export type Section = 'assets' | 'projects' | 'inbox' | 'jobs' | 'settings';

interface Props {
  workspaceName: string;
  rootPath: string;
  section: Section | null;
  busy: boolean;
  /** Queued, running and waiting jobs; shown beside the Jobs entry when above zero. */
  activeJobs: number;
  /** Why the provider queue stopped claiming work; shows the pause banner. */
  paused?: JobErrorCode | null;
  /** Resumes the paused queue (`jobs:resume`); a rejection shows in the banner. */
  onResume?(): Promise<void>;
  onNavigate(section: Section): void;
  onClose(): void;
  children: ReactNode;
}

const NAV: { section: Section; label: string; icon: LucideIcon }[] = [
  { section: 'assets', label: 'Assets', icon: Package },
  { section: 'projects', label: 'Projects', icon: FolderOpen },
  { section: 'inbox', label: 'Inbox', icon: Inbox },
  { section: 'jobs', label: 'Jobs', icon: ListChecks },
  { section: 'settings', label: 'Settings', icon: Settings },
];

/** Tooltip of the navigation (and of the dialogs' Settings) while an import runs. */
export const BUSY_TITLE = 'Import in progress';

const UNREACHABLE_MESSAGE = describeError(new ApiError('storage_unreachable', ''));

/** The application frame: header, navigation, the alert region and the page slot. */
export function AppShell({
  workspaceName,
  rootPath,
  section,
  busy,
  activeJobs,
  paused = null,
  onResume = async () => {},
  onNavigate,
  onClose,
  children,
}: Props) {
  const [unreachable, setUnreachable] = useState(false);
  // Bumped by Retry; keys the page so it reloads from scratch.
  const [reloadKey, setReloadKey] = useState(0);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => onStorageUnreachable(() => setUnreachable(true)), []);

  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const resumingRef = useRef(false);
  // A new pause reason (or none) drops the error of an earlier resume.
  useEffect(() => setResumeError(null), [paused]);

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
            const count = target === 'jobs' && activeJobs > 0 ? activeJobs : null;
            return (
              <a
                key={target}
                href="#"
                aria-label={count === null ? undefined : `${label}, ${count} active`}
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
          {paused !== null && (
            <div role="alert" className={`m-6 mb-0 flex items-center justify-between gap-4 ${WARNING}`}>
              <span>{resumeError ?? JOB_ERROR_MESSAGES[paused]}</span>
              <div className="flex shrink-0 items-center gap-2">
                {SETTINGS_REASONS.has(paused) && (
                  <button
                    type="button"
                    className={BUTTON}
                    aria-disabled={busy || undefined}
                    title={busy ? BUSY_TITLE : undefined}
                    onClick={() => {
                      if (!busy) onNavigate('settings');
                    }}
                  >
                    Settings
                  </button>
                )}
                <button type="button" className={BUTTON} title={RESUME_TITLE} disabled={resuming} onClick={() => void resume()}>
                  {RESUME_LABEL}
                </button>
              </div>
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
