# Site import: galleries behind a login

## Intent

The owner buys content on sites that show it as a gallery behind a login. Today every file has to be
saved by hand. The site import reads such a gallery with three XPath expressions the owner writes
once per site, shows which file URLs it found, and hands them to the existing URL import.

It is a front stage of the URL import, not a scraping tool: it reads pages the owner is logged in
to, on one site per profile, and everything after the URL list is the download path that exists.

## Goals

- One profile per site: where the thumbnails are, where the pagination is, where the file is on a
  detail page, and which files are wanted.
- The owner logs in once per profile in a window of the app; pages and files of that site are then
  fetched as that login.
- A test shows the file URLs that would be downloaded without downloading anything.
- Files arrive like any URL import: one job per file, host limits, duplicate detection, origin kept.
- Started from an asset, the gallery URL becomes a source of that asset.

## Non-goals

- Endless scrolling, "load more" buttons, or anything else that needs interaction with the page.
- Login cookies for any host other than the profile's site (no CDN coverage). A file on another host
  is fetched without cookies, as the URL import does today.
- A `Referer` or other per-site headers, proxies, streamed video (HLS/DASH), scheduled runs.
- Remembering the page a file was found on (the file URL is kept as its origin, as today).

## Anti-goals

- Nothing that gets around a block: no captcha solving, no disguised browser identity, no retry
  tricks against bot protection. A site that refuses automated reading gives no result.
- `robots.txt` is obeyed. A disallowed page is not loaded and a disallowed file is not queued.
- No setting weakens the public-address rule, for pages or for files.
- Cookies never appear in IPC, a job payload, the database or a log line, and never leave the
  profile's site.

## Approaches

- **A. Everything through a browser session per profile** (pages and files). What the owner sees is
  what is fetched, also on other hosts, but the download path would exist twice.
- **B. Login window for the cookies only, pages fetched without a browser.** Smallest, but a gallery
  built by JavaScript stays empty; ruled out by the owner's sites.
- **C. Pages in a browser window, files through the existing downloader with the site's cookies.**
  Chosen by the owner: nothing is built twice, and the downloader keeps every limit it has. The
  price, accepted: files on another host than the site get no cookies.

## Design

### Profiles

App level, in `userData/site-profiles.json` (`{ v: 1, profiles }`, written through `writeAtomic`,
read entry by entry like the provider settings). At most 50 profiles. A profile:

| Field | Rule |
| --- | --- |
| `id` | UUID |
| `name` | 1–60, unique regardless of case |
| `site` | host taken from the URL typed at creation, lower case, a leading `www.` dropped; a single label is refused; fixed afterwards |
| `thumbnails` | XPath, 1–1000 characters; selects the gallery's links |
| `pagination` | XPath, 0–1000; empty means one page |
| `file` | XPath, 0–1000; empty means a thumbnail link is the file itself |
| `kinds` | subset of `image`, `video`, `model`, `document`, `other`; at least one; default `image`, `video` |
| `minBytes` | 0–`MAX_DOWNLOAD_BYTES`, default 0 |
| `urlContains` | 0–200 characters; when set, a file URL must contain it (case-insensitive) |
| `maxPages` | 1–200, default 20 |
| `maxFiles` | 1–5000, default 1000 |

A URL **belongs to the site** when its scheme is `https` (or `http`) and its host equals `site` or
ends with `.` + `site`. This one rule decides where pages may be read and where cookies go.

An XPath result is turned into URLs like this: an element with `href` gives its `href`, otherwise its
`src`; an attribute or text node gives its value; anything else is ignored. Each value is resolved
against the document's base URL (when it belongs to the site, otherwise the page URL) and must pass `normalizeDownloadUrl`; what fails is dropped and counted.

### Browser sessions

One Electron session per profile, partition `persist:site-<id>`, so the login survives a restart.
Chromium keeps the cookies in its own store under `userData`. Deleting a profile clears the
partition's storage.

Both windows of a session: sandbox, context isolation, no preload, no Node integration, every
permission request denied, every download cancelled, `setWindowOpenHandler` denies and loads the
target in the same window instead, audio muted. The user agent is the Electron default (it names Chromium, Electron and the
product token `AssetForge/<version>`); nothing is removed from it to look like another browser. A
login that needs a popup talking to its opener does not work; that is a known limit. Neither window
has DevTools, a menu or dialogs. Closing the main window ends a running crawl and closes the login
window.

A request filter on the session (`webRequest.onBeforeRequest`) lets through only `http`/`https`
(plus `data:` and `blob:` sub-resources) and resolves every new host once: a host with any address
that fails `isPublicAddress` is refused, for navigations and sub-resources alike. Unlike the
downloader the socket is not pinned to the vetted address; that gap (DNS rebinding) is accepted for
pages and stated in the backlog. Files never go through this path.

- **Login window** (`sites:openLogin { profileId }`): visible, titled `<profile name> – <current
  host>`, opens `https://<site>/` or the URL given. The owner may navigate anywhere public (a login
  can pass through another host). One at a time; closing it ends the login. The app never reads or
  fills the form.
- **Page window**: hidden, one per crawl, navigations only to URLs that belong to the site (a
  redirect elsewhere ends that page as `left the site`).

### The crawl

`sites:crawl { profileId, url }` runs in the main process, one at a time (`invalid_operation`, `A site import test is already
running`), in memory, with
progress (`sites:crawlProgress` → `{ pages, files, cancelling } | null`) and `sites:cancelCrawl`,
after the pattern of the import progress. `url` must belong to the profile's site.

1. `robots.txt` is read per origin (scheme and host), on the first URL of that origin the crawl
   wants to load or queue, and cached for the crawl: pages, detail pages and file URLs, also file
   URLs on a host outside the site. It is fetched through the downloader without cookies, with the
   downloader's own user agent `AssetForge/<version>` (at most 512 KiB, redirects followed as the
   downloader does), and evaluated for the product token `AssetForge`, then `*`. 404 or 410:
   everything allowed. Any other failure: nothing of that origin is allowed (counted as
   `disallowed`); when it is the origin of the gallery URL the crawl answers `invalid_operation` (`The site's
   robots.txt could not be read`).
2. Pages are loaded one after another with at least 1 s between two loads. A page counts as loaded
   when `thumbnails` matches at least one node, checked every 250 ms after `did-finish-load` for at
   most 10 s; the whole page has 30 s. XPath runs in an isolated world
   (`executeJavaScriptInIsolatedWorld`); only strings come back and are validated in main.
3. On each gallery page: collect thumbnail URLs, then pagination URLs. Pagination URLs must belong to
   the site and pass robots; pages already seen are skipped; the crawl stops queuing pages at
   `maxPages`.
4. With an empty `file` expression the thumbnail URLs are the file URLs. Otherwise each thumbnail
   URL that belongs to the site and passes robots is loaded as a detail page and `file` gives the
   file URLs (loaded when `file` matches; a detail page counts against no limit but each distinct
   one is loaded once).
5. File URLs are made unique by their normalised form, filtered by `urlContains` and by kind (kind
   from the URL path's extension, but only when the existing name rule maps that extension to
   `image`, `video`, `model` or `document`; any other URL, such as `download.php?id=7`, passes and
   is decided at download), checked against robots, and cut at `maxFiles`.

Answer: `{ crawlId, files: string[], pages, duplicates, filtered, disallowed, invalid, pageFailures,
truncated: 'pages' | 'files' | null, cancelled }`. A cancel answers what was found so far. An invalid
expression answers `validation_failed` with `The thumbnail expression is not valid XPath` (or
`pagination`, `file`). The crawl cannot tell an expired login from an empty gallery; zero files is
shown as such and the owner logs in again.

The main process keeps the answer of the last crawl (its id, profile, filters and file URLs) in
memory until the next crawl, a change or deletion of the profile, or the app's end.

### Download

`sites:import { crawlId, target }` queues the kept answer of that crawl through `enqueueUrlImport`
and answers its `UrlImportResult`; an unknown or replaced `crawlId` answers `invalid_operation`
(`Run the test again`). The renderer never sends a URL to be fetched with cookies, so only what the
crawl found and robots allowed is queued. `files:importUrls` is unchanged. The job payload v2 adds
`siteProfileId` and `filter { kinds, minBytes }`; v1 payloads run unchanged, and every reader of the
payload (Jobs screen fields, host lanes, host pause) reads both.

- New core port `SiteAccess { has(profileId), headersFor(profileId, url) }`, implemented in the
  main process from the profile's session (`cookies.get({ url })`). `headersFor` answers `null`
  unless the URL belongs to the profile's site. An unknown profile fails the job with `download_profile_missing`
  (`The site profile of this download no longer exists`, not retried).
- `RemoteFileSource.open` takes an optional `headersFor(url)`; the adapter calls it for every hop, so
  a redirect off the site carries no cookie. For a URL that belongs to the site the callback also
  answers the session's user agent, so the site sees one client for pages and files; every other
  request keeps `AssetForge/<version>`. Everything else in `url-source.ts` is unchanged: pinned
  public address, limits, no `Referer`.
- Filter at download: an announced length below `minBytes`, or a final file name whose kind is not in
  `kinds`, ends the job as succeeded with the result `filtered` before anything is stored; an unknown
  length is checked after staging and the staged file discarded. `filtered` joins the job results,
  the job keeps no file id, and it is shown on the Jobs screen like `already_present`.
- With a target asset, `sites:import` adds the crawl's gallery URL as an asset source through the
  existing rule. An existing source or a full list never fails the import.

A profile cannot be deleted while it has active download jobs in the open workspace (`This profile
still has active downloads`), and neither saved nor deleted while its login window is open or a
crawl of it runs (`This profile is in use`).

### Channels

`sites:list`, `sites:save`, `sites:delete`, `sites:openLogin`, `sites:crawl`, `sites:crawlProgress`,
`sites:cancelCrawl`, `sites:import` (needs a workspace) — all without a workspace except that the renderer only offers them where an
import is possible. No channel carries a cookie.

### Renderer

`SiteImportDialog`, opened by `Import from site` beside `Import URLs` in the inbox and on the asset
screen. Left: profile select with `New`, the profile's fields, `Save`, `Delete`, `Log in`. Right: the
gallery URL, `Test`, progress with `Cancel`, then the counts and the list of found file URLs, and
`Import` (disabled until a test of the unchanged profile and URL has answered at least one file).
After the import the usual URL import result line. Explanations only as tooltips; buttons from `ui.ts`.

## Left to the builder

File and function names beyond those given, the robots parser (own small module, no dependency
unless one is clearly better), the shape of the progress polling, test doubles for the page window
(the crawl logic takes a `PageLoader` port so it is tested without Electron; the mock provider
serves a small gallery site for one acceptance test with a real hidden window if that runs under
the test Electron, otherwise the port double is the limit and the rest is a manual check).

## Manual checks (owner)

Login survives a restart; a real gallery with pagination and detail pages; a file behind the login
downloads; a file on another host arrives or fails cleanly; a site with a `robots.txt` disallow
gives no result.
