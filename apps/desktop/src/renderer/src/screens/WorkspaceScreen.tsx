import { useEffect, useState, type FormEvent } from 'react';
import type { WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { formatDateTime } from '../format';
import { ALERT, BORDER, BUTTON, BUTTON_SECONDARY, INPUT, MUTED } from '../ui';

interface Props {
  onOpened(workspace: WorkspaceSummary): void;
}

export function WorkspaceScreen({ onOpened }: Props) {
  const [known, setKnown] = useState<WorkspaceSummary[] | null>(null);
  const [name, setName] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [targetPath, setTargetPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();

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

  // Preview of the directory the workspace will get; the main process owns the naming rule.
  useEffect(() => {
    if (parentPath === null || trimmedName === '') {
      setTargetPath(null);
      return;
    }
    let active = true;
    call('workspace:resolveCreatePath', { name: trimmedName, parentPath }).then(
      (value) => {
        if (active) setTargetPath(value);
      },
      () => {
        if (active) setTargetPath(null);
      },
    );
    return () => {
      active = false;
    };
  }, [parentPath, trimmedName]);

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

  const chooseParent = () =>
    run(async () => {
      const picked = await call('dialog:pickDirectory', {});
      if (picked !== null) setParentPath(picked);
      return null;
    });

  /** Enter in the name field lands here: first pick the location, then create. */
  function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (busy || trimmedName === '') return;
    if (parentPath === null) {
      void chooseParent();
      return;
    }
    void run(async () => {
      // Resolved again instead of trusting the preview, which may lag behind the last keystroke.
      const rootPath = await call('workspace:resolveCreatePath', { name: trimmedName, parentPath });
      return call('workspace:create', { name: trimmedName, rootPath });
    });
  }

  /** The main process asks for confirmation in a native dialog before anything is removed. */
  const remove = (workspace: WorkspaceSummary) =>
    run(async () => {
      const { removed } = await call('workspace:remove', { id: workspace.id });
      if (removed) setKnown(await call('workspace:list', {}));
      return null;
    });

  const openExisting = () =>
    run(async () => {
      const rootPath = await call('dialog:pickDirectory', {});
      return rootPath === null ? null : openPath(rootPath);
    });

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6">
      <h1 className="text-2xl font-semibold">AssetForge</h1>

      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}

      <section aria-labelledby="known-heading" className="space-y-2">
        <h2 id="known-heading" className="text-lg font-medium">
          Workspaces
        </h2>
        {known === null && <p className={MUTED}>Loading…</p>}
        {known?.length === 0 && <p className={MUTED}>No workspaces yet.</p>}
        {known && known.length > 0 && (
          <ul className={`divide-y rounded border ${BORDER} divide-slate-300 dark:divide-slate-700`}>
            {known.map((workspace) => (
              <li key={workspace.id} className="flex items-center justify-between gap-4 p-3">
                <div className="min-w-0">
                  <div className="font-medium">{workspace.name}</div>
                  <div className={`truncate text-sm ${MUTED}`}>{workspace.rootPath}</div>
                  <div className="text-xs text-slate-500">
                    Last opened {formatDateTime(workspace.lastOpenedAt)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className={BUTTON_SECONDARY}
                    disabled={busy}
                    aria-label={`Remove workspace ${workspace.name}`}
                    onClick={() => void remove(workspace)}
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={busy}
                    aria-label={`Open workspace ${workspace.name}`}
                    onClick={() => void run(() => openPath(workspace.rootPath))}
                  >
                    Open
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="create-heading" className="space-y-2">
        <h2 id="create-heading" className="text-lg font-medium">
          Create workspace
        </h2>
        <form className="space-y-2" onSubmit={submitCreate}>
          <div className="flex gap-2">
            <input
              autoFocus
              aria-label="Workspace name"
              aria-describedby="create-location"
              placeholder="Workspace name"
              maxLength={200}
              className={`flex-1 ${INPUT}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="button"
              className={BUTTON_SECONDARY}
              disabled={busy}
              onClick={() => void chooseParent()}
            >
              {parentPath === null ? 'Choose location' : 'Change location'}
            </button>
            {/* Stays enabled without a location, so Enter in the name field opens the picker. */}
            <button type="submit" className={BUTTON} disabled={busy || trimmedName === ''}>
              Create
            </button>
          </div>
          <p id="create-location" className={`text-sm break-all ${MUTED}`}>
            {parentPath === null
              ? 'Choose a location. A folder named after the workspace is created inside it.'
              : `Will be created in: ${targetPath ?? parentPath}`}
          </p>
        </form>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Existing workspace</h2>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          disabled={busy}
          onClick={() => void openExisting()}
        >
          Open existing folder
        </button>
      </section>
    </main>
  );
}
