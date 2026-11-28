import { useEffect, useId, useRef, useState } from 'react';
import {
  belongsToSite,
  type FileTarget,
  type SiteProfile,
  type SiteCrawlTask,
  type UrlImportResult,
} from '@assetforge/contracts';
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
  SITE_REMOVE_EXTRACTION_LABEL,
  SITE_REMOVE_EXTRACTION_TITLE,
  SITE_REMOVE_EXTRACTION_DESCRIPTION,
  SITE_PROFILE_UNAVAILABLE,
  SITE_SAVE_BEFORE_SWITCH_HINT,
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

/** The shared workspace is hosted either by the existing dialog or by a full navigation page. */
type WorkspaceProps =
  | (Props & { presentation: 'dialog' })
  | {
      presentation: 'page';
      target: FileTarget | null;
      onImported?(): void;
      onClose?: never;
    };

/**
 * Opens the shared import workspace in the existing asset/inbox dialog.
 * @param props the captured destination and dialog callbacks
 * @returns the dialog-hosted workspace
 */
export function SiteImportDialog(props: Props) {
  return <SiteImportWorkspace {...props} presentation="dialog" />;
}

/**
 * Shared profile configuration, extraction queue and result review for dialogs and the navigation page.
 *
 * @param props the destination for new tasks and dialog callbacks
 * @returns the import workspace and profile-deletion confirmation
 */
export function SiteImportWorkspace({ target, onClose, onImported, presentation }: WorkspaceProps) {
  const selectId = useId();
  const selectRef = useRef<HTMLSelectElement>(null);
  const profileFormRef = useRef<HTMLDivElement>(null);
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
  const [confirmRemove, setConfirmRemove] = useState<SiteCrawlTask | null>(null);
  const [profileFocusRequested, setProfileFocusRequested] = useState(false);
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
    if (!profileFocusRequested || busy !== null) return;
    profileFormRef.current?.scrollTo({ top: 0 });
    selectRef.current?.focus({ preventScroll: true });
    setProfileFocusRequested(false);
  }, [profileFocusRequested, busy]);

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
  const profileHasUnsavedChanges = saved?.id === selected.task?.profileId && dirty;
  const hasUnsavedChanges = saved === null ? !sameDraft(draft, newDraft()) : dirty;
  const taskProfileExists = profiles.some((profile) => profile.id === selected.task?.profileId);

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

  const focusProfileForm = () => {
    setProfileFocusRequested(true);
  };

  const editTaskProfile = () =>
    run('edit', () => {
      const task = selected.task;
      if (task === null) return Promise.resolve();
      if (profileHasUnsavedChanges) {
        focusProfileForm();
        return Promise.resolve();
      }
      if (hasUnsavedChanges) {
        setError(SITE_SAVE_BEFORE_SWITCH_HINT);
        return Promise.resolve();
      }
      return call('sites:list', {}).then(({ profiles: loaded }) => {
        if (disposed.current) return;
        const live = loaded.find((profile) => profile.id === task.profileId);
        setProfiles(loaded);
        select(live ?? null);
        if (live === undefined) setError(SITE_PROFILE_UNAVAILABLE);
        else focusProfileForm();
      });
    });

  const extractAgain = () =>
    run('queue', () => {
      const task = selected.task;
      if (task === null || profileHasUnsavedChanges || !taskProfileExists) return Promise.resolve();
      return call('sites:enqueueCrawl', { profileId: task.profileId, url: task.galleryUrl, target: task.target }).then(
        ({ crawlId }) => {
          jobs.refresh();
          if (disposed.current) return;
          setSelectedCrawlId(crawlId);
          setImportResult(null);
          tasks.setPage(0);
          return tasks.refresh();
        },
      );
    });

  const removeExtraction = () =>
    run('remove', () => {
      const task = confirmRemove;
      if (task === null) return Promise.resolve();
      setConfirmRemove(null);
      return call('sites:removeCrawl', { crawlId: task.crawlId }).then(() => {
        if (disposed.current) return;
        setSelectedCrawlId((current) => (current === task.crawlId ? null : current));
        setImportResult(null);
        if (tasks.items.length === 1 && tasks.page > 0) tasks.setPage(tasks.page - 1);
        return tasks.refresh();
      });
    });

  const shownError = error ?? tasks.error ?? selected.error;
  const content = (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <p className={`shrink-0 text-sm ${MUTED}`}>{SITE_BACKGROUND_HINT}</p>
      <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto lg:grid-cols-[20rem_minmax(0,1fr)] lg:overflow-hidden">
        <div
          ref={profileFormRef}
          className={`min-h-0 overflow-y-auto overscroll-contain rounded-control border p-3 ${BORDER}`}
        >
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
        <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto overscroll-contain">
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
                onRemove={() => setConfirmRemove(selected.task)}
                onEditProfile={() => void editTaskProfile()}
                onExtractAgain={() => void extractAgain()}
                canExtractAgain={taskProfileExists && !profileHasUnsavedChanges}
                profileHasUnsavedChanges={profileHasUnsavedChanges}
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
        <p role="alert" className={`shrink-0 ${ALERT}`}>
          {shownError}
        </p>
      )}
      {presentation === 'dialog' && (
        <div className={`flex shrink-0 justify-end border-t pt-3 ${BORDER}`}>
          <button type="button" className={BUTTON} onClick={onClose}>
            {CLOSE_LABEL}
          </button>
        </div>
      )}
    </div>
  );
  return (
    <>
      {presentation === 'dialog' ? (
        <Dialog open title={SITE_IMPORT_LABEL} size="workspace" onClose={onClose} initialFocusRef={selectRef}>
          {content}
        </Dialog>
      ) : (
        content
      )}
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
      <ConfirmDialog
        open={confirmRemove !== null}
        title={SITE_REMOVE_EXTRACTION_TITLE}
        description={SITE_REMOVE_EXTRACTION_DESCRIPTION}
        confirmLabel={SITE_REMOVE_EXTRACTION_LABEL}
        busy={busy === 'remove'}
        onConfirm={() => void removeExtraction()}
        onCancel={() => setConfirmRemove(null)}
      />
    </>
  );
}
