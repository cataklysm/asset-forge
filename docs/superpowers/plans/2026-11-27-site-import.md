# Site Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a gallery behind a login with three XPath expressions per site profile and hand the
found file URLs to the existing URL import.

**Architecture:** Contracts and core ports first (Task 0). Then three parallel lanes with disjoint
files: the download path (A), the crawl logic and robots rules as pure core code behind ports (B),
the renderer (D). Last the Electron side (C), which implements the ports and wires everything.
No migration, no new dependency.

**Tech Stack:** TypeScript, Zod 4, Vitest (jsdom for the renderer), Electron main (`session`,
`BrowserWindow`, `webRequest`, `cookies`), Node `http`/`https` in the existing downloader.

**Spec:** `docs/superpowers/specs/2026-11-27-site-import-design.md` — binding; read it first.

## Global Constraints

- Everything in the repository is English. No attribution lines in commits. Commit, do not push.
- Cookies never appear in IPC, a job payload, the database, a log line or an error. URLs are never
  logged. Messages that reach the renderer are fixed texts without cause, path, URL or credential.
- Cookies and the session user agent go only to a URL that `belongsToSite`; every other request
  keeps `AssetForge/<version>` and no cookie. No `Referer` anywhere.
- No setting, environment variable or flag weakens `isPublicAddress`.
- The user agent of a site session is the Electron default; nothing is removed from or added to it.
- Tests never touch the network beyond servers started in-process on `127.0.0.1` through the
  existing test seams (`allowAddress`, `lookup`). Never launch the app, never open a real browser
  window in a test unless it is hidden and loads only an in-process server, never touch Docker,
  never call host port 11434 or a real site.
- Renderer: labels in `labels.ts`, button classes from `ui.ts`, no colour literals, no explanatory
  text in the layout (tooltips through `title`).
- Test-first. Single test: `pnpm --filter @assetforge/<package> test <file>` (no `--`). Before the
  last commit of a lane: `pnpm typecheck` and the tests of every package the lane touched.
- A lane touches only its own files. A needed change outside them is reported, not made.
- The untracked `gallery-import-konzept.md` in the repository root is never touched or committed.

## Review Focus

- A redirect from the site to another host and back: the cookie is decided per hop from that hop's
  URL alone; the hop off the site carries none.
- `belongsToSite('https://evilexample.com', 'example.com')` is false; `sub.example.com` is true;
  a URL with user info, another scheme or a trailing-dot host is false.
- A pagination that links to itself or in a cycle, and a gallery whose every page lists the same
  thumbnails: the crawl ends, visits each page once and answers each file once.
- A page that never matches `thumbnails` (expired login): the crawl answers zero files and a page
  failure, never hangs past the page deadline, and the hidden window is destroyed, also on cancel
  and on a thrown error.
- A `crawlId` used after the profile was saved, deleted or another crawl ran: `invalid_operation`,
  nothing queued.

---

### Task 0: Contracts and ports (one agent, on the branch, before the lanes)

**Files:** create `packages/contracts/src/site-import.ts` (+ export in `index.ts`); modify
`packages/contracts/src/jobs.ts`, `ipc.ts`; `packages/core/src/ports.ts`; every exhaustive map over
job error codes or job results (renderer `labels.ts` included); tests beside each.

**Produces (exact names):**

```ts
// contracts/site-import.ts
export const MAX_SITE_PROFILES = 50;
export const SITE_XPATH_MAX = 1000;
export const SITE_URL_CONTAINS_MAX = 200;
export const SITE_MAX_PAGES = { min: 1, max: 200, default: 20 };
export const SITE_MAX_FILES = { min: 1, max: 5000, default: 1000 };
export const SiteFilterSchema;      // { kinds: FileKind[] (1..5, distinct), minBytes: int 0..524288000 }
export const SiteProfileSchema;     // { id, name, site, thumbnails, pagination, file, kinds, minBytes, urlContains, maxPages, maxFiles }
export const SaveSiteProfileSchema; // profile fields without `site`; `id` optional; `url` required when `id` is absent
export const SiteCrawlResultSchema; // { crawlId, files, pages, duplicates, filtered, disallowed, invalid, pageFailures, truncated: 'pages'|'files'|null, cancelled }
export const SiteCrawlProgressSchema; // { pages, files, cancelling }
/** Lower-case host without a leading `www.`; throws on anything `normalizeSourceUrl` would refuse is NOT done here: returns null for a non-http(s) URL, user info or an empty host. */
export function siteOf(url: string): string | null;
export function belongsToSite(url: string, site: string): boolean;
```

- `FileDownloadPayloadSchema` becomes a union of v1 (unchanged) and
  `{ v: 2, url, target, skipDuplicates, siteProfileId: uuid, filter: SiteFilter }`;
  `downloadJobFields` reads both. `JobResultSchema` gains `'filtered'`. `JobErrorCodeSchema` gains
  `download_profile_missing` (message `The site profile of this download no longer exists`, not
  retryable, no pause).
- IPC contract entries: `sites:list` `{}` → `{ profiles }`; `sites:save` → profile; `sites:delete`
  `{ id }`; `sites:openLogin` `{ profileId, url?: string }` → `{}`; `sites:crawl`
  `{ profileId, url }` → crawl result; `sites:crawlProgress` → progress | null; `sites:cancelCrawl`
  → `{ cancelling }`; `sites:import` `{ crawlId, target: FileTarget | null }` → `UrlImportResult`.
- `core/ports.ts`:

```ts
export interface RemoteRequestHeaders { cookie?: string; userAgent?: string }
export interface RemoteOpenOptions { headersFor?: (url: string) => Promise<RemoteRequestHeaders | null> }
export interface RemoteFileSource { open(url: string, signal: AbortSignal, options?: RemoteOpenOptions): Promise<RemoteFile> }
export interface SiteAccess {
  has(profileId: string): Promise<boolean>;
  /** Null unless the URL belongs to the profile's site. */
  headersFor(profileId: string, url: string): Promise<RemoteRequestHeaders | null>;
}
export type PageLoadResult =
  | { ok: true; results: Record<string, string[]> }   // absolute or relative strings as found, per query name
  | { ok: false; reason: 'timeout' | 'left_site' | 'failed' }
  | { ok: false; reason: 'invalid_xpath'; query: string };
export interface PageLoader {
  /** Loads `url`, waits until the query named `waitFor` matches, then answers every query. */
  load(url: string, r: { queries: Record<string, string>; waitFor: string; signal: AbortSignal }): Promise<PageLoadResult>;
}
```

- [ ] Failing tests: `belongsToSite`/`siteOf` cases of the Review Focus; both payload versions parse
  and `downloadJobFields` answers host and URL for v2; profile schema bounds from the spec's table.
- [ ] Implement, `pnpm typecheck`, `pnpm test`, commit `Add the site import contracts and ports`.

### Task A: Download path (spec "Download")

**Files:** `packages/storage/src/url-source.ts`, `packages/core/src/download-handler.ts`,
`url-import.ts`, `packages/persistence/src/job-repository.ts` only if a reader needs it; tests
beside each.

**Produces:** `FileDownloadHandlerDeps.sites?: SiteAccess`;
`enqueueUrlImport(s, r)` with optional `r.site: { profileId: string; filter: SiteFilter }` (writes
payload v2; without it v1 as today).

- [ ] Failing tests (storage): `headersFor` is called once per hop with that hop's URL; a hop
  answering `{ cookie, userAgent }` sends exactly those two (`Cookie`, replaced `User-Agent`); a hop
  answering null sends no `Cookie` and the configured agent; a `cookie` or `userAgent` holding a
  control character is not sent; a rejecting `headersFor` fails the open as `unreachable` without a
  cause; without options every existing test stays green.
- [ ] Failing tests (core handler): a v2 job whose profile `has` answers false fails
  `download_profile_missing`; a v2 job passes `headersFor` bound to its profile; an announced length
  below `minBytes` and a final name whose kind is not in `kinds` end succeeded with result
  `filtered`, `job.file_id` null, no file row, stream destroyed; an unknown length below `minBytes`
  is discarded after staging with the same outcome; a v1 job never asks `sites`.
- [ ] Implement, run storage, core, persistence tests, typecheck, commit
  `Send a site profile's cookies with its downloads and filter by kind and size`.

### Task B: Robots rules and the crawl (spec "The crawl")

**Files:** create `packages/core/src/robots.ts`, `site-crawl.ts` (+ exports); tests beside them.

**Produces:**

```ts
export function parseRobots(text: string): RobotsRules;
/** Longest match wins, Allow on a tie; group for `AssetForge` (case-insensitive), else `*`; `*` and `$` in paths. */
export function robotsAllows(rules: RobotsRules, url: string): boolean;
export type RobotsAnswer = { kind: 'rules'; rules: RobotsRules } | { kind: 'none' } | { kind: 'unavailable' };
/** Reads `<origin>/robots.txt` through `remote` without options, at most 512 KiB; 404/410 → none; else unavailable. */
export function createRobotsReader(remote: RemoteFileSource): (origin: string, signal: AbortSignal) => Promise<RobotsAnswer>;
export interface SiteCrawlDeps {
  pages: PageLoader;
  robots: (origin: string, signal: AbortSignal) => Promise<RobotsAnswer>;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}
export const PAGE_GAP_MS = 1000;
/** Throws ValidationError for an invalid expression and InvalidOperationError('robots_unavailable' message) per spec. */
export function crawlSite(deps: SiteCrawlDeps, r: {
  profile: SiteProfile; url: string; signal: AbortSignal;
  onProgress?: (p: { pages: number; files: number }) => void;
}): Promise<Omit<SiteCrawlResult, 'crawlId'>>;
```

The fixed messages: `The thumbnail expression is not valid XPath`, `The pagination expression is not
valid XPath`, `The file expression is not valid XPath`, `This address does not belong to the
profile's site`, `The site's robots.txt could not be read`.

- [ ] Failing tests for robots: groups, longest match, wildcards, empty Disallow, a file without a
  matching group, garbage input allows everything.
- [ ] Failing tests for the crawl with a scripted `PageLoader`: each numbered step of the spec; the
  Review Focus loops; `maxPages` and `maxFiles` set `truncated`; robots per origin fetched once;
  an unavailable robots of another origin drops only its URLs; `urlContains` and the kind rule
  (`download.php?id=7` passes, `.pdf` is filtered with kinds image+video); a cancel answers what was
  found with `cancelled: true`; `wait(PAGE_GAP_MS)` between two loads and none before the first.
- [ ] Implement, run core tests, typecheck, commit `Add robots rules and the site crawl`.

### Task D: Renderer (spec "Renderer")

**Files:** create `apps/desktop/src/renderer/src/components/SiteImportDialog.tsx` and a state
module beside it; modify `labels.ts`, `InboxScreen`, the asset screen, `JobsScreen.tsx` (`filtered`
shown like `already_present`, with its own label `Filtered`), preload/API typing if channels are
listed there; tests in `apps/desktop/test/renderer/`.

- [ ] Failing tests: the profile form saves and reloads; `Import` is disabled until a test of the
  unchanged profile and URL answered at least one file and again after any field or the URL
  changes; `Test` shows the counts and the list; progress with `Cancel` while a crawl runs; `Log in`
  calls `sites:openLogin`; `sites:import` is called with the crawl id and the screen's target
  (inbox: null); error messages from the channels are shown as given; a `filtered` job row.
- [ ] Implement, run the renderer tests, typecheck, commit `Add the site import dialog`.

### Task C: Electron side (after A and B are integrated)

**Files:** create `apps/desktop/src/main/site-profile-store.ts`, `site-sessions.ts`,
`site-handlers.ts`; modify `composition.ts`, `ipc.ts`, `index.ts`; tests in `apps/desktop/test/`.

- `site-profile-store.ts`: `userData/site-profiles.json`, `writeAtomic`, entry-by-entry read after
  the pattern of `provider-store.ts`; the name and count rules; `site` fixed after creation.
- `site-sessions.ts`: `session.fromPartition('persist:site-<id>')` hardened once per session
  (permission request and check handlers deny, `will-download` cancels, request filter per the
  spec with a resolver seam for tests); the login window; a `PageLoader` on a hidden window
  (`show: false`, `backgroundThrottling: false`, navigation guard, 250 ms poll up to 10 s, 30 s per
  page, `executeJavaScriptInIsolatedWorld`, window destroyed in `finally`); `SiteAccess` from
  `cookies.get({ url })` and `session.getUserAgent()`; `clearStorageData` on delete.
- `site-handlers.ts`: the channels; one crawl at a time (`busy`), progress, cancel, the kept answer
  keyed by a fresh `crawlId`, dropped on save/delete of the profile; `sites:import` through
  `enqueueUrlImport` with `site`, then the asset source (best effort), then the scheduler wake.

- [ ] Failing tests: store rules; `SiteAccess.headersFor` answers null off the site and for an
  unknown profile; the request filter refuses a host resolving to a private address and a
  non-http scheme; the handlers' busy, stale `crawlId`, delete refusals and source adding, with the
  sessions module behind an interface so no window opens in these tests.
- [ ] One acceptance test with a real hidden window against an in-process gallery server (two
  pages, detail pages, a cookie-gated file) if it runs under the test Electron; otherwise state in
  the report that it does not and why.
- [ ] Implement, run desktop tests, typecheck, commit in up to three commits.

### Task E: Close out (controller)

- [ ] Integrate, whole-branch review, fix wave, `pnpm typecheck`, `pnpm test`.
- [ ] `docs/backlog.md` (section "Site import": DNS rebinding gap of the page window, popup logins,
  no Referer, no endless scrolling, page of origin not kept, anything found and left), local
  `CLAUDE.md`, memory; merge into `main`, push, delete the branch.
