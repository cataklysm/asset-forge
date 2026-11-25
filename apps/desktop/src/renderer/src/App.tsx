import { useEffect, useState } from 'react';
import type { IpcResponse, IpcResult } from '@assetforge/contracts';

type WorkspaceListResult = IpcResult<IpcResponse<'workspace:list'>>;

/** Placeholder until the minimal UI lands: shows the raw result of `workspace:list`. */
export function App() {
  const [result, setResult] = useState<WorkspaceListResult | null>(null);

  useEffect(() => {
    let active = true;
    void window.assetForge.invoke('workspace:list', {}).then((value) => {
      if (active) setResult(value);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main>
      <h1>AssetForge</h1>
      {result === null && <p>Loading workspaces…</p>}
      {result !== null && !result.ok && <p role="alert">Error: {result.error.code}</p>}
      {result?.ok && result.value.length === 0 && <p>No workspaces yet.</p>}
      {result?.ok && result.value.length > 0 && (
        <ul>
          {result.value.map((workspace) => (
            <li key={workspace.id}>
              {workspace.name} — {workspace.rootPath}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
