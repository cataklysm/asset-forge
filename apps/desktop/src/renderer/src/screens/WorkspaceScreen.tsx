import { Folder, FolderOpen, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { formatDateTime } from '../format';
import { Dialog } from '../components/Dialog';
import { Menu } from '../components/Menu';
import { Page } from '../components/Page';
import { ALERT, BORDER, BUTTON, BUTTON_INLINE, INPUT, MUTED, PAGE_TITLE } from '../ui';

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
  const [creating, setCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const trimmedName = name.trim();
  // Newest first; ISO timestamps sort as text.
  const sorted = useMemo(
    () => (known === null ? null : [...known].sort((a, b) => (a.lastOpenedAt < b.lastOpenedAt ? 1 : a.lastOpenedAt > b.lastOpenedAt ? -1 : 0))),
    [known],
  );

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


  function cancelCreate() {
    setCreating(false);
    setName('');
    setParentPath(null);
    setError(null);
  }

  const count = sorted?.length ?? 0;
  const headerCell = `px-3 py-2 text-left text-sm font-normal ${MUTED}`;

  return (
    <div className="mx-auto flex h-screen max-w-6xl flex-col bg-bg text-text">
      <div className={`flex h-[76px] shrink-0 items-center gap-4 border-b px-6 ${BORDER}`}>
        <span className={PAGE_TITLE}>AssetForge</span>
      </div>
      <main className="flex min-h-0 flex-1 flex-col overflow-auto">
        <Page
          title="Workspaces"
          count={sorted === null ? null : count}
          actions={
            <>
              <button type="button" className={BUTTON} disabled={busy} onClick={() => void openExisting()}>
                <FolderOpen size={16} aria-hidden />
                Open folder
              </button>
              <button type="button" className={BUTTON} disabled={busy} onClick={() => setCreating(true)}>
                <Plus size={16} aria-hidden />
                New workspace
              </button>
            </>
          }
        >
          {error !== null && !creating && (
            <p role="alert" className={`mb-4 ${ALERT}`}>
              {error}
            </p>
          )}
          <table className={`w-full border-collapse rounded-control border ${BORDER}`}>
            <thead>
              <tr className={`border-b ${BORDER}`}>
                <th scope="col" className={headerCell}>
                  Name
                </th>
                <th scope="col" className={headerCell}>
                  Location
                </th>
                <th scope="col" className={headerCell}>
                  Last opened
                </th>
                <th scope="col" className={headerCell}>
                  <span className="sr-only" />
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted === null
                ? [0, 1, 2].map((index) => (
                    <tr key={index} data-skeleton="" className={`border-b last:border-b-0 ${BORDER}`}>
                      {[0, 1, 2, 3].map((cell) => (
                        <td key={cell} className="px-3 py-3">
                          <div className="h-4 animate-pulse rounded-control bg-raised" />
                        </td>
                      ))}
                    </tr>
                  ))
                : sorted.map((workspace) => (
                    <tr key={workspace.id} className={`border-b last:border-b-0 ${BORDER}`}>
                      <td className="px-3 py-3">
                        <span className="flex items-center gap-2 font-semibold">
                          <Folder size={18} aria-hidden />
                          {workspace.name}
                        </span>
                      </td>
                      <td className={`max-w-0 truncate px-3 py-3 ${MUTED}`} title={workspace.rootPath}>
                        {workspace.rootPath}
                      </td>
                      <td className={`whitespace-nowrap px-3 py-3 ${MUTED}`}>
                        {formatDateTime(workspace.lastOpenedAt)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            className={BUTTON_INLINE}
                            disabled={busy}
                            aria-label={`Open workspace ${workspace.name}`}
                            onClick={() => void run(() => openPath(workspace.rootPath))}
                          >
                            Open
                          </button>
                          <Menu
                            label={`Actions for ${workspace.name}`}
                            items={[
                              {
                                label: 'Remove',
                                disabled: busy,
                                title: 'Remove this workspace from AssetForge; asks before anything is removed',
                                onSelect: () => void remove(workspace),
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
          {sorted !== null && (
            <p className={`mt-3 text-sm ${MUTED}`}>{count === 1 ? '1 workspace' : `${count} workspaces`}</p>
          )}
        </Page>
      </main>

      <Dialog open={creating} title="New workspace" initialFocusRef={nameRef} onClose={cancelCreate}>
        <form className="space-y-3" onSubmit={submitCreate}>
          {error !== null && (
            <p role="alert" className={ALERT}>
              {error}
            </p>
          )}
          <input
            ref={nameRef}
            autoFocus
            aria-label="Workspace name"
            aria-describedby={parentPath === null ? undefined : 'create-location'}
            placeholder="Workspace name"
            maxLength={200}
            className={`w-full ${INPUT}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              title="A folder named after the workspace is created inside the chosen location"
              onClick={() => void chooseParent()}
            >
              {parentPath === null ? 'Choose location' : 'Change location'}
            </button>
          </div>
          {/* Only the path itself; explanations live in tooltips, not in the layout. */}
          {parentPath !== null && (
            <p
              id="create-location"
              title="Folder the workspace will be created in"
              className={`text-sm break-all ${MUTED}`}
            >
              {targetPath ?? parentPath}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={BUTTON} onClick={cancelCreate}>
              Cancel
            </button>
            {/* Stays enabled without a location, so Enter in the name field opens the picker. */}
            <button type="submit" className={BUTTON} disabled={busy || trimmedName === ''}>
              Create
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
