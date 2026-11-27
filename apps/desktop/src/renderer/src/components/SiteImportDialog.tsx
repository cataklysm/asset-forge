import { useEffect, useId, useRef, useState } from 'react';
import { belongsToSite, type FileKind, type FileTarget, type SiteProfile, type UrlImportResult } from '@assetforge/contracts';
import { call } from '../api';
import { useJobs } from '../jobs-context';
import {
  CLOSE_LABEL,
  CRAWL_CANCEL_LABEL,
  CRAWL_CANCEL_TITLE,
  CRAWL_CANCELLED_LABEL,
  CRAWL_PROBLEMS_LABEL,
  CRAWL_PROGRESS_LABEL,
  CRAWL_TRUNCATED_LABELS,
  crawlProgressText,
  DELETE_LABEL,
  DELETE_SITE_PROFILE_TITLE,
  deleteSiteProfileTitle,
  FILE_KIND_OPTIONS,
  FILE_XPATH_LABEL,
  FILE_XPATH_TITLE,
  FOUND_FILES_LABEL,
  GALLERY_URL_LABEL,
  GALLERY_URL_TITLE,
  IMPORT_LABEL,
  LOG_IN_LABEL,
  LOG_IN_TITLE,
  MAX_FILES_LABEL,
  MAX_FILES_TITLE,
  MAX_PAGES_LABEL,
  MAX_PAGES_TITLE,
  MIN_SIZE_LABEL,
  MIN_SIZE_TITLE,
  moreProblemsText,
  NEW_SITE_PROFILE_LABEL,
  NEW_SITE_PROFILE_OPTION,
  NEW_SITE_PROFILE_TITLE,
  PAGINATION_XPATH_LABEL,
  PAGINATION_XPATH_TITLE,
  SAVE_LABEL,
  SAVE_SITE_PROFILE_TITLE,
  SITE_ADDRESS_LABEL,
  SITE_ADDRESS_TITLE,
  SITE_CRAWL_COUNT_LABELS,
  SITE_IMPORT_LABEL,
  SITE_IMPORT_TITLE,
  SITE_KINDS_LABEL,
  SITE_LABEL,
  SITE_PROFILE_LABEL,
  SITE_PROFILE_NAME_LABEL,
  SITE_TEST_LABEL,
  SITE_TEST_TITLE,
  THUMBNAILS_XPATH_LABEL,
  THUMBNAILS_XPATH_TITLE,
  URL_CONTAINS_LABEL,
  URL_CONTAINS_TITLE,
} from '../labels';
import { shortUrl } from '../format';
import { ALERT, BORDER, BUTTON, FOCUS, INPUT, LABEL, MUTED, SELECT } from '../ui';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import {
  canImport,
  draftOf,
  newDraft,
  noFilesHeadline,
  orderedKinds,
  problemText,
  sameDraft,
  saveRequestOf,
  useCrawlProgress,
  type CrawlAnswer,
  type ProfileDraft,
} from './site-import-state';
import { messageOf, UrlImportResultView } from './UrlImportDialog';

interface Props {
  /** The asset and role the files go to; null for the inbox. */
  target: FileTarget | null;
  onClose(): void;
  /** After `sites:import` answered: with a target the asset has the gallery URL as a source now. */
  onImported?(): void;
}

type Busy = 'save' | 'delete' | 'import' | null;

interface FieldProps {
  label: string;
  title?: string;
  value: string;
  readOnly: boolean;
  numeric?: boolean;
  onChange(value: string): void;
}

function Field({ label, title, value, readOnly, numeric = false, onChange }: FieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        className={INPUT}
        title={title}
        spellCheck={false}
        inputMode={numeric ? 'decimal' : undefined}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * Reads a gallery through a site profile and queues the file URLs it found. The profile form is on the
 * left, the test and its answer on the right; `Import` needs a test of the saved profile and this URL.
 */
export function SiteImportDialog({ target, onClose, onImported }: Props) {
  const selectId = useId();
  const selectRef = useRef<HTMLSelectElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const jobs = useJobs();
  const [profiles, setProfiles] = useState<SiteProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraftState] = useState<ProfileDraft>(newDraft);
  const [url, setUrlState] = useState('');
  const [crawl, setCrawl] = useState<CrawlAnswer | null>(null);
  const [crawling, setCrawling] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UrlImportResult | null>(null);
  // Synchronous guard: a second activation before the re-render must not send twice.
  const acting = useRef(false);
  const crawlingRef = useRef(false);
  const progress = useCrawlProgress(crawling);

  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      // A test still running when the dialog goes is stopped; its answer would have nowhere to go.
      if (crawlingRef.current) void call('sites:cancelCrawl', {}).catch(() => {});
    };
  }, []);

  useEffect(() => {
    call('sites:list', {}).then(
      ({ profiles: loaded }) => {
        if (disposed.current) return;
        setProfiles(loaded);
        const first = loaded[0];
        if (first !== undefined) {
          setSelectedId(first.id);
          setDraftState(draftOf(first));
        }
      },
      (e: unknown) => {
        if (!disposed.current) setError(messageOf(e));
      },
    );
  }, []);

  const done = result !== null;
  useEffect(() => {
    if (done) closeRef.current?.focus();
  }, [done]);

  const saved = profiles.find((p) => p.id === selectedId) ?? null;
  const dirty = saved === null || !sameDraft(draft, draftOf(saved));
  const locked = crawling || busy !== null;
  const request = saveRequestOf(draft, saved?.id ?? null);
  const importable = canImport(crawl, saved?.id ?? null, dirty, url) && !locked;

  function setDraft(patch: Partial<ProfileDraft>) {
    setDraftState((current) => ({ ...current, ...patch }));
    setCrawl(null);
  }

  function setUrl(value: string) {
    setUrlState(value);
    setCrawl(null);
  }

  function select(profile: SiteProfile | null) {
    setSelectedId(profile?.id ?? null);
    setDraftState(profile === null ? newDraft() : draftOf(profile));
    setCrawl(null);
    setError(null);
  }

  function toggleKind(kind: FileKind, on: boolean) {
    setDraft({ kinds: orderedKinds(on ? [...draft.kinds, kind] : draft.kinds.filter((k) => k !== kind)) });
  }

  async function run(kind: Exclude<Busy, null>, action: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (!disposed.current) setError(messageOf(e));
    } finally {
      acting.current = false;
      if (!disposed.current) setBusy(null);
    }
  }

  const save = () =>
    run('save', async () => {
      if (request === null) return;
      const stored = await call('sites:save', request);
      if (disposed.current) return;
      setProfiles((current) =>
        current.some((p) => p.id === stored.id) ? current.map((p) => (p.id === stored.id ? stored : p)) : [...current, stored],
      );
      select(stored);
    });

  const remove = () =>
    run('delete', async () => {
      if (saved === null) return;
      await call('sites:delete', { id: saved.id });
      if (disposed.current) return;
      const rest = profiles.filter((p) => p.id !== saved.id);
      setProfiles(rest);
      select(rest[0] ?? null);
    });

  async function logIn() {
    if (saved === null) return;
    setError(null);
    const typed = url.trim();
    try {
      await call('sites:openLogin', {
        profileId: saved.id,
        ...(typed !== '' && belongsToSite(typed, saved.site) ? { url: typed } : {}),
      });
    } catch (e) {
      if (!disposed.current) setError(messageOf(e));
    }
  }

  const testable = saved !== null && !dirty && url.trim() !== '' && !locked;

  async function test() {
    if (!testable || saved === null || crawlingRef.current) return;
    crawlingRef.current = true;
    setCrawling(true);
    setError(null);
    setCrawl(null);
    const profileId = saved.id;
    const typed = url;
    try {
      const answer = await call('sites:crawl', { profileId, url: typed.trim() });
      if (!disposed.current) setCrawl({ profileId, url: typed, result: answer });
    } catch (e) {
      if (!disposed.current) setError(messageOf(e));
    } finally {
      crawlingRef.current = false;
      if (!disposed.current) setCrawling(false);
    }
  }

  const startImport = () =>
    run('import', async () => {
      if (crawl === null || !importable) return;
      const answer = await call('sites:import', { crawlId: crawl.result.crawlId, target });
      jobs.refresh();
      onImported?.();
      if (!disposed.current) setResult(answer);
    });

  const counts = crawl?.result;

  return (
    <>
      <Dialog open title={SITE_IMPORT_LABEL} size="wide" onClose={onClose} initialFocusRef={selectRef}>
        {result !== null ? (
          <UrlImportResultView result={result} closeRef={closeRef} onClose={onClose} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-4">
              <section className="flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={selectId} className={LABEL}>
                    {SITE_PROFILE_LABEL}
                  </label>
                  <div className="flex gap-2">
                    <select
                      id={selectId}
                      ref={selectRef}
                      className={`${SELECT} min-w-0 flex-1`}
                      value={selectedId ?? ''}
                      disabled={locked}
                      onChange={(e) => select(profiles.find((p) => p.id === e.target.value) ?? null)}
                    >
                      {selectedId === null && <option value="">{NEW_SITE_PROFILE_OPTION}</option>}
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={BUTTON}
                      title={NEW_SITE_PROFILE_TITLE}
                      disabled={locked}
                      onClick={() => select(null)}
                    >
                      {NEW_SITE_PROFILE_LABEL}
                    </button>
                  </div>
                </div>
                <Field
                  label={SITE_PROFILE_NAME_LABEL}
                  value={draft.name}
                  readOnly={locked}
                  onChange={(name) => setDraft({ name })}
                />
                {saved === null ? (
                  <Field
                    label={SITE_ADDRESS_LABEL}
                    title={SITE_ADDRESS_TITLE}
                    value={draft.siteAddress}
                    readOnly={locked}
                    onChange={(siteAddress) => setDraft({ siteAddress })}
                  />
                ) : (
                  <div className="flex flex-col gap-1">
                    <span className={LABEL}>{SITE_LABEL}</span>
                    <span className="text-sm text-text">{saved.site}</span>
                  </div>
                )}
                <Field
                  label={THUMBNAILS_XPATH_LABEL}
                  title={THUMBNAILS_XPATH_TITLE}
                  value={draft.thumbnails}
                  readOnly={locked}
                  onChange={(thumbnails) => setDraft({ thumbnails })}
                />
                <Field
                  label={PAGINATION_XPATH_LABEL}
                  title={PAGINATION_XPATH_TITLE}
                  value={draft.pagination}
                  readOnly={locked}
                  onChange={(pagination) => setDraft({ pagination })}
                />
                <Field
                  label={FILE_XPATH_LABEL}
                  title={FILE_XPATH_TITLE}
                  value={draft.file}
                  readOnly={locked}
                  onChange={(file) => setDraft({ file })}
                />
                <fieldset className="flex flex-col gap-1">
                  <legend className={LABEL}>{SITE_KINDS_LABEL}</legend>
                  <div className="flex flex-wrap gap-3">
                    {FILE_KIND_OPTIONS.map(({ kind, title }) => (
                      <label key={kind} className="inline-flex items-center gap-2 text-sm text-text">
                        <input
                          type="checkbox"
                          className={`accent-accent ${FOCUS}`}
                          checked={draft.kinds.includes(kind)}
                          disabled={locked}
                          onChange={(e) => toggleKind(kind, e.target.checked)}
                        />
                        {title}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="grid grid-cols-2 gap-2">
                  <Field
                    label={MIN_SIZE_LABEL}
                    title={MIN_SIZE_TITLE}
                    value={draft.minKb}
                    readOnly={locked}
                    numeric
                    onChange={(minKb) => setDraft({ minKb })}
                  />
                  <Field
                    label={URL_CONTAINS_LABEL}
                    title={URL_CONTAINS_TITLE}
                    value={draft.urlContains}
                    readOnly={locked}
                    onChange={(urlContains) => setDraft({ urlContains })}
                  />
                  <Field
                    label={MAX_PAGES_LABEL}
                    title={MAX_PAGES_TITLE}
                    value={draft.maxPages}
                    readOnly={locked}
                    numeric
                    onChange={(maxPages) => setDraft({ maxPages })}
                  />
                  <Field
                    label={MAX_FILES_LABEL}
                    title={MAX_FILES_TITLE}
                    value={draft.maxFiles}
                    readOnly={locked}
                    numeric
                    onChange={(maxFiles) => setDraft({ maxFiles })}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={BUTTON}
                    title={SAVE_SITE_PROFILE_TITLE}
                    disabled={locked || !dirty || request === null}
                    onClick={() => void save()}
                  >
                    {SAVE_LABEL}
                  </button>
                  <button
                    type="button"
                    className={BUTTON}
                    title={DELETE_SITE_PROFILE_TITLE}
                    disabled={locked || saved === null}
                    onClick={() => setConfirmDelete(true)}
                  >
                    {DELETE_LABEL}
                  </button>
                  <button
                    type="button"
                    className={BUTTON}
                    title={LOG_IN_TITLE}
                    disabled={locked || saved === null}
                    onClick={() => void logIn()}
                  >
                    {LOG_IN_LABEL}
                  </button>
                </div>
              </section>
              <section className="flex min-w-0 flex-col gap-2">
                <Field
                  label={GALLERY_URL_LABEL}
                  title={GALLERY_URL_TITLE}
                  value={url}
                  readOnly={locked}
                  onChange={setUrl}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={BUTTON}
                    title={SITE_TEST_TITLE}
                    disabled={!testable}
                    onClick={() => void test()}
                  >
                    {SITE_TEST_LABEL}
                  </button>
                  {crawling && (
                    <div className="flex items-center gap-2" role="status" aria-label={CRAWL_PROGRESS_LABEL}>
                      {progress.progress !== null && (
                        <span className={`text-sm tabular-nums ${MUTED}`}>
                          {crawlProgressText(progress.progress.pages, progress.progress.files)}
                        </span>
                      )}
                      <button
                        type="button"
                        className={BUTTON}
                        title={CRAWL_CANCEL_TITLE}
                        disabled={progress.cancelling}
                        onClick={progress.cancel}
                      >
                        {CRAWL_CANCEL_LABEL}
                      </button>
                    </div>
                  )}
                </div>
                {counts !== undefined && (
                  <>
                    <div className="flex flex-col gap-1 text-sm text-text">
                      <p>{`${SITE_CRAWL_COUNT_LABELS.pages} ${counts.pages}`}</p>
                      <p>{`${SITE_CRAWL_COUNT_LABELS.files} ${counts.files.length}`}</p>
                      {(['duplicates', 'filtered', 'disallowed', 'invalid', 'pageFailures'] as const).map((key) =>
                        counts[key] > 0 ? <p key={key}>{`${SITE_CRAWL_COUNT_LABELS[key]} ${counts[key]}`}</p> : null,
                      )}
                      {counts.truncated !== null && <p>{CRAWL_TRUNCATED_LABELS[counts.truncated]}</p>}
                      {counts.cancelled && <p>{CRAWL_CANCELLED_LABEL}</p>}
                    </div>
                    {noFilesHeadline(counts) !== null && (
                      <p className="text-sm text-text">
                        {noFilesHeadline(counts)}
                      </p>
                    )}
                    {counts.problems.length > 0 && (
                      <ul
                        aria-label={CRAWL_PROBLEMS_LABEL}
                        className={`max-h-40 overflow-y-auto rounded-control border p-2 text-sm text-muted ${BORDER}`}
                      >
                        {counts.problems.map((problem) => (
                          <li
                            key={`${problem.stage}\n${problem.reason}\n${problem.url}\n${problem.detail ?? ''}`}
                            className="flex flex-wrap gap-x-2"
                          >
                            <span className="break-all text-text">{problemText(problem)}</span>
                            <span className="break-all" title={problem.url}>
                              {shortUrl(problem.url)}
                            </span>
                          </li>
                        ))}
                        {counts.problemsDropped > 0 && <li>{moreProblemsText(counts.problemsDropped)}</li>}
                      </ul>
                    )}
                    {counts.files.length > 0 && (
                      <ul
                        aria-label={FOUND_FILES_LABEL}
                        className={`h-48 overflow-y-auto rounded-control border p-2 text-sm text-muted ${BORDER}`}
                      >
                        {counts.files.map((file) => (
                          <li key={file} className="break-all">
                            {file}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>
            </div>
            {error !== null && (
              <p role="alert" className={ALERT}>
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={BUTTON} onClick={onClose}>
                {CLOSE_LABEL}
              </button>
              <button
                type="button"
                className={BUTTON}
                title={SITE_IMPORT_TITLE}
                disabled={!importable}
                onClick={() => void startImport()}
              >
                {IMPORT_LABEL}
              </button>
            </div>
          </div>
        )}
      </Dialog>
      {saved !== null && (
        <ConfirmDialog
          open={confirmDelete}
          title={deleteSiteProfileTitle(saved.name)}
          confirmLabel={DELETE_LABEL}
          busy={false}
          onConfirm={() => {
            setConfirmDelete(false);
            void remove();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}
