import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { IMPORT_URL_STRING_MAX, MAX_IMPORT_URLS, type FileTarget, type UrlImportResult } from '@assetforge/contracts';
import { call, messageOf } from '../api';
import { useJobs } from '../jobs-context';
import {
  CANCEL_LABEL,
  CLOSE_LABEL,
  IMPORT_LABEL,
  SKIP_DUPLICATES_LABEL,
  SKIP_DUPLICATES_TITLE,
  tooManyUrlsTitle,
  URL_IMPORT_COUNT_LABELS,
  URL_IMPORT_LABEL,
  URLS_LABEL,
  URLS_TITLE,
} from '../labels';
import { ALERT, BORDER, BUTTON, FOCUS, LABEL, TEXTAREA } from '../ui';
import { Dialog } from './Dialog';

// The dialog that queues downloads for a list of addresses.

interface Props {
  /** The asset and role the files go to; null for the inbox. */
  target: FileTarget | null;
  /** Closes the dialog. */
  onClose(): void;
}

/** Whether a line holds nothing but white space. */
const isBlank = (line: string) => line.trim() === '';

/** A line the schema would refuse goes trimmed and cut: still over the length limit, it is reported as invalid. */
const sendable = (line: string) =>
  line.length > IMPORT_URL_STRING_MAX ? line.trim().slice(0, IMPORT_URL_STRING_MAX) : line;

/**
 * The lines to send, the typed line number (from 1) of each, and whether there are too many addresses. Up to
 * the limit the lines go as typed (trailing empty lines dropped); beyond it only the non-empty lines go, and
 * `lineNumbers` maps the `line` numbers of the answer back to the lines as typed.
 *
 * @param text the typed text
 * @returns the lines to send, their numbers, the number of addresses and whether they are too many
 */
export function urlLines(text: string): { urls: string[]; lineNumbers: number[]; addresses: number; tooMany: boolean } {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && isBlank(lines[lines.length - 1]!)) lines.pop();
  const numbered = lines.map((line, index) => ({ line: sendable(line), number: index + 1 }));
  const filled = numbered.filter(({ line }) => !isBlank(line));
  const sent = lines.length <= MAX_IMPORT_URLS ? numbered : filled;
  return {
    urls: sent.map(({ line }) => line),
    lineNumbers: sent.map(({ number }) => number),
    addresses: filled.length,
    tooMany: filled.length > MAX_IMPORT_URLS,
  };
}

/**
 * Queues downloads for a list of addresses, one per line, and shows the answer as counts.
 *
 * @param props the target and the close callback
 * @returns the dialog
 */
export function UrlImportDialog({ target, onClose }: Props) {
  const fieldId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const jobs = useJobs();
  const [text, setText] = useState('');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UrlImportResult | null>(null);
  // Synchronous guard: a second activation before the re-render must not send twice.
  const sendingRef = useRef(false);

  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  // The field leaves the dialog with the answer; focus goes to the one button that is left.
  const closeRef = useRef<HTMLButtonElement>(null);
  const done = result !== null;
  useEffect(() => {
    if (done) closeRef.current?.focus();
  }, [done]);

  const lines = urlLines(text);
  const blocked = sending || lines.addresses === 0 || lines.tooMany;

  /** Sends the lines once at a time and keeps the answer with the line numbers as typed. */
  async function start() {
    if (blocked || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    const { urls, lineNumbers } = lines;
    try {
      const answer = await call('files:importUrls', {
        urls,
        ...(target === null ? {} : { target }),
        skipDuplicates,
      });
      jobs.refresh();
      // The answer numbers the lines as sent; the list shows the numbers of the lines as typed.
      const invalid = answer.invalid.map((entry) => ({ ...entry, line: lineNumbers[entry.line - 1] ?? entry.line }));
      if (!disposed.current) setResult({ ...answer, invalid });
    } catch (caught) {
      if (!disposed.current) setError(messageOf(caught));
    } finally {
      sendingRef.current = false;
      if (!disposed.current) setSending(false);
    }
  }

  return (
    <Dialog open title={URL_IMPORT_LABEL} onClose={onClose} initialFocusRef={fieldRef}>
      {result === null ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <label htmlFor={fieldId} className={LABEL}>
            {URLS_LABEL}
          </label>
          <textarea
            id={fieldId}
            ref={fieldRef}
            className={TEXTAREA}
            title={URLS_TITLE}
            spellCheck={false}
            wrap="off"
            value={text}
            readOnly={sending}
            onChange={(event) => setText(event.target.value)}
          />
          <label className="inline-flex items-center gap-2 text-sm text-text" title={SKIP_DUPLICATES_TITLE}>
            <input
              type="checkbox"
              className={`accent-accent ${FOCUS}`}
              checked={skipDuplicates}
              disabled={sending}
              onChange={(event) => setSkipDuplicates(event.target.checked)}
            />
            {SKIP_DUPLICATES_LABEL}
          </label>
          {error !== null && (
            <p role="alert" className={ALERT}>
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={BUTTON} onClick={onClose}>
              {CANCEL_LABEL}
            </button>
            <button
              type="submit"
              className={BUTTON}
              disabled={blocked}
              title={lines.tooMany ? tooManyUrlsTitle(MAX_IMPORT_URLS) : undefined}
            >
              {IMPORT_LABEL}
            </button>
          </div>
        </form>
      ) : (
        <UrlImportResultView result={result} closeRef={closeRef} onClose={onClose} />
      )}
    </Dialog>
  );
}

/**
 * The answer of a started URL import: the counts above 0 (Queued always), the unusable lines and Close.
 *
 * @param props the answer, the Close button's ref and the close callback
 * @returns the view
 */
export function UrlImportResultView({
  result,
  closeRef,
  onClose,
}: {
  /** The answer with the line numbers as typed. */
  result: UrlImportResult;
  /** Receives the Close button, which takes the focus. */
  closeRef: RefObject<HTMLButtonElement | null>;
  /** Closes the dialog. */
  onClose(): void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 text-sm text-text">
        <p>{`${URL_IMPORT_COUNT_LABELS.queued} ${result.queued}`}</p>
        {result.alreadyImported > 0 && <p>{`${URL_IMPORT_COUNT_LABELS.alreadyImported} ${result.alreadyImported}`}</p>}
        {result.alreadyQueued > 0 && <p>{`${URL_IMPORT_COUNT_LABELS.alreadyQueued} ${result.alreadyQueued}`}</p>}
        {result.invalid.length > 0 && <p>{`${URL_IMPORT_COUNT_LABELS.invalid} ${result.invalid.length}`}</p>}
      </div>
      {result.invalid.length > 0 && (
        <ul className={`max-h-48 overflow-y-auto rounded-control border p-2 text-sm text-muted ${BORDER}`}>
          {result.invalid.map((entry) => (
            <li key={entry.line} className="break-all">{`${entry.line}: ${entry.text}`}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">
        <button ref={closeRef} type="button" className={BUTTON} onClick={onClose}>
          {CLOSE_LABEL}
        </button>
      </div>
    </div>
  );
}
