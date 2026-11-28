import { useCallback, useEffect, useRef, useState } from 'react';
import type { SiteCrawlTask, SiteCrawlTaskSummary } from '@assetforge/contracts';
import { call, messageOf } from '../api';
import { startPolling } from '../poller';
import { CRAWL_POLL_MS } from './site-import-state';

/** Task rows requested at a time; results themselves are loaded only for the selected task. */
export const CRAWL_TASK_PAGE_SIZE = 20;

/** Persisted task list of the open workspace. Closing the view stops polling, never the underlying work. */
export interface CrawlTaskList {
  items: SiteCrawlTaskSummary[];
  total: number;
  page: number;
  loading: boolean;
  error: string | null;
  setPage(page: number): void;
  refresh(): Promise<void>;
}

/**
 * Loads and polls a page of saved extractions independently of any dialog-owned crawl promise.
 *
 * @returns the page, total and controls
 */
export function useCrawlTasks(): CrawlTaskList {
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<SiteCrawlTaskSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const refresh = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    const id = ++epoch.current;
    let pending: Promise<void> | null = null;
    setLoading(true);
    const read = () => {
      if (pending !== null) return pending;
      pending = call('sites:listCrawls', { limit: CRAWL_TASK_PAGE_SIZE, offset: page * CRAWL_TASK_PAGE_SIZE })
        .then(
          (answer) => {
            if (id !== epoch.current) return;
            setItems(answer.items);
            setTotal(answer.total);
            setError(null);
          },
          (caught: unknown) => {
            if (id === epoch.current) setError(messageOf(caught));
          },
        )
        .finally(() => {
          pending = null;
          if (id === epoch.current) setLoading(false);
        });
      return pending;
    };
    refresh.current = read;
    void read();
    const stop = startPolling(read, () => {}, CRAWL_POLL_MS);
    return () => {
      epoch.current = id + 1;
      stop();
    };
  }, [page]);

  const reload = useCallback(() => refresh.current(), []);
  return { items, total, page, loading, error, setPage, refresh: reload };
}

/**
 * Reads a selected task only when its persisted revision changes or the owner refreshes it.
 *
 * @param crawlId the selected task
 * @param revision its summary's persisted update timestamp
 * @param refreshToken an explicit refresh counter
 * @returns its full review data and any read failure
 */
export function useCrawlTask(crawlId: string | null, revision: string | undefined, refreshToken: number) {
  const [task, setTask] = useState<SiteCrawlTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setError(null);
    if (crawlId !== null) {
      call('sites:getCrawl', { crawlId }).then(
        (answer) => {
          if (current) setTask(answer);
        },
        (caught: unknown) => {
          if (current) setError(messageOf(caught));
        },
      );
    }
    return () => {
      current = false;
    };
  }, [crawlId, revision, refreshToken]);
  return { task: task?.crawlId === crawlId ? task : null, error };
}
