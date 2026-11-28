import { FolderOpen, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { Page } from '../components/Page';
import { useCreatePathPreview } from '../hooks/useCreatePathPreview';
import { APP_NAME, NEW_WORKSPACE_LABEL, OPEN_FOLDER_LABEL, WORKSPACES_TITLE, workspaceCount } from '../labels';
import { ALERT, BORDER, BUTTON, MUTED, PAGE_TITLE } from '../ui';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';
import { WORKSPACE_OPEN_SELECTOR, WorkspaceTable } from './WorkspaceTable';

/** The props of `WorkspaceScreen`. */
interface Props {
  /** Called with the workspace that was opened or created. */
  onOpened(workspace: WorkspaceSummary): void;
}

/**
 * Newest first; ISO timestamps sort as text.
 *
 * @param first one workspace
 * @param second another workspace
 * @returns the sort order
 */
function byLastOpened(first: WorkspaceSummary, second: WorkspaceSummary): number {
  if (first.lastOpenedAt < second.lastOpenedAt) return 1;
  if (first.lastOpenedAt > second.lastOpenedAt) return -1;
  return 0;
}

/**
 * Focuses the Open button of the row now at `index`, else the last row's, else the fallback.
 *
 * @param scope the element that holds the table, or null before it mounted
 * @param index the row index of the removed workspace
 * @param fallback the element focused when no row is left
 */
function focusNeighbour(scope: HTMLElement | null, index: number, fallback: HTMLElement | null): void {
  const buttons = [...(scope?.querySelectorAll<HTMLElement>(WORKSPACE_OPEN_SELECTOR) ?? [])];
  (buttons[Math.min(index, buttons.length - 1)] ?? fallback)?.focus();
}

/**
 * Opens a workspace by its directory.
 *
 * @param rootPath the workspace directory
 * @returns the opened workspace
 */
function openPath(rootPath: string): Promise<WorkspaceSummary> {
  return call('workspace:open', { rootPath });
}

/**
 * The start screen without an open workspace: the known workspaces, Open folder and New workspace.
 *
 * @param props the open callback
 * @returns the screen
 */
export function WorkspaceScreen({ onOpened }: Props) {
  const [known, setKnown] = useState<WorkspaceSummary[] | null>(null);
  const [name, setName] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const newWorkspaceRef = useRef<HTMLButtonElement>(null);
  // The row index of a removed workspace until the focus moved to its neighbour.
  const focusAfterRemoval = useRef<number | null>(null);

  const trimmedName = name.trim();
  const sorted = useMemo(() => (known === null ? null : [...known].sort(byLastOpened)), [known]);

  useEffect(() => {
    let active = true;
    call('workspace:list', {}).then(
      (value) => {
        if (active) setKnown(value);
      },
      (failure: unknown) => {
        if (active) setError(describeError(failure));
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const targetPath = useCreatePathPreview(parentPath, trimmedName);

  async function run(action: () => Promise<WorkspaceSummary | null>) {
    setBusy(true);
    setError(null);
    try {
      const opened = await action();
      if (opened) onOpened(opened);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

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
      const index = sorted?.findIndex((other) => other.id === workspace.id) ?? -1;
      const { removed } = await call('workspace:remove', { id: workspace.id });
      if (!removed) return null;
      setKnown(await call('workspace:list', {}));
      focusAfterRemoval.current = Math.max(index, 0);
      return null;
    });

  // The removed row took the focused menu with it: once the list shows again, its neighbour takes the focus.
  useEffect(() => {
    if (busy || focusAfterRemoval.current === null) return;
    focusNeighbour(mainRef.current, focusAfterRemoval.current, newWorkspaceRef.current);
    focusAfterRemoval.current = null;
  }, [busy, sorted]);

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

  return (
    <div className="mx-auto flex h-screen max-w-6xl flex-col bg-bg text-text">
      <div className={`flex h-[76px] shrink-0 items-center gap-4 border-b px-6 ${BORDER}`}>
        <h1 className={PAGE_TITLE}>{APP_NAME}</h1>
      </div>
      <main ref={mainRef} className="flex min-h-0 flex-1 flex-col overflow-auto">
        <Page
          title={WORKSPACES_TITLE}
          count={sorted === null ? null : count}
          actions={
            <>
              <button type="button" className={BUTTON} disabled={busy} onClick={() => void openExisting()}>
                <FolderOpen size={16} aria-hidden />
                {OPEN_FOLDER_LABEL}
              </button>
              <button
                ref={newWorkspaceRef}
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => setCreating(true)}
              >
                <Plus size={16} aria-hidden />
                {NEW_WORKSPACE_LABEL}
              </button>
            </>
          }
        >
          {error !== null && !creating && (
            <p role="alert" className={`mb-4 ${ALERT}`}>
              {error}
            </p>
          )}
          <WorkspaceTable
            sorted={sorted}
            busy={busy}
            onOpen={(workspace) => void run(() => openPath(workspace.rootPath))}
            onRemove={(workspace) => void remove(workspace)}
          />
          {sorted !== null && <p className={`mt-3 text-sm ${MUTED}`}>{workspaceCount(count)}</p>}
        </Page>
      </main>

      <CreateWorkspaceDialog
        open={creating}
        nameRef={nameRef}
        error={error}
        name={name}
        setName={setName}
        parentPath={parentPath}
        targetPath={targetPath}
        busy={busy}
        nameEmpty={trimmedName === ''}
        onSubmit={submitCreate}
        onChooseParent={() => void chooseParent()}
        onCancel={cancelCreate}
      />
    </div>
  );
}
