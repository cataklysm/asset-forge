import { useRef, useState, type ReactNode } from 'react';
import { baseName, isZipPath } from '../import-result';
import {
  archiveCountLabel,
  CANCEL_LABEL,
  IMPORT_AS_FILE_LABEL,
  IMPORT_AS_FILE_TITLE,
  UNPACK_LABEL,
  UNPACK_TITLE,
  ZIP_ARCHIVE_TITLE,
  ZIP_CANCEL_TITLE,
} from '../labels';
import { BUTTON } from '../ui';
import { Dialog } from './Dialog';

// The question whether picked ZIP archives are unpacked, asked before an import starts.

/** true = unpack, false = import as file, null = cancelled. */
type Answer = boolean | null;

/** The open question. */
interface Pending {
  /** The picked ZIP archives. */
  zipPaths: readonly string[];
  /** Ends the wait of `choose`. */
  resolve(answer: Answer): void;
}

/**
 * Asks whether picked ZIP archives are unpacked or imported as files, before an import starts.
 * The screen renders `dialog` and awaits `choose`; Unpack has the initial focus, Esc cancels.
 *
 * @returns the question and the dialog to render
 */
export function useZipChoice(): {
  /** true = unpack, false = import as file, null = cancelled. Resolves false at once, without a dialog, when no path is a ZIP. */
  choose(sourcePaths: readonly string[]): Promise<Answer>;
  /** The dialog; open while a question waits. */
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const unpackRef = useRef<HTMLButtonElement>(null);

  function choose(sourcePaths: readonly string[]): Promise<Answer> {
    const zipPaths = sourcePaths.filter(isZipPath);
    if (zipPaths.length === 0) return Promise.resolve(false);
    return new Promise<Answer>((resolve) => setPending({ zipPaths, resolve }));
  }

  function answer(value: Answer) {
    pending?.resolve(value);
    setPending(null);
  }

  const zipPaths = pending?.zipPaths ?? [];
  const dialog = (
    <Dialog open={pending !== null} title={ZIP_ARCHIVE_TITLE} onClose={() => answer(null)} initialFocusRef={unpackRef}>
      <div className="space-y-4">
        <p className="break-words">{zipPaths.length === 1 ? baseName(zipPaths[0]!) : archiveCountLabel(zipPaths.length)}</p>
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} title={ZIP_CANCEL_TITLE} onClick={() => answer(null)}>
            {CANCEL_LABEL}
          </button>
          <button type="button" className={BUTTON} title={IMPORT_AS_FILE_TITLE} onClick={() => answer(false)}>
            {IMPORT_AS_FILE_LABEL}
          </button>
          <button ref={unpackRef} type="button" className={BUTTON} title={UNPACK_TITLE} onClick={() => answer(true)}>
            {UNPACK_LABEL}
          </button>
        </div>
      </div>
    </Dialog>
  );
  return { choose, dialog };
}
