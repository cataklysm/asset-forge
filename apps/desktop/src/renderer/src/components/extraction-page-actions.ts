import type { RefObject } from 'react';
import type { SiteCrawlTaskSummary, UrlImportResult } from '@assetforge/contracts';
import { call } from '../api';
import type { CrawlTaskList } from './site-crawl-tasks';
import type { SiteActionOwner } from './site-import-actions';
import { siteImportSelection, type SiteImportSelection } from './SiteCrawlReview';

/** The current explicit selection belongs to exactly one extraction. */
export interface ExtractionSelection {
  crawlId: string;
  value: SiteImportSelection;
}

/** The state an extraction page action can update while its page is mounted. */
export interface ExtractionPageActions {
  owner: SiteActionOwner;
  tasks: CrawlTaskList;
  selection: RefObject<ExtractionSelection | null>;
  refreshJobs(): void;
  refreshDetail(): void;
  choose(crawlId: string): void;
  imported(crawlId: string, result: UrlImportResult): void;
  removed(crawlId: string): void;
  cleared(removed: number): void;
}

/**
 * Refreshes persisted headers and the selected detail after a short queue action.
 * @param state the mounted page
 * @returns after the task page was refreshed
 */
export async function refreshExtractions(state: ExtractionPageActions): Promise<void> {
  state.refreshJobs();
  if (state.owner.disposed.current) return;
  state.refreshDetail();
  await state.tasks.refresh();
}

/**
 * Imports the chosen card with live filename matches and the task's captured destination.
 * @param state page and current explicit selection
 * @param crawlId the card being acted on
 * @param explicit choices from the detail panel, otherwise its current or default selection
 * @returns after import and refresh
 */
export async function importExtraction(
  state: ExtractionPageActions,
  crawlId: string,
  explicit?: SiteImportSelection,
): Promise<void> {
  const task = await call('sites:getCrawl', { crawlId });
  const choices =
    explicit ??
    (state.selection.current?.crawlId === crawlId ? state.selection.current.value : siteImportSelection(task));
  const result = await call('sites:import', { crawlId, ...choices });
  if (state.owner.disposed.current) return;
  state.imported(crawlId, result);
  await refreshExtractions(state);
}

/**
 * Restarts the same persisted extraction from scratch without enqueueing a second card.
 * @param state mounted page
 * @param crawlId saved extraction
 * @returns after restart and refresh
 */
export async function restartExtraction(state: ExtractionPageActions, crawlId: string): Promise<void> {
  await call('sites:restartCrawl', { crawlId });
  if (state.owner.disposed.current) return;
  state.selection.current = null;
  state.choose(crawlId);
  await refreshExtractions(state);
}

/**
 * Cancels only the requested extraction, preserving its partial results.
 * @param state mounted page
 * @param crawlId requested card
 * @returns after cancellation and refresh
 */
export async function cancelExtraction(state: ExtractionPageActions, crawlId: string): Promise<void> {
  await call('sites:cancelCrawl', { crawlId });
  await refreshExtractions(state);
}

/**
 * Removes only confirmed review history and keeps the current task page within its remaining range.
 * @param state mounted page
 * @param crawlId confirmed card
 * @returns after removal and refresh
 */
export async function removeExtraction(state: ExtractionPageActions, crawlId: string): Promise<void> {
  await call('sites:removeCrawl', { crawlId });
  if (state.owner.disposed.current) return;
  state.removed(crawlId);
  if (state.tasks.items.length === 1 && state.tasks.page > 0) state.tasks.setPage(state.tasks.page - 1);
  await refreshExtractions(state);
}

/**
 * Clears completed imports in one request, preserving failures, active work and all imported content.
 * @param state mounted page
 * @returns after cleanup and refresh
 */
export async function clearCompletedExtractions(state: ExtractionPageActions): Promise<void> {
  const { removed } = await call('sites:clearCompletedCrawls', {});
  if (state.owner.disposed.current) return;
  state.cleared(removed);
  state.tasks.setPage(0);
  await refreshExtractions(state);
}

/**
 * Continues an interrupted run from its checkpoint, distinct from starting over.
 * @param state mounted page
 * @param crawlId interrupted extraction
 * @returns after retry and refresh
 */
export async function retryExtraction(state: ExtractionPageActions, crawlId: string): Promise<void> {
  await call('sites:retryCrawl', { crawlId });
  await refreshExtractions(state);
}

/**
 * Opens the selected profile's ordinary login window.
 * @param task saved profile and gallery URL
 * @returns when the login window was requested
 */
export async function openExtractionLogin(task: SiteCrawlTaskSummary): Promise<void> {
  await call('sites:openLogin', { profileId: task.profileId, url: task.galleryUrl });
}
