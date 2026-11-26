import { useState, type ComponentProps } from 'react';
import type { WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { JobsProvider, useJobs } from '../jobs-context';
import { ProviderSettingsProvider } from '../provider-context';
import {
  NO_FILE_FILTERS,
  NO_FILTERS,
  NO_PROJECT_FILTERS,
  type AssetFilters,
  type AssetListState,
  type AssetTab,
  type InboxListState,
  type ProjectListState,
} from '../list-state';
import type { View } from '../nav';
import { AssetsScreen } from '../screens/AssetsScreen';
import { AssetScreen } from '../screens/AssetScreen';
import { InboxScreen } from '../screens/InboxScreen';
import { JobsScreen } from '../screens/JobsScreen';
import { ProjectScreen } from '../screens/ProjectScreen';
import { ProjectsScreen } from '../screens/ProjectsScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { ALERT } from '../ui';
import { AppShell, type Section } from './AppShell';

interface Props {
  workspace: WorkspaceSummary;
  onClosed(): void;
}

export interface ShellState {
  assetList: AssetListState;
  projectList: ProjectListState;
  inboxList: InboxListState;
  assetTab: AssetTab;
}

const INITIAL_SHELL: ShellState = {
  assetList: { filters: NO_FILTERS, scrollOffset: 0, openedIndex: null, selectedId: null },
  projectList: { filters: NO_PROJECT_FILTERS, scrollOffset: 0, selectedId: null },
  inboxList: { filters: NO_FILE_FILTERS, scrollOffset: 0 },
  assetTab: 'files',
};

function sectionOf(view: View): Section {
  return view.name === 'asset' ? 'assets' : view.name === 'project' ? 'projects' : view.name;
}

/** The app frame with the number of active jobs of the surrounding `JobsProvider`. */
function JobsAppShell(props: Omit<ComponentProps<typeof AppShell>, 'activeJobs'>) {
  const { active } = useJobs();
  return <AppShell {...props} activeJobs={active} />;
}

export function WorkspaceShell({ workspace, onClosed }: Props) {
  const [view, setView] = useState<View>({ name: 'assets' });
  const [error, setError] = useState<string | null>(null);
  // The inbox reports a running import so closing cannot interrupt the batch.
  const [busy, setBusy] = useState(false);
  // List state lives here so it survives navigation; it is dropped with the workspace.
  const [shell, setShell] = useState<ShellState>(INITIAL_SHELL);
  const setAssetList = (assetList: AssetListState) => setShell((current) => ({ ...current, assetList }));
  const setProjectList = (projectList: ProjectListState) => setShell((current) => ({ ...current, projectList }));
  const setInboxList = (inboxList: InboxListState) => setShell((current) => ({ ...current, inboxList }));
  const setAssetTab = (assetTab: AssetTab) => setShell((current) => ({ ...current, assetTab }));

  function showAssets(filters: Pick<AssetFilters, 'projectId' | 'tagNames'>) {
    setAssetList({ filters: { ...NO_FILTERS, ...filters }, scrollOffset: 0, openedIndex: null, selectedId: null });
    setView({ name: 'assets' });
  }

  async function closeWorkspace() {
    try {
      await call('workspace:close', {});
      onClosed();
    } catch (e) {
      setError(describeError(e));
    }
  }

  function navigate(section: Section) {
    setError(null);
    setView({ name: section } as View);
  }

  return (
    <JobsProvider>
      <ProviderSettingsProvider>
        <JobsAppShell
          workspaceName={workspace.name}
          rootPath={workspace.rootPath}
          section={sectionOf(view)}
          busy={busy}
          onNavigate={navigate}
          onClose={() => void closeWorkspace()}
        >
          {/* The screens bring their own padding. */}
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
        </JobsAppShell>
      </ProviderSettingsProvider>
    </JobsProvider>
  );
}
