import type { FileOrigin } from '@assetforge/contracts';
import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call, describeError } from '../api';
import { COPY_SOURCE_FAILED, COPY_SOURCE_TITLE, FILE_ORIGINS_LABEL } from '../labels';
import { ALERT, ICON_BUTTON_INLINE, PANEL_TITLE } from '../ui';
import { Link } from './Link';

// The download origins of a file in the details column.

/**
 * The addresses a file was downloaded from, in the file details column. An origin opens through
 * `files:openOrigin` with its ID only: no anchor ever carries the address. Nothing shows while the
 * list loads, when it is empty or when it could not be loaded.
 *
 * @param props the file
 * @returns the section, or nothing
 */
export function FileOrigins({ fileId }: { fileId: string }) {
  const [loaded, setLoaded] = useState<{ fileId: string; origins: readonly FileOrigin[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFailure(null);
    call('files:origins', { fileId }).then(
      (origins) => {
        if (live) setLoaded({ fileId, origins });
      },
      // Without an answer the block stays absent; the file itself is unaffected.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [fileId]);

  /** Copies an address to the clipboard. */
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setFailure(null);
    } catch {
      setFailure(COPY_SOURCE_FAILED);
    }
  }

  /** Asks the main process to open an origin in the browser. */
  async function open(originId: string) {
    setFailure(null);
    try {
      await call('files:openOrigin', { fileId, originId });
    } catch (caught) {
      setFailure(describeError(caught));
    }
  }

  if (loaded === null || loaded.fileId !== fileId || loaded.origins.length === 0) return null;
  return (
    <section aria-label={FILE_ORIGINS_LABEL} className="space-y-2">
      <h3 className={PANEL_TITLE}>{FILE_ORIGINS_LABEL}</h3>
      {/* Five rows (h-8 with a 4 px gap) and the 4 px padding that keeps focus rings unclipped fit; more scroll. */}
      <ul className="max-h-46 min-w-0 space-y-1 overflow-y-auto p-1">
        {loaded.origins.map((origin) => (
          <li key={origin.id} className="flex min-w-0 items-center gap-1">
            <Link onFollow={() => void open(origin.id)} title={origin.url} className="block min-w-0 flex-1 truncate text-sm">
              {origin.url}
            </Link>
            <button
              type="button"
              className={`shrink-0 ${ICON_BUTTON_INLINE}`}
              title={COPY_SOURCE_TITLE}
              aria-label={COPY_SOURCE_TITLE}
              onClick={() => void copy(origin.url)}
            >
              <Copy size={14} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {failure !== null && (
        <p role="alert" className={ALERT}>
          {failure}
        </p>
      )}
    </section>
  );
}
