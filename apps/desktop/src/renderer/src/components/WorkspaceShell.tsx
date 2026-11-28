import { useCallback, useState, type ComponentProps, type ReactNode } from 'react';
import type { PausedHost, PausedProvider, WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { backupFailureOf, useBackupState } from '../hooks/useBackupState';
import { useCheckHosts } from '../hooks/useCheckHosts';
import { useShellState } from '../hooks/useShellState';
import { JobsProvider, useJobs } from '../jobs-context';
import { LeaveGuardProvider, useConfirmLeave } from '../leave-guard';
import { AnalysisPromptsProvider } from '../analysis-prompts-context';
import { ProviderSettingsProvider } from '../provider-context';
import { NO_FILTERS, type AssetFilters } from '../list-state';
import type { View } from '../nav';
import { AssetsScreen } from '../screens/AssetsScreen';
import { AssetScreen } from '../screens/AssetScreen';
import { InboxScreen } from '../screens/InboxScreen';
import { JobsScreen } from '../screens/JobsScreen';
import { ExtractionsScreen } from '../screens/ExtractionsScreen';
import { ProjectScreen } from '../screens/ProjectScreen';
import { ProjectsScreen } from '../screens/ProjectsScreen';
import { PromptsScreen } from '../screens/PromptsScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TrashScreen } from '../screens/TrashScreen';
import type { TagRename } from '../tag-rename';
import { StudioProvider } from '../studio-context';
import { TagsProvider } from '../tags-context';
import { TrashProvider, useTrash } from '../trash-context';
import { ALERT } from '../ui';
import { OpenSettingsProvider } from './AnalysisDialogs';
import { AppShell, BUSY_TITLE, type Section } from './AppShell';
import { MoveJobsDialog } from './MoveJobsDialog';

export type { ShellState } from '../hooks/useShellState';

/** The props of `WorkspaceShell`. */
interface Props {
  /** The open workspace. */
  workspace: WorkspaceSummary;
  /** Called after the workspace was closed. */
  onClosed(): void;
}

/**
 * The navigation entry a view belongs to.
 *
 * @param view the shown view
 * @returns its section
 */
function sectionOf(view: View): Section {
  if (view.name === 'asset') return 'assets';
  if (view.name === 'project') return 'projects';
  return view.name;
}

/**
 * The view a navigation entry opens: its list, without an item.
 *
 * @param section the chosen navigation entry
 * @returns the view
 */
function viewOfSection(section: Section): View {
  return { name: section };
}

/** The answers while the job summary has not loaded yet. */
const NOTHING_PAUSED: PausedProvider[] = [];
const NO_PAUSED_HOSTS: PausedHost[] = [];

/**
 * Resumes one provider's queue and reloads the job summary.
 *
 * @param providerId the provider
 * @param refresh reloads the job summary
 * @returns resolves after the resume; rejects with its error
 */
async function resumeProvider(providerId: string | null, refresh: () => void): Promise<void> {
  await call('jobs:resume', { providerId });
  refresh();
}

/**
 * Resumes one download host and reloads the job summary.
 *
 * @param host the host
 * @param refresh reloads the job summary
 * @returns resolves after the resume; rejects with its error
 */
async function resumeHost(host: string, refresh: () => void): Promise<void> {
  await call('jobs:resumeHost', { host });
  refresh();
}

/**
 * Opens the site check of one host.
 *
 * @param host the host
 * @returns resolves after the window was opened; rejects with its error
 */
async function openSiteCheck(host: string): Promise<void> {
  await call('sites:openCheck', { host });
}

/**
 * The app frame with the active jobs, the paused providers and hosts of the surrounding `JobsProvider` and
 * the trash count of the `TrashProvider`; `Move jobs` in the pause banner opens the move dialog.
 *
 * @param props the props of `AppShell` without the ones this component fills in
 * @returns the frame and, while open, the move dialog
 */
export function JobsAppShell(
  props: Omit<
    ComponentProps<typeof AppShell>,
    | 'activeJobs'
    | 'trashCount'
    | 'paused'
    | 'onResume'
    | 'onMove'
    | 'pausedHosts'
    | 'onResumeHost'
    | 'checkHosts'
    | 'onOpenCheck'
  >,
) {
  const { active, summary, refresh } = useJobs();
  const trash = useTrash();
  // The provider whose waiting jobs the open move dialog moves; absent while it is closed.
  const [moving, setMoving] = useState<{ source: string | null } | null>(null);
  const pausedHosts = summary?.pausedHosts ?? NO_PAUSED_HOSTS;
  const checkHosts = useCheckHosts(pausedHosts);
  return (
    <>
      <AppShell
        {...props}
        activeJobs={active}
        trashCount={trash.count}
        paused={summary?.paused ?? NOTHING_PAUSED}
        onResume={(providerId) => resumeProvider(providerId, refresh)}
        onMove={(source) => setMoving({ source })}
        pausedHosts={pausedHosts}
        onResumeHost={(host) => resumeHost(host, refresh)}
        checkHosts={checkHosts}
        onOpenCheck={openSiteCheck}
      />
      {moving !== null && <MoveJobsDialog source={moving.source} onClose={() => setMoving(null)} />}
    </>
  );
}

/**
 * The workspace frame; a screen with unsaved changes can hold the main navigation back.
 *
 * @param props the workspace and the close callback
 * @returns the frame inside its leave guard
 */
export function WorkspaceShell(props: Props) {
  return (
    <LeaveGuardProvider>
      <WorkspaceFrame {...props} />
    </LeaveGuardProvider>
  );
}

/** What the navigation of the frame changes after the leave guard agreed. */
export interface LeaveTarget {
  /** The view shown now. */
  current: View;
  confirmLeave(): Promise<boolean>;
  setError(error: string | null): void;
  setView(view: View): void;
}

/**
 * Whether a navigation leaves the shown screen alone: it names no item and goes to the screen shown already.
 * A navigation with an item always goes through, since the screen may have moved to another item itself
 * (the Prompts screen keeps its selection to itself).
 *
 * @param current the view shown now
 * @param view the view to show
 * @returns true when nothing is to change
 */
function staysOnView(current: View, view: View): boolean {
  const id = 'id' in view ? view.id : undefined;
  return id === undefined && current.name === view.name;
}

/**
 * Shows another view once the leave guard agreed, dropping the shown error. The screen shown already stays
 * without asking when the navigation names no item, since nothing would be left.
 *
 * @param target the current view, the guard and the setters of the frame
 * @param view the view to show
 * @returns true when the view is shown, false when the guard held it back
 */
export async function leaveTo(target: LeaveTarget, view: View): Promise<boolean> {
  if (staysOnView(target.current, view)) {
    target.setError(null);
    return true;
  }
  if (!(await target.confirmLeave())) return false;
  target.setError(null);
  target.setView(view);
  return true;
}

/**
 * Closes the workspace once the leave guard agreed; a failure is shown as the frame's error.
 *
 * @param target the guard and the error setter of the frame
 * @param onClosed called after the workspace was closed
 * @returns resolves when done; never rejects
 */
async function closeWorkspace(target: Omit<LeaveTarget, 'current' | 'setView'>, onClosed: () => void): Promise<void> {
  if (!(await target.confirmLeave())) return;
  try {
    await call('workspace:close', {});
    onClosed();
  } catch (error) {
    target.setError(describeError(error));
  }
}

/**
 * The providers every screen of an open workspace reads.
 *
 * @param props the screens and the callback after a tag rename
 * @returns the screens inside the providers
 */
function WorkspaceProviders({ onRenamed, children }: { onRenamed(change: TagRename): void; children: ReactNode }) {
  return (
    <JobsProvider>
      <TrashProvider>
        <ProviderSettingsProvider>
          <AnalysisPromptsProvider>
            <TagsProvider onRenamed={onRenamed}>{children}</TagsProvider>
          </AnalysisPromptsProvider>
        </ProviderSettingsProvider>
      </TrashProvider>
    </JobsProvider>
  );
}

/** What `screenFor` needs beside the view. */
interface ScreenDependencies {
  shell: ReturnType<typeof useShellState>;
  busy: boolean;
  setBusy(busy: boolean): void;
  setView(view: View): void;
  showAssets(filters: Pick<AssetFilters, 'projectId' | 'tagNames' | 'tagLabels'>): void;
  /** Counts the views shown, so a navigation to the view shown already mounts its screen afresh. */
  visit: number;
}

/**
 * The screen of one view.
 *
 * @param view the shown view
 * @param deps the list state, the busy flag and the navigation of the frame
 * @returns the screen element
 */
function screenFor(
  view: View,
  { shell: state, busy, setBusy, setView, showAssets, visit }: ScreenDependencies,
): ReactNode {
  const { shell } = state;
  switch (view.name) {
    case 'assets':
      return (
        <AssetsScreen
          state={shell.assetList}
          onStateChange={state.setAssetList}
          onOpen={(id) => setView({ name: 'asset', id })}
        />
      );
    case 'asset':
      return (
        <AssetScreen
          key={view.id}
          id={view.id}
          tab={shell.assetTab}
          onTabChange={state.setAssetTab}
          onBack={() => setView({ name: 'assets' })}
          onOpenAsset={(id) => setView({ name: 'asset', id })}
          onOpenProject={(id) => setView({ name: 'project', id })}
          onBusyChange={setBusy}
        />
      );
    case 'project':
      return (
        <ProjectScreen
          key={view.id}
          id={view.id}
          onNavigate={setView}
          initialMemberOffset={shell.memberPage.projectId === view.id ? shell.memberPage.offset : 0}
          onMemberOffsetChange={(offset) => state.setMemberPage({ projectId: view.id, offset })}
        />
      );
    case 'inbox':
      return <InboxScreen state={shell.inboxList} onStateChange={state.setInboxList} onBusyChange={setBusy} />;
    case 'trash':
      return <TrashScreen state={shell.trashList} onStateChange={state.setTrashList} />;
    case 'prompts':
      // A prompt opened again after the screen moved to another one starts afresh on it.
      return <PromptsScreen key={`${view.id ?? ''}:${visit}`} busy={busy} initialId={view.id ?? null} />;
    case 'jobs':
      return <JobsScreen />;
    case 'extractions':
      return <ExtractionsScreen onOpenJobs={() => setView({ name: 'jobs' })} />;
    case 'settings':
      return <SettingsScreen />;
    default:
      return (
        <ProjectsScreen
          state={shell.projectList}
          onStateChange={state.setProjectList}
          onOpen={(id) => setView({ name: 'project', id })}
          onOpenAsset={(id) => setView({ name: 'asset', id })}
          onShowAssets={showAssets}
        />
      );
  }
}

/**
 * The open workspace: the frame, the shown screen and the error of the last failed navigation.
 *
 * @param props the workspace and the close callback
 * @returns the providers, the frame and the screen
 */
function WorkspaceFrame({ workspace, onClosed }: Props) {
  const confirmLeave = useConfirmLeave();
  const [shown, setShown] = useState<{ view: View; visit: number }>({ view: { name: 'assets' }, visit: 0 });
  const view = shown.view;
  const setView = useCallback((next: View) => setShown((previous) => ({ view: next, visit: previous.visit + 1 })), []);
  const [error, setError] = useState<string | null>(null);
  // The inbox reports a running import so closing cannot interrupt the batch.
  const [busy, setBusy] = useState(false);
  const shell = useShellState();
  const backupFailure = backupFailureOf(useBackupState(true), workspace.id);

  function showAssets(filters: Pick<AssetFilters, 'projectId' | 'tagNames' | 'tagLabels'>) {
    shell.setAssetList({
      filters: { ...NO_FILTERS, ...filters },
      scrollOffset: 0,
      openedIndex: null,
      selectedId: null,
    });
    setView({ name: 'assets' });
  }

  const openPrompt = useCallback(
    (id: string) => leaveTo({ current: view, confirmLeave, setError, setView }, { name: 'prompts', id }),
    [confirmLeave, view, setView],
  );
  const openSettings = useCallback(
    () => void leaveTo({ current: view, confirmLeave, setError, setView }, { name: 'settings' }),
    [confirmLeave, view, setView],
  );

  return (
    <WorkspaceProviders onRenamed={shell.renameInShell}>
      <JobsAppShell
        workspaceName={workspace.name}
        rootPath={workspace.rootPath}
        section={sectionOf(view)}
        busy={busy}
        backupFailure={backupFailure}
        onNavigate={(section) =>
          void leaveTo({ current: view, confirmLeave, setError, setView }, viewOfSection(section))
        }
        onClose={() => void closeWorkspace({ confirmLeave, setError }, onClosed)}
      >
        {/* The screens bring their own padding. */}
        {/* A running import keeps the screen, as it does for the navigation: Settings is disabled. */}
        <OpenSettingsProvider onOpenSettings={openSettings} blocked={busy ? BUSY_TITLE : null}>
          <StudioProvider onOpenPrompt={openPrompt}>
            {error !== null && (
              <p role="alert" className={`mx-6 mt-6 ${ALERT}`}>
                {error}
              </p>
            )}
            {screenFor(view, { shell, busy, setBusy, setView, showAssets, visit: shown.visit })}
          </StudioProvider>
        </OpenSettingsProvider>
      </JobsAppShell>
    </WorkspaceProviders>
  );
}
