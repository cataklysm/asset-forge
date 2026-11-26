import { useState } from 'react';
import type { WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
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
import { FilesScreen } from '../screens/FilesScreen';
import { ProjectScreen } from '../screens/ProjectScreen';
import { ProjectsScreen } from '../screens/ProjectsScreen';
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

export function WorkspaceShell({ workspace, onClosed }: Props) {
  const [view, setView] = useState<View>({ name: 'assets' });
  const [error, setError] = useState<string | null>(null);
  // The inbox reports a running import so closing cannot interrupt the batch.
  const [busy, setBusy] = useState(false);
  // List state lives here so it survives navigation; it is dropped with the workspace.
  const [shell, setShell] = useState<ShellState>(INITIAL_SHELL);
  const [inboxOffset, setInboxOffset] = useState(0);
  const setAssetList = (assetList: AssetListState) => setShell((current) => ({ ...current, assetList }));
  const setProjectList = (projectList: ProjectListState) => setShell((current) => ({ ...current, projectList }));
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
    <AppShell
      workspaceName={workspace.name}
      rootPath={workspace.rootPath}
      section={sectionOf(view)}
      busy={busy}
      onNavigate={navigate}
      onClose={() => void closeWorkspace()}
    >
      {view.name !== 'inbox' ? (
        // Redesigned screens bring their own padding.
        <>
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
          ) : (
            <ProjectsScreen
              state={shell.projectList}
              onStateChange={setProjectList}
              onOpen={(id) => setView({ name: 'project', id })}
              onOpenAsset={(id) => setView({ name: 'asset', id })}
              onShowAssets={showAssets}
            />
          )}
        </>
      ) : (
        /* The inbox still brings its own layout until it is redesigned. */
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
          {error !== null && (
            <p role="alert" className={ALERT}>
              {error}
            </p>
          )}
          <FilesScreen offset={inboxOffset} onOffsetChange={setInboxOffset} onBusyChange={setBusy} />
        </div>
      )}
    </AppShell>
  );
}
