import { useEffect, useId, useRef, useState } from 'react';
import { belongsToSite, type FileTarget, type SiteProfile, type UrlImportResult } from '@assetforge/contracts';
import { call } from '../api';
import { useJobs } from '../jobs-context';
import { CLOSE_LABEL, DELETE_LABEL, deleteSiteProfileTitle, IMPORT_LABEL, SITE_IMPORT_LABEL, SITE_IMPORT_TITLE } from '../labels';
import { ALERT, BUTTON } from '../ui';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import {
  canImport,
  draftOf,
  newDraft,
  sameDraft,
  saveRequestOf,
  useCrawlProgress,
  type CrawlAnswer,
  type ProfileDraft,
} from './site-import-state';
import { SiteCrawlPanel } from './SiteCrawlPanel';
import { SiteProfileForm } from './SiteProfileForm';
import { messageOf, UrlImportResultView } from './UrlImportDialog';

// The site import dialog: a profile form, a test of a gallery URL through it, and the import of what the test found.

/** The props of the dialog. */
interface Props {
  /** The asset and role the files go to; null for the inbox. */
  target: FileTarget | null;
  /** Closes the dialog. */
  onClose(): void;
  /** After `sites:import` answered: with a target the asset has the gallery URL as a source now. */
  onImported?(): void;
}

/** The request that runs; null when none does. */
type Busy = 'save' | 'delete' | 'import' | null;

/**
 * Reads a gallery through a site profile and queues the file URLs it found. The profile form is on the
 * left, the test and its answer on the right; `Import` needs a test of the saved profile and this URL.
 *
 * @param props the target, the close and the import notice
 * @returns the dialog and its delete confirmation
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
      (caught: unknown) => {
        if (!disposed.current) setError(messageOf(caught));
      },
    );
  }, []);

  const done = result !== null;
  useEffect(() => {
    if (done) closeRef.current?.focus();
  }, [done]);

  const saved = profiles.find((profile) => profile.id === selectedId) ?? null;
  const dirty = saved === null || !sameDraft(draft, draftOf(saved));
  const locked = crawling || busy !== null;
  const request = saveRequestOf(draft, saved?.id ?? null);
  const importable = canImport(crawl, saved?.id ?? null, dirty, url) && !locked;

  /** Changes some fields; the last test no longer matches. */
  function setDraft(patch: Partial<ProfileDraft>) {
    setDraftState((current) => ({ ...current, ...patch }));
    setCrawl(null);
  }

  /** Changes the gallery URL; the last test no longer matches. */
  function setUrl(value: string) {
    setUrlState(value);
    setCrawl(null);
  }

  /** Selects a saved profile, or null for a new one, and drops the test and the error. */
  function select(profile: SiteProfile | null) {
    setSelectedId(profile?.id ?? null);
    setDraftState(profile === null ? newDraft() : draftOf(profile));
    setCrawl(null);
    setError(null);
  }

  /** Runs one request at a time, showing its failure while the dialog is open. */
  async function run(kind: Exclude<Busy, null>, action: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (caught) {
      if (!disposed.current) setError(messageOf(caught));
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
        current.some((profile) => profile.id === stored.id)
          ? current.map((profile) => (profile.id === stored.id ? stored : profile))
          : [...current, stored],
      );
      select(stored);
    });

  const remove = () =>
    run('delete', async () => {
      if (saved === null) return;
      await call('sites:delete', { id: saved.id });
      if (disposed.current) return;
      const rest = profiles.filter((profile) => profile.id !== saved.id);
      setProfiles(rest);
      select(rest[0] ?? null);
    });

  /** Opens the login window, on the typed gallery URL when it belongs to the profile's site. */
  async function logIn() {
    if (saved === null) return;
    setError(null);
    const typed = url.trim();
    try {
      await call('sites:openLogin', {
        profileId: saved.id,
        ...(typed !== '' && belongsToSite(typed, saved.site) ? { url: typed } : {}),
      });
    } catch (caught) {
      if (!disposed.current) setError(messageOf(caught));
    }
  }

  const testable = saved !== null && !dirty && url.trim() !== '' && !locked;

  /** Tests the saved profile on the typed gallery URL. */
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
    } catch (caught) {
      if (!disposed.current) setError(messageOf(caught));
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

  return (
    <>
      <Dialog open title={SITE_IMPORT_LABEL} size="wide" onClose={onClose} initialFocusRef={selectRef}>
        {result !== null ? (
          <UrlImportResultView result={result} closeRef={closeRef} onClose={onClose} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-4">
              <SiteProfileForm
                selectId={selectId}
                selectRef={selectRef}
                profiles={profiles}
                selectedId={selectedId}
                saved={saved}
                draft={draft}
                locked={locked}
                dirty={dirty}
                savable={request !== null}
                onSelect={select}
                onDraftChange={setDraft}
                onSave={() => void save()}
                onDelete={() => setConfirmDelete(true)}
                onLogIn={() => void logIn()}
              />
              <SiteCrawlPanel
                url={url}
                locked={locked}
                onUrlChange={setUrl}
                testable={testable}
                onTest={() => void test()}
                crawling={crawling}
                progress={progress}
                result={crawl?.result}
              />
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
