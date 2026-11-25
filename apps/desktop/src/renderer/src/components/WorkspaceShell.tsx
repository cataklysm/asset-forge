import { useState } from 'react';
import type { WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { NO_FILTERS, type AssetListState } from '../list-state';
import type { View } from '../nav';
import { AssetsScreen } from '../screens/AssetsScreen';
import { AssetScreen } from '../screens/AssetScreen';
import { FilesScreen } from '../screens/FilesScreen';
import { ProjectScreen } from '../screens/ProjectScreen';
import { ProjectsScreen } from '../screens/ProjectsScreen';
import { ALERT, BORDER, BUTTON, MUTED } from '../ui';

interface Props {
  workspace: WorkspaceSummary;
  onClosed(): void;
}

const SECTIONS = [
  { view: { name: 'assets' }, title: 'Assets' },
  { view: { name: 'projects' }, title: 'Projects' },
  { view: { name: 'inbox' }, title: 'Inbox' },
] satisfies { view: View; title: string }[];

function sectionOf(view: View): string {
  return view.name === 'asset' ? 'assets' : view.name === 'project' ? 'projects' : view.name;
}

export function WorkspaceShell({ workspace, onClosed }: Props) {
  const [view, setView] = useState<View>({ name: 'assets' });
  const [error, setError] = useState<string | null>(null);
  // The inbox reports a running import so closing cannot interrupt the batch.
  const [busy, setBusy] = useState(false);
  // List state lives here so it survives navigation; it is dropped with the workspace.
  const [assetList, setAssetList] = useState<AssetListState>({
    filters: NO_FILTERS,
    scrollOffset: 0,
    openedIndex: null,
    selectedId: null,
  });
  const [projectsOffset, setProjectsOffset] = useState(0);
  const [inboxOffset, setInboxOffset] = useState(0);
  const fullWidth = view.name === 'assets';

  async function closeWorkspace() {
    try {
      await call('workspace:close', {});
      onClosed();
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <main className={fullWidth ? 'flex h-screen flex-col gap-4 p-6' : 'mx-auto max-w-5xl space-y-4 p-6'}>
      <header className={`flex items-start justify-between gap-4 border-b pb-3 ${BORDER}`}>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{workspace.name}</h1>
          <p className={`truncate text-sm ${MUTED}`}>{workspace.rootPath}</p>
        </div>
        <nav aria-label="Main" className="flex items-center gap-2">
          {SECTIONS.map(({ view: target, title }) => (
            <button
              key={target.name}
              type="button"
              className={BUTTON}
              disabled={busy}
              title={busy ? "Import in progress" : undefined}
              aria-current={sectionOf(view) === target.name ? 'page' : undefined}
              onClick={() => setView(target)}
            >
              {title}
            </button>
          ))}
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            title={busy ? "Import in progress" : undefined}
            onClick={() => void closeWorkspace()}
          >
            Close workspace
          </button>
        </nav>
      </header>

      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}

      {view.name === 'inbox' ? (
        <FilesScreen offset={inboxOffset} onOffsetChange={setInboxOffset} onBusyChange={setBusy} />
      ) : view.name === 'asset' ? (
        <AssetScreen key={view.id} id={view.id} onNavigate={setView} onBusyChange={setBusy} />
      ) : view.name === 'project' ? (
        <ProjectScreen key={view.id} id={view.id} onNavigate={setView} />
      ) : view.name === 'projects' ? (
        <ProjectsScreen
          offset={projectsOffset}
          onOffsetChange={setProjectsOffset}
          onOpen={(id) => setView({ name: 'project', id })}
        />
      ) : (
        <AssetsScreen
          state={assetList}
          onStateChange={setAssetList}
          onOpen={(id) => setView({ name: 'asset', id })}
        />
      )}
    </main>
  );
}
