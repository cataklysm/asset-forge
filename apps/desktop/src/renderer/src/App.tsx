import { useEffect, useState } from 'react';
import type { WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from './api';
import { WorkspaceShell } from './components/WorkspaceShell';
import { WorkspaceScreen } from './screens/WorkspaceScreen';

/**
 * The application root: asks for the open workspace once, then shows the workspace shell or the
 * screen that opens or creates one.
 *
 * @returns the loading line, the load error, the workspace screen or the shell
 */
export function App() {
  // `undefined` while the current workspace is still being queried.
  const [current, setCurrent] = useState<WorkspaceSummary | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    call('workspace:current', {}).then(
      (value) => {
        if (active) setCurrent(value);
      },
      (error: unknown) => {
        if (active) setLoadError(describeError(error));
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (loadError !== null) {
    return (
      <p role="alert" className="p-6 text-danger">
        {loadError}
      </p>
    );
  }
  if (current === undefined) return <p className="p-6 text-muted">Loading…</p>;
  if (current === null) return <WorkspaceScreen onOpened={setCurrent} />;
  // Keyed by workspace, so no list, scroll or loader state carries over to another workspace.
  return <WorkspaceShell key={current.id} workspace={current} onClosed={() => setCurrent(null)} />;
}
