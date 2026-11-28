import {
  ArrowLeft,
  FolderOpen,
  Inbox,
  ListChecks,
  Package,
  ScrollText,
  ScanSearch,
  Settings,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PausedHost, PausedProvider } from '@assetforge/contracts';
import { describeError, ApiError, onStorageUnreachable } from '../api';
import { StorageReturnContext } from '../storage-context';
import { useSearchShortcut } from '../hooks/useSearchShortcut';
import {
  activeNavLabel,
  ASSETS_NAV_LABEL,
  INBOX_NAV_LABEL,
  JOBS_NAV_LABEL,
  EXTRACTIONS_NAV_LABEL,
  MAIN_NAV_LABEL,
  PROJECTS_NAV_LABEL,
  PROMPTS_LABEL,
  RETRY_LABEL,
  SETTINGS_LABEL,
  TRASH_LABEL,
  trashNavLabel,
  WORKSPACES_BUTTON,
} from '../labels';
import { BORDER, BUTTON, FOCUS, MUTED, WARNING, WORKSPACE_TITLE } from '../ui';
import { BUSY_TITLE } from './busy-title';
import { BackupBanner } from './BackupBanner';
import { PauseBanner } from './PauseBanner';

export { BUSY_TITLE } from './busy-title';

/** A screen of the main navigation. */
export type Section = 'assets' | 'projects' | 'prompts' | 'inbox' | 'trash' | 'jobs' | 'extractions' | 'settings';

/** The props of `AppShell`. */
interface Props {
  /** The name of the open workspace, shown as the title. */
  workspaceName: string;
  /** The workspace root, shown under the title. */
  rootPath: string;
  /** The section to mark as current; null for none. */
  section: Section | null;
  /** True while an import runs: navigation and Workspaces are then disabled. */
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
  /** Every download host that stopped claiming work; each gets a line after the provider lines. */
  pausedHosts?: readonly PausedHost[];
  /** Resumes one host (`jobs:resumeHost`); a rejection shows in its line. */
  onResumeHost?(host: string): Promise<void>;
  /** The paused hosts that are the site of a profile: a browser check there offers Open site. */
  checkHosts?: ReadonlySet<string>;
  /** Opens the site check of one host (`sites:openCheck`); a rejection shows in its line. */
  onOpenCheck?(host: string): Promise<void>;
  /** The reason of a failed last backup of the open workspace; null shows no backup line. */
  backupFailure?: string | null;
  /** Opens the Backup section of the settings from the backup line; without it the line opens Settings. */
  onOpenBackupSettings?(): void;
  /** Opens one section. */
  onNavigate(section: Section): void;
  /** Closes the workspace. */
  onClose(): void;
  /** The page. */
  children: ReactNode;
}

/** The entries of the main navigation, in order. */
const NAV: { section: Section; label: string; icon: LucideIcon }[] = [
  { section: 'assets', label: ASSETS_NAV_LABEL, icon: Package },
  { section: 'projects', label: PROJECTS_NAV_LABEL, icon: FolderOpen },
  { section: 'prompts', label: PROMPTS_LABEL, icon: ScrollText },
  { section: 'inbox', label: INBOX_NAV_LABEL, icon: Inbox },
  { section: 'trash', label: TRASH_LABEL, icon: Trash2 },
  { section: 'jobs', label: JOBS_NAV_LABEL, icon: ListChecks },
  { section: 'extractions', label: EXTRACTIONS_NAV_LABEL, icon: ScanSearch },
  { section: 'settings', label: SETTINGS_LABEL, icon: Settings },
];

/** The banner text while the storage cannot be reached. */
const UNREACHABLE_MESSAGE = describeError(new ApiError('storage_unreachable', ''));

/** The defaults of the optional props. */
const NOTHING_PAUSED: readonly PausedProvider[] = [];
const NO_PAUSED_HOSTS: readonly PausedHost[] = [];
const NO_CHECK_HOSTS: ReadonlySet<string> = new Set();
const RESOLVED = async () => {};
const IGNORED = () => {};

/**
 * The count shown beside a navigation entry: active jobs for Jobs, trashed files for Trash.
 *
 * @param target the entry
 * @param activeJobs the active jobs
 * @param trashCount the trashed files, or null while unknown
 * @returns the count, or null when nothing is shown
 */
function navCount(target: Section, activeJobs: number, trashCount: number | null): number | null {
  if (target === 'jobs' && activeJobs > 0) return activeJobs;
  if (target === 'trash' && trashCount !== null && trashCount > 0) return trashCount;
  return null;
}

/**
 * The accessible name of a navigation entry that shows a count.
 *
 * @param target the entry
 * @param label its visible label
 * @param count its count, or null
 * @returns the name, or undefined to use the visible label
 */
function navName(target: Section, label: string, count: number | null): string | undefined {
  if (count === null) return undefined;
  return target === 'trash' ? trashNavLabel(count) : activeNavLabel(label, count);
}

/** The props of `NavLinks`. */
interface NavLinksProps {
  section: Section | null;
  busy: boolean;
  activeJobs: number;
  trashCount: number | null;
  onNavigate(section: Section): void;
}

/**
 * The main navigation: one link per section, with a count beside Jobs and Trash.
 *
 * @param props the current section, the busy flag, the counts and the navigation callback
 * @returns the navigation
 */
function NavLinks({ section, busy, activeJobs, trashCount, onNavigate }: NavLinksProps) {
  return (
    <nav aria-label={MAIN_NAV_LABEL} className={`flex w-[200px] shrink-0 flex-col gap-1 border-r p-3 ${BORDER}`}>
      {NAV.map(({ section: target, label, icon: Icon }) => {
        const count = navCount(target, activeJobs, trashCount);
        const name = navName(target, label, count);
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
  );
}

/** The props of `ShellHeader`. */
interface ShellHeaderProps {
  workspaceName: string;
  rootPath: string;
  busy: boolean;
  onClose(): void;
}

/**
 * The header: the workspace name and root, and the way back to the workspaces.
 *
 * @param props the workspace, the busy flag and the close callback
 * @returns the header
 */
function ShellHeader({ workspaceName, rootPath, busy, onClose }: ShellHeaderProps) {
  return (
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
        {WORKSPACES_BUTTON}
      </button>
    </header>
  );
}

/**
 * The banner while the storage cannot be reached. Retry remounts the page, so it waits while an import runs:
 * the remount would drop the page's busy block while the main process still imports.
 *
 * @param props the busy flag and the retry
 * @returns the banner
 */
function StorageBanner({ busy, onRetry }: { busy: boolean; onRetry(): void }) {
  return (
    <div role="alert" className={`m-6 mb-0 flex items-center justify-between gap-4 ${WARNING}`}>
      <span>{UNREACHABLE_MESSAGE}</span>
      <button
        type="button"
        className={BUTTON}
        aria-disabled={busy || undefined}
        title={busy ? BUSY_TITLE : undefined}
        onClick={() => {
          if (!busy) onRetry();
        }}
      >
        {RETRY_LABEL}
      </button>
    </div>
  );
}

/**
 * The application frame: header, navigation, the alert region and the page slot.
 *
 * @param props the workspace, the navigation state, the paused lanes and their actions, and the page
 * @returns the frame
 */
export function AppShell({
  workspaceName,
  rootPath,
  section,
  busy,
  activeJobs,
  trashCount = null,
  paused = NOTHING_PAUSED,
  onResume = RESOLVED,
  onMove = IGNORED,
  pausedHosts = NO_PAUSED_HOSTS,
  onResumeHost = RESOLVED,
  checkHosts = NO_CHECK_HOSTS,
  onOpenCheck = RESOLVED,
  backupFailure = null,
  onOpenBackupSettings,
  onNavigate,
  onClose,
  children,
}: Props) {
  const [unreachable, setUnreachable] = useState(false);
  // Bumped by Retry; keys the page so it reloads from scratch, and is the storage return signal.
  const [reloadKey, setReloadKey] = useState(0);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => onStorageUnreachable(() => setUnreachable(true)), []);
  useSearchShortcut(mainRef);

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      <ShellHeader workspaceName={workspaceName} rootPath={rootPath} busy={busy} onClose={onClose} />

      <div className="flex min-h-0 flex-1">
        <NavLinks
          section={section}
          busy={busy}
          activeJobs={activeJobs}
          trashCount={trashCount}
          onNavigate={onNavigate}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          {unreachable && (
            <StorageBanner
              busy={busy}
              onRetry={() => {
                setUnreachable(false);
                setReloadKey((key) => key + 1);
              }}
            />
          )}
          {(paused.length > 0 || pausedHosts.length > 0) && (
            <PauseBanner
              paused={paused}
              pausedHosts={pausedHosts}
              busy={busy}
              checkHosts={checkHosts}
              onResume={onResume}
              onMove={onMove}
              onResumeHost={onResumeHost}
              onOpenCheck={onOpenCheck}
              onSettings={() => onNavigate('settings')}
            />
          )}
          {backupFailure !== null && (
            <BackupBanner
              message={backupFailure}
              busy={busy}
              onSettings={onOpenBackupSettings ?? (() => onNavigate('settings'))}
            />
          )}
          <main ref={mainRef} key={reloadKey} className="flex min-h-0 flex-1 flex-col overflow-auto">
            <StorageReturnContext.Provider value={reloadKey}>{children}</StorageReturnContext.Provider>{' '}
          </main>
        </div>
      </div>
    </div>
  );
}
