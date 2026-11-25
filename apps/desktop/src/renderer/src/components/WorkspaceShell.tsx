import { useState } from 'react';
import type { WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import type { View } from '../nav';
import { AssetsScreen } from '../screens/AssetsScreen';
import { FilesScreen } from '../screens/FilesScreen';
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
  // Until the detail screens exist, `asset` and `project` render the list screens.
  const [view, setView] = useState<View>({ name: 'assets' });
  const [error, setError] = useState<string | null>(null);
  // The inbox reports a running import so closing cannot interrupt the batch.
  const [busy, setBusy] = useState(false);

  async function closeWorkspace() {
    try {
      await call('workspace:close', {});
      onClosed();
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-6">
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
        <FilesScreen onBusyChange={setBusy} />
      ) : view.name === 'projects' || view.name === 'project' ? (
        <ProjectsScreen onOpen={(id) => setView({ name: 'project', id })} />
      ) : (
        <AssetsScreen onOpen={(id) => setView({ name: 'asset', id })} />
      )}
    </main>
  );
}
