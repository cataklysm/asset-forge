import { SiteCrawlResultSchema, type SiteCrawlResult } from '@assetforge/contracts';
import { normalizeDownloadUrl } from './download-url.js';

/** Durable discovery state. In-flight details are deliberately retried after interruption. */
export interface SiteCrawlCheckpoint {
  answer: Omit<SiteCrawlResult, 'crawlId'>;
  pendingPages: string[];
  seenPages: string[];
  redirectedPages: string[];
  refusedPages: string[];
  completedDetails: string[];
  seenFiles: string[];
  offSiteLinks: string[];
  loadedGalleries: string[];
  sourcePages: Record<string, string>;
}

/** Mutable discovery state and the serialized writes of its detached checkpoints. */
export class SiteCrawlState {
  readonly answer: Omit<SiteCrawlResult, 'crawlId'> = {
    files: [],
    pages: 0,
    duplicates: 0,
    filtered: 0,
    disallowed: 0,
    invalid: 0,
    offSite: 0,
    pageFailures: 0,
    truncated: null,
    cancelled: false,
    problems: [],
    problemsDropped: 0,
  };
  readonly problemKeys = new Set<string>();
  readonly seenFiles = new Set<string>();
  readonly seenPages: Set<string>;
  /** Redirected gallery targets do not consume another maxPages slot. */
  readonly redirectedPages = new Set<string>();
  /** Robots-refused pagination targets do not consume a maxPages slot. */
  readonly refusedPages = new Set<string>();
  readonly seenDetails = new Set<string>();
  readonly completedDetails = new Set<string>();
  readonly loadedGalleries = new Set<string>();
  readonly sourcePages: Record<string, string> = {};
  readonly offSiteLinks = new Set<string>();
  readonly queue: string[];
  currentGallery: string | null = null;
  private checkpointTurn = Promise.resolve();

  /**
   * Prepares a new crawl or restores validated state from an interrupted one.
   *
   * @param galleryUrl the initial gallery
   * @param checkpoint the validated saved state
   * @param onCheckpoint persists a detached snapshot
   */
  constructor(
    galleryUrl: string,
    checkpoint: SiteCrawlCheckpoint | undefined,
    private readonly onCheckpoint: ((checkpoint: SiteCrawlCheckpoint) => void | Promise<void>) | undefined,
  ) {
    this.seenPages = new Set([galleryUrl]);
    this.queue = [galleryUrl];
    if (checkpoint !== undefined) this.restore(checkpoint);
  }

  /** Saves in callback order, so late workers cannot overwrite newer progress. */
  async save(): Promise<void> {
    if (this.onCheckpoint === undefined) return;
    const snapshot: SiteCrawlCheckpoint = {
      answer: structuredClone(this.answer),
      pendingPages: [...(this.currentGallery === null ? [] : [this.currentGallery]), ...this.queue],
      seenPages: [...this.seenPages],
      redirectedPages: [...this.redirectedPages],
      refusedPages: [...this.refusedPages],
      completedDetails: [...this.completedDetails],
      seenFiles: [...this.seenFiles],
      offSiteLinks: [...this.offSiteLinks],
      loadedGalleries: [...this.loadedGalleries],
      sourcePages: { ...this.sourcePages },
    };
    const callback = this.onCheckpoint;
    this.checkpointTurn = this.checkpointTurn.then(() => callback(snapshot));
    await this.checkpointTurn;
  }

  /**
   * Restores completed work; the pending gallery is reread to rediscover its unfinished details.
   *
   * @param checkpoint the validated durable state
   */
  private restore(checkpoint: SiteCrawlCheckpoint): void {
    Object.assign(this.answer, structuredClone(checkpoint.answer), { cancelled: false });
    this.queue.splice(0, this.queue.length, ...checkpoint.pendingPages);
    for (const [set, values] of [
      [this.seenPages, checkpoint.seenPages],
      [this.redirectedPages, checkpoint.redirectedPages],
      [this.refusedPages, checkpoint.refusedPages],
      [this.completedDetails, checkpoint.completedDetails],
      [this.seenFiles, checkpoint.seenFiles],
      [this.offSiteLinks, checkpoint.offSiteLinks],
      [this.loadedGalleries, checkpoint.loadedGalleries],
    ] as const) {
      set.clear();
      for (const value of values) set.add(value);
    }
    Object.assign(this.sourcePages, checkpoint.sourcePages);
    for (const problem of this.answer.problems) {
      this.problemKeys.add(`${problem.stage}\n${problem.reason}\n${problem.url}\n${problem.detail ?? ''}`);
    }
  }
}

const LISTS = [
  'pendingPages',
  'seenPages',
  'redirectedPages',
  'refusedPages',
  'completedDetails',
  'seenFiles',
  'offSiteLinks',
  'loadedGalleries',
] as const;
const CHECKPOINT_URL_LIMIT = 100_000;

/**
 * Validates a checkpoint read from persistence before it can control browser navigation.
 *
 * @param value the stored JSON value
 * @returns the validated state, or null when it is malformed
 */
export function parseSiteCrawlCheckpoint(value: unknown): SiteCrawlCheckpoint | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const answer = SiteCrawlResultSchema.omit({ crawlId: true }).safeParse(data['answer']);
  if (!answer.success) return null;
  const lists = {} as Pick<SiteCrawlCheckpoint, (typeof LISTS)[number]>;
  try {
    for (const key of LISTS) {
      const list = data[key];
      if (!Array.isArray(list) || list.length > CHECKPOINT_URL_LIMIT) return null;
      lists[key] = list.map((url: unknown) => {
        if (typeof url !== 'string' || url.length > 10_000) throw new Error('invalid_checkpoint');
        return normalizeDownloadUrl(url);
      });
    }
    const sources = data['sourcePages'];
    if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) return null;
    const entries = Object.entries(sources);
    if (entries.length > CHECKPOINT_URL_LIMIT) return null;
    const sourcePages: Record<string, string> = {};
    for (const [file, page] of entries) {
      if (typeof page !== 'string' || page.length > 10_000 || file.length > 10_000) return null;
      sourcePages[normalizeDownloadUrl(file)] = normalizeDownloadUrl(page);
    }
    return { answer: answer.data, ...lists, sourcePages };
  } catch {
    return null;
  }
}
