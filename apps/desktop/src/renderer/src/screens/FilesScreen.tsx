import { useCallback, useEffect, useState } from 'react';
import type { FileList, ImportResult, WorkspaceSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { formatBytes, formatDateTime } from '../format';
import { ALERT, BORDER, BUTTON, MUTED } from '../ui';

interface Props {
  workspace: WorkspaceSummary;
  onClosed(): void;
}

const PAGE_SIZE = 50;

export function FilesScreen({ workspace, onClosed }: Props) {
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<FileList | null>(null);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (at: number) => {
    try {
      setList(await call('files:list', { limit: PAGE_SIZE, offset: at, scope: { kind: 'inbox' } }));
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void load(offset);
  }, [load, offset]);

  async function importFiles() {
    setError(null);
    setImporting(true);
    try {
      const sourcePaths = await call('dialog:pickFiles', {});
      if (sourcePaths.length === 0) return;
      setResults(await call('files:import', { sourcePaths }));
      setOffset(0);
      await load(0);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setImporting(false);
    }
  }

  async function closeWorkspace() {
    try {
      await call('workspace:close', {});
      onClosed();
    } catch (e) {
      setError(describeError(e));
    }
  }

  const failed = results?.filter((result) => result.error !== null) ?? [];
  // A duplicate is still imported (it only has matching content), so it counts in both figures.
  const duplicates = results?.filter((result) => result.duplicateOf.length > 0).length ?? 0;
  const imported = (results?.length ?? 0) - failed.length;
  const total = list?.total ?? 0;

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{workspace.name}</h1>
          <p className={`truncate text-sm ${MUTED}`}>{workspace.rootPath}</p>
        </div>
        {/* Closing mid-batch would fail the remaining files and leave a pending row. */}
        <button
          type="button"
          className={BUTTON}
          disabled={importing}
          onClick={() => void closeWorkspace()}
        >
          Close workspace
        </button>
      </header>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className={BUTTON}
          disabled={importing}
          onClick={() => void importFiles()}
        >
          Import files
        </button>
        {importing && <span className={`text-sm ${MUTED}`}>Importing…</span>}
      </div>

      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}

      {results !== null && (
        <div className="space-y-1">
          <p>
            {imported} imported, {failed.length} failed, {duplicates} duplicates
          </p>
          {failed.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-red-800 dark:text-red-300">
              {failed.map((result) => (
                <li key={result.sourcePath}>
                  {result.sourcePath}: {result.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {list === null ? (
        <p className={MUTED}>Loading…</p>
      ) : (
        <>
          <table className="w-full text-left text-sm">
            <thead className={`border-b ${BORDER} ${MUTED}`}>
              <tr>
                <th className="py-1 pr-3">Name</th>
                <th className="py-1 pr-3">Type</th>
                <th className="py-1 pr-3">Size</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1">Imported</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((file) => (
                <tr key={file.id} className={`border-b ${BORDER}`}>
                  <td className="py-1 pr-3">{file.originalName}</td>
                  <td className="py-1 pr-3">{file.mimeType}</td>
                  <td className="py-1 pr-3">{formatBytes(file.sizeBytes)}</td>
                  <td className="py-1 pr-3">{file.status}</td>
                  <td className="py-1">{formatDateTime(file.importedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {total === 0 && <p className={MUTED}>No files yet.</p>}
          <nav className="flex items-center gap-3 text-sm" aria-label="Pagination">
            <button
              type="button"
              className={BUTTON}
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <span>
              {total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <button
              type="button"
              className={BUTTON}
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </nav>
        </>
      )}
    </main>
  );
}
