import { useCallback, useState, type ComponentProps } from 'react';
import type { PausedProvider, WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { JobsProvider, useJobs } from '../jobs-context';
import { LeaveGuardProvider, useConfirmLeave } from '../leave-guard';
import { AnalysisPromptsProvider } from '../analysis-prompts-context';
import { ProviderSettingsProvider } from '../provider-context';
import {
  NO_FILE_FILTERS,
  NO_FILTERS,
  NO_PROJECT_FILTERS,
  renameInFilters,
  type AssetFilters,
  type AssetListState,
  type AssetTab,
  type InboxListState,
  type ProjectListState,
  type TrashListState,
} from '../list-state';
import type { View } from '../nav';
import { AssetsScreen } from '../screens/AssetsScreen';
import { AssetScreen } from '../screens/AssetScreen';
import { InboxScreen } from '../screens/InboxScreen';
import { JobsScreen } from '../screens/JobsScreen';
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

interface Props {
  workspace: WorkspaceSummary;
  onClosed(): void;
}

export interface ShellState {
  assetList: AssetListState;
  projectList: ProjectListState;
  inboxList: InboxListState;
  trashList: TrashListState;
  assetTab: AssetTab;
}

const INITIAL_SHELL: ShellState = {
  assetList: { filters: NO_FILTERS, scrollOffset: 0, openedIndex: null, selectedId: null },
  projectList: { filters: NO_PROJECT_FILTERS, scrollOffset: 0, selectedId: null },
  inboxList: { filters: NO_FILE_FILTERS, scrollOffset: 0 },
  trashList: { filters: NO_FILE_FILTERS, scrollOffset: 0 },
  assetTab: 'files',
};

function sectionOf(view: View): Section {
  return view.name === 'asset' ? 'assets' : view.name === 'project' ? 'projects' : view.name;
}

const NOTHING_PAUSED: PausedProvider[] = [];

/**
 * The app frame with the active jobs and the paused providers of the surrounding `JobsProvider` and
 * the trash count of the `TrashProvider`; `Move jobs` in the pause banner opens the move dialog.
 */
export function JobsAppShell(
  props: Omit<ComponentProps<typeof AppShell>, 'activeJobs' | 'trashCount' | 'paused' | 'onResume' | 'onMove'>,
) {
  const { active, summary, refresh } = useJobs();
  const trash = useTrash();
  // The provider whose waiting jobs the open move dialog moves; absent while it is closed.
  const [moving, setMoving] = useState<{ source: string | null } | null>(null);
  return (
    <>
      <AppShell
        {...props}
        activeJobs={active}
        trashCount={trash.count}
        paused={summary?.paused ?? NOTHING_PAUSED}
        onResume={async (providerId) => {
          await call('jobs:resume', { providerId });
          refresh();
        }}
        onMove={(source) => setMoving({ source })}
      />
      {moving !== null && <MoveJobsDialog source={moving.source} onClose={() => setMoving(null)} />}
    </>
  );
}

/** The workspace frame; a screen with unsaved changes can hold the main navigation back. */
export function WorkspaceShell(props: Props) {
  return (
    <LeaveGuardProvider>
      <WorkspaceFrame {...props} />
    </LeaveGuardProvider>
  );
}

function WorkspaceFrame({ workspace, onClosed }: Props) {
  const confirmLeave = useConfirmLeave();
  const [view, setView] = useState<View>({ name: 'assets' });
  const [error, setError] = useState<string | null>(null);
  // The inbox reports a running import so closing cannot interrupt the batch.
  const [busy, setBusy] = useState(false);
  // List state lives here so it survives navigation; it is dropped with the workspace.
  const [shell, setShell] = useState<ShellState>(INITIAL_SHELL);
  const setAssetList = (assetList: AssetListState) => setShell((current) => ({ ...current, assetList }));
  const setProjectList = (projectList: ProjectListState) => setShell((current) => ({ ...current, projectList }));
  const setInboxList = (inboxList: InboxListState) => setShell((current) => ({ ...current, inboxList }));
  const setTrashList = (trashList: TrashListState) => setShell((current) => ({ ...current, trashList }));
  const setAssetTab = (assetTab: AssetTab) => setShell((current) => ({ ...current, assetTab }));

  /** A renamed tag in the filters of every list, mounted or not; the lists reload themselves. */
  const renameInShell = useCallback((change: TagRename) => {
    setShell((current) => {
      const rename = <S extends { filters: { tagNames: string[] } }>(list: S): S => {
        const filters = renameInFilters(list.filters, change);
        return filters === list.filters ? list : { ...list, filters };
      };
      return {
        ...current,
        assetList: rename(current.assetList),
        projectList: rename(current.projectList),
        inboxList: rename(current.inboxList),
        trashList: rename(current.trashList),
      };
    });
  }, []);

  function showAssets(filters: Pick<AssetFilters, 'projectId' | 'tagNames'>) {
    setAssetList({ filters: { ...NO_FILTERS, ...filters }, scrollOffset: 0, openedIndex: null, selectedId: null });
    setView({ name: 'assets' });
  }

  async function closeWorkspace() {
    if (!(await confirmLeave())) return;
    try {
      await call('workspace:close', {});
      onClosed();
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function navigate(section: Section) {
    if (!(await confirmLeave())) return;
    setError(null);
    setView({ name: section } as View);
  }

  const openPrompt = useCallback(
    async (id: string) => {
      if (!(await confirmLeave())) return;
      setError(null);
      setView({ name: 'prompts', id });
    },
    [confirmLeave],
  );

  const openSettings = useCallback(async () => {
    if (!(await confirmLeave())) return;
    setError(null);
    setView({ name: 'settings' });
  }, [confirmLeave]);

  return (
    <JobsProvider>
      <TrashProvider>
        <ProviderSettingsProvider>
          <AnalysisPromptsProvider>
            <TagsProvider onRenamed={renameInShell}>
              <JobsAppShell
                workspaceName={workspace.name}
                rootPath={workspace.rootPath}
                section={sectionOf(view)}
                busy={busy}
                onNavigate={(section) => void navigate(section)}
                onClose={() => void closeWorkspace()}
              >
                {/* The screens bring their own padding. */}
                {/* A running import keeps the screen, as it does for the navigation: Settings is disabled. */}
                <OpenSettingsProvider onOpenSettings={openSettings} blocked={busy ? BUSY_TITLE : null}>
                  <StudioProvider onOpenPrompt={(id) => void openPrompt(id)}>
                    {error !== null && (
                      <p role="alert" className={`mx-6 mt-6 ${ALERT}`}>
                        {error}
                      </p>
                    )}
                    {view.name === 'assets' ? (
                      <AssetsScreen
                        state={shell.assetList}
                        onStateChange={setAssetList}
                        onOpen={(id) => setView({ name: 'asset', id })}
                      />
                    ) : view.name === 'asset' ? (
                      <AssetScreen
                        key={view.id}
                        id={view.id}
                        tab={shell.assetTab}
                        onTabChange={setAssetTab}
                        onBack={() => setView({ name: 'assets' })}
                        onOpenAsset={(id) => setView({ name: 'asset', id })}
                        onOpenProject={(id) => setView({ name: 'project', id })}
                        onBusyChange={setBusy}
                      />
                    ) : view.name === 'project' ? (
                      <ProjectScreen key={view.id} id={view.id} onNavigate={setView} />
                    ) : view.name === 'inbox' ? (
                      <InboxScreen state={shell.inboxList} onStateChange={setInboxList} onBusyChange={setBusy} />
                    ) : view.name === 'trash' ? (
                      <TrashScreen state={shell.trashList} onStateChange={setTrashList} />
                    ) : view.name === 'prompts' ? (
                      <PromptsScreen key={view.id ?? ''} busy={busy} initialId={view.id ?? null} />
                    ) : view.name === 'jobs' ? (
                      <JobsScreen />
                    ) : view.name === 'settings' ? (
                      <SettingsScreen />
                    ) : (
                      <ProjectsScreen
                        state={shell.projectList}
                        onStateChange={setProjectList}
                        onOpen={(id) => setView({ name: 'project', id })}
                        onOpenAsset={(id) => setView({ name: 'asset', id })}
                        onShowAssets={showAssets}
                      />
                    )}
                  </StudioProvider>
                </OpenSettingsProvider>
              </JobsAppShell>
            </TagsProvider>
          </AnalysisPromptsProvider>
        </ProviderSettingsProvider>
      </TrashProvider>
    </JobsProvider>
  );
}
