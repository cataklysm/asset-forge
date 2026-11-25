import { useEffect, useState } from 'react';
import type { WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { formatDateTime } from '../format';

interface Props {
  onOpened(workspace: WorkspaceSummary): void;
}

const BUTTON =
  'rounded bg-slate-800 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:opacity-50';

export function WorkspaceScreen({ onOpened }: Props) {
  const [known, setKnown] = useState<WorkspaceSummary[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    call('workspace:list', {}).then(
      (value) => {
        if (active) setKnown(value);
      },
      (e: unknown) => {
        if (active) setError(describeError(e));
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function run(action: () => Promise<WorkspaceSummary | null>) {
    setBusy(true);
    setError(null);
    try {
      const opened = await action();
      if (opened) onOpened(opened);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const openPath = (rootPath: string) => call('workspace:open', { rootPath });

  const create = () =>
    run(async () => {
      const rootPath = await call('dialog:pickDirectory', {});
      return rootPath === null ? null : call('workspace:create', { name: name.trim(), rootPath });
    });

  const openExisting = () =>
    run(async () => {
      const rootPath = await call('dialog:pickDirectory', {});
      return rootPath === null ? null : openPath(rootPath);
    });

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6 text-slate-900">
      <h1 className="text-2xl font-semibold">AssetForge</h1>

      {error !== null && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-red-800">
          {error}
        </p>
      )}

      <section aria-labelledby="known-heading" className="space-y-2">
        <h2 id="known-heading" className="text-lg font-medium">
          Workspaces
        </h2>
        {known === null && <p className="text-slate-600">Loading…</p>}
        {known?.length === 0 && <p className="text-slate-600">No workspaces yet.</p>}
        {known && known.length > 0 && (
          <ul className="divide-y rounded border">
            {known.map((workspace) => (
              <li key={workspace.id} className="flex items-center justify-between gap-4 p-3">
                <div className="min-w-0">
                  <div className="font-medium">{workspace.name}</div>
                  <div className="truncate text-sm text-slate-600">{workspace.rootPath}</div>
                  <div className="text-xs text-slate-500">
                    Last opened {formatDateTime(workspace.lastOpenedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy}
                  onClick={() => void run(() => openPath(workspace.rootPath))}
                >
                  Open
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="create-heading" className="space-y-2">
        <h2 id="create-heading" className="text-lg font-medium">
          Create workspace
        </h2>
        <div className="flex gap-2">
          <input
            aria-label="Workspace name"
            placeholder="Workspace name"
            maxLength={200}
            className="flex-1 rounded border px-2 py-1.5"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="button"
            className={BUTTON}
            disabled={busy || name.trim() === ''}
            onClick={() => void create()}
          >
            Choose folder
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Existing workspace</h2>
        <button type="button" className={BUTTON} disabled={busy} onClick={() => void openExisting()}>
          Open existing folder
        </button>
      </section>
    </main>
  );
}
