import { useEffect, useState } from 'react';
import type { WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from './api';
import { FilesScreen } from './screens/FilesScreen';
import { WorkspaceScreen } from './screens/WorkspaceScreen';

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
      <p role="alert" className="p-6 text-red-700">
        {loadError}
      </p>
    );
  }
  if (current === undefined) return <p className="p-6 text-slate-600">Loading…</p>;
  if (current === null) return <WorkspaceScreen onOpened={setCurrent} />;
  return <FilesScreen workspace={current} onClosed={() => setCurrent(null)} />;
}
