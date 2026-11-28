import { useEffect, useId, useRef, useState } from 'react';
import { belongsToSite, type FileTarget, type SiteProfile, type UrlImportResult } from '@assetforge/contracts';
import { call, messageOf } from '../api';
import { useJobs } from '../jobs-context';
import {
  CLOSE_LABEL,
  DELETE_LABEL,
  deleteSiteProfileTitle,
  SITE_IMPORT_LABEL,
  SITE_BACKGROUND_HINT,
  SITE_REVIEW_EMPTY,
  SITE_REVIEW_LABEL,
  siteImportOutcomeText,
} from '../labels';
import { ALERT, BORDER, BUTTON, MUTED, PANEL_TITLE } from '../ui';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import { draftOf, newDraft, sameDraft, saveRequestOf, type ProfileDraft } from './site-import-state';
import { useCrawlTask, useCrawlTasks } from './site-crawl-tasks';
import { enqueueSiteCrawls, runSiteAction, type SiteImportBusy } from './site-import-actions';
import { SiteCrawlReview, type SiteImportSelection } from './SiteCrawlReview';
import { SiteExtractionQueue } from './SiteExtractionQueue';
import { SiteProfileForm } from './SiteProfileForm';

/** The destination captured when each extraction is enqueued. */
interface Props {
  target: FileTarget | null;
  onClose(): void;
  onImported?(): void;
}

/**
 * Profile configuration, background extraction queue and saved result review in one consistent dialog.
 *
 * @param props the destination for new tasks and dialog callbacks
 * @returns the import workspace and profile-deletion confirmation
 */
export function SiteImportDialog({ target, onClose, onImported }: Props) {
  const selectId = useId();
  const selectRef = useRef<HTMLSelectElement>(null);
  const jobs = useJobs();
  const tasks = useCrawlTasks();
  const [profiles, setProfiles] = useState<SiteProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraftState] = useState<ProfileDraft>(newDraft);
  const [urls, setUrls] = useState('');
  const [selectedCrawlId, setSelectedCrawlId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [busy, setBusy] = useState<SiteImportBusy>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<UrlImportResult | null>(null);
  const acting = useRef(false);
  const disposed = useRef(false);
  const selectedSummary = tasks.items.find((task) => task.crawlId === selectedCrawlId);
  const selectedRevision =
    selectedSummary === undefined
      ? undefined
      : JSON.stringify([
          selectedSummary.updatedAt,
          selectedSummary.status,
          selectedSummary.errorCode,
          selectedSummary.errorMessage,
          selectedSummary.progress,
        ]);
  const selected = useCrawlTask(selectedCrawlId, selectedRevision, refreshToken);

  useEffect(() => {
    disposed.current = false;
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
    return () => {
      disposed.current = true;
    };
  }, []);

  const saved = profiles.find((profile) => profile.id === selectedId) ?? null;
  const dirty = saved === null || !sameDraft(draft, draftOf(saved));
  const locked = busy !== null;
  const request = saveRequestOf(draft, saved?.id ?? null);
  const galleryUrls = [
    ...new Set(
      urls
        .split(/\r?\n/)
        .map((url) => url.trim())
        .filter(Boolean),
    ),
  ];
  const queueable = saved !== null && !dirty && galleryUrls.length > 0 && !locked;

  /**
   * Selects a profile without changing saved extraction results.
   * @param profile the profile to edit
   */
  function select(profile: SiteProfile | null) {
    setSelectedId(profile?.id ?? null);
    setDraftState(profile === null ? newDraft() : draftOf(profile));
    setError(null);
  }

  const run = (kind: Exclude<SiteImportBusy, null>, action: () => Promise<void>) =>
    runSiteAction({ acting, disposed, setBusy, setError }, kind, action);

  const refreshTask = () => {
    jobs.refresh();
    if (disposed.current) return Promise.resolve();
    setRefreshToken((current) => current + 1);
    return tasks.refresh();
  };

  const save = () =>
    run('save', () => {
      if (request === null) return Promise.resolve();
      return call('sites:save', request).then((stored) => {
        if (disposed.current) return;
        setProfiles((current) =>
          current.some((profile) => profile.id === stored.id)
            ? current.map((profile) => (profile.id === stored.id ? stored : profile))
            : [...current, stored],
        );
        select(stored);
      });
    });

  const remove = () =>
    run('delete', () => {
      if (saved === null) return Promise.resolve();
      return call('sites:delete', { id: saved.id }).then(() => {
        if (disposed.current) return;
        const rest = profiles.filter((profile) => profile.id !== saved.id);
        setProfiles(rest);
        select(rest[0] ?? null);
      });
    });

  const logIn = () =>
    run('login', () => {
      if (saved === null) return Promise.resolve();
      const first = galleryUrls[0];
      return call('sites:openLogin', {
        profileId: saved.id,
        ...(first !== undefined && belongsToSite(first, saved.site) ? { url: first } : {}),
      }).then(() => {});
    });

  const enqueue = () =>
    run('queue', () => {
      if (!queueable || saved === null) return Promise.resolve();
      return enqueueSiteCrawls(saved.id, galleryUrls, target).then((answer) => {
        jobs.refresh();
        if (disposed.current) return;
        setUrls(answer.failed.join('\n'));
        setError(answer.error);
        setImportResult(null);
        if (answer.lastId !== null) setSelectedCrawlId(answer.lastId);
        tasks.setPage(0);
        return tasks.refresh();
      });
    });

  const importSelected = (selection: SiteImportSelection) =>
    run('import', () => {
      if (selected.task === null) return Promise.resolve();
      // The backend uses the task's captured target, never the currently open asset.
      return call('sites:import', { crawlId: selected.task.crawlId, ...selection }).then((result) => {
        onImported?.();
        if (!disposed.current) setImportResult(result);
        return refreshTask();
      });
    });

  const cancel = () =>
    run('cancel', () => {
      if (selected.task === null) return Promise.resolve();
      return call('sites:cancelCrawl', { crawlId: selected.task.crawlId }).then(refreshTask);
    });

  const taskLogin = () =>
    run('login', () => {
      if (selected.task === null) return Promise.resolve();
      return call('sites:openLogin', { profileId: selected.task.profileId, url: selected.task.galleryUrl }).then(
        () => {},
      );
    });

  const retry = () =>
    run('retry', () => {
      if (selected.task === null) return Promise.resolve();
      return call('sites:retryCrawl', { crawlId: selected.task.crawlId }).then(refreshTask);
    });

  const shownError = error ?? tasks.error ?? selected.error;
  return (
    <>
      <Dialog open title={SITE_IMPORT_LABEL} size="wide" onClose={onClose} initialFocusRef={selectRef}>
        <div className="flex flex-col gap-4">
          <p className={`text-sm ${MUTED}`}>{SITE_BACKGROUND_HINT}</p>
          <div className="grid gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
            <div className={`rounded-control border p-3 ${BORDER}`}>
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
                onDraftChange={(patch) => setDraftState((current) => ({ ...current, ...patch }))}
                onSave={() => void save()}
                onDelete={() => setConfirmDelete(true)}
                onLogIn={() => void logIn()}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <SiteExtractionQueue
                urls={urls}
                target={target}
                locked={locked}
                queueable={queueable}
                tasks={tasks}
                selectedCrawlId={selectedCrawlId}
                onUrlsChange={setUrls}
                onQueue={() => void enqueue()}
                onSelect={(crawlId) => {
                  setSelectedCrawlId(crawlId);
                  setImportResult(null);
                }}
              />
              <section
                aria-label={SITE_REVIEW_LABEL}
                className={`flex flex-col gap-3 rounded-control border p-3 ${BORDER}`}
              >
                <h3 className={PANEL_TITLE}>{SITE_REVIEW_LABEL}</h3>
                {selected.task === null ? (
                  <p className={`text-sm ${MUTED}`}>{SITE_REVIEW_EMPTY}</p>
                ) : (
                  <SiteCrawlReview
                    key={selected.task.crawlId}
                    task={selected.task}
                    busy={locked}
                    onImport={(selection) => void importSelected(selection)}
                    onCancel={() => void cancel()}
                    onLogIn={() => void taskLogin()}
                    onRetry={() => void retry()}
                  />
                )}
                {importResult !== null && (
                  <p role="status" className="text-sm">
                    {siteImportOutcomeText(
                      importResult.queued,
                      importResult.alreadyImported,
                      importResult.alreadyQueued,
                      importResult.invalid.length,
                    )}
                  </p>
                )}
              </section>
            </div>
          </div>
          {shownError !== null && (
            <p role="alert" className={ALERT}>
              {shownError}
            </p>
          )}
          <div className={`flex justify-end border-t pt-3 ${BORDER}`}>
            <button type="button" className={BUTTON} onClick={onClose}>
              {CLOSE_LABEL}
            </button>
          </div>
        </div>
      </Dialog>
      {saved !== null && (
        <ConfirmDialog
          open={confirmDelete}
          title={deleteSiteProfileTitle(saved.name)}
          confirmLabel={DELETE_LABEL}
          busy={busy === 'delete'}
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
