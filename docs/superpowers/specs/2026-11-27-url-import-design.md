# URL import (gallery import, first piece) — design

Date: 2026-11-27. Status: draft for approval. Concept it grew from: `gallery-import-konzept.md` (repository root, German).

## 1. Intent

The owner wants to collect assets from the web while the application is still being developed. The concept describes
a generic import service with source adapters, a persistent queue, duplicate detection and stored origin. This design
builds the part of it that every later source needs: **a list of file URLs is downloaded into the workspace through the
existing job queue, each file keeps the address it came from, and content that is already there is not stored twice.**

The first source is a list of URLs the owner pastes. Site adapters (a gallery page that is turned into such a list) come
later and add only a discovery step in front of the same download jobs.

## 2. Goals

1. Paste a list of URLs in the inbox or on an asset; every URL becomes one persistent download job.
2. Downloads survive closing the application: waiting jobs continue on the next start, interrupted ones start again.
3. Every downloaded file keeps its URL permanently and shows it in the file detail dialog.
4. A URL that was already downloaded is not fetched again. Content that already exists (same SHA-256) is, by default,
   not stored again; the existing file takes the new URL as a further origin.
5. A host that throttles, blocks or is down slows or stops only its own downloads, visibly, and never the others.
6. The download cannot reach internal services and cannot fill the disk unnoticed.

## 3. Non-goals

- Site adapters, HTML parsing, a browser worker (Playwright), discovery of galleries or albums.
- Perceptual hashes, similar-image detection.
- Automatic tagging or captioning after a download (the owner runs `Analyse all` on the inbox).
- A view that groups the jobs of one import, import history, scheduled or repeated imports.
- Cookies, logins, API keys, request headers per site, proxies.
- Unpacking a downloaded ZIP, license or author fields, album metadata.
- Editing or removing an origin, origin in the search index, a filter "downloaded from".
- Remembering URLs of purged files (a purged file's URL can be downloaded again).

## 4. Anti-goals

These would make the feature a failure even if it worked:

- **No circumvention.** The downloader identifies itself honestly (`AssetForge/<app version>`), sends no cookies, no
  `Referer`, no credentials and never imitates a browser. A host that answers 401/403/429 is respected: throttling
  slows the host down, repeated refusals stop it. There is no setting to change that.
- **No reach into internal networks**, neither directly nor through a redirect or a DNS answer (ReadMe §16).
- **No credential or URL in logs.** URLs may carry signed tokens in their query; they are stored where they are the
  point (origin, job payload) and nowhere else.
- No paid or irreversible work is started; a download is free and repeatable, so interrupted jobs are simply requeued.

## 5. Constraints

- Existing stack only: the job queue in `packages/jobs`, the import steps in `packages/core/src/import-file.ts`, SQLite.
  No Redis, no separate worker process. Consequence, accepted by the owner: downloads run only while the application is
  open with the workspace open.
- `core` and `contracts` stay free of Electron and of a concrete HTTP client; the network sits behind a port.
- The download runs in the main process on Node streams with backpressure (no Chromium session, so no cookies and no
  system proxy); nothing large crosses IPC.
- UI rules: no explanatory text in the layout (tooltips only), button constants from `ui.ts`, labels in `labels.ts`,
  tokens only.
- Tests never touch the internet and never port 11434; they use an in-process HTTP server.

## 6. Approaches

**A — one job per URL in the existing queue (chosen).** `files:importUrls` validates the lines and inserts one job per
URL. The job handler streams the response into the existing import steps and stores the origin. Lane = host, so limits,
retry timing and the pause gate work per host. The Jobs screen, cancel, retry and recovery come along unchanged. A later
gallery adapter is a discovery job that inserts the same jobs. Cost: no grouped view per import; the queue needs a
total limit and a per-lane hold it does not have yet.

**B — an import record with items (`url_import`, `url_import_item`) and one runner job per import.** Gives a progress
view per import and one place for settings. Costs a second queue inside the queue: its own concurrency, retry, pause
and recovery logic, duplicated from the scheduler, and a new screen. Rejected: most of the work would be re-implementing
what exists.

**C — download in the foreground like `files:import`.** Smallest change, but nothing survives closing the dialog or the
application, there is no throttling per host and a list of a few hundred URLs blocks the workspace queue. Rejected: it
fails goals 2 and 5.

The owner chose A. A grouped view can be added later on top of A (a nullable batch id on the job) without changing it.

## 7. Design

### 7.1 Entry and request

- A button `Import from URLs` beside the file import in the inbox and on the asset screen (there with the role select
  the file import already uses; default as today).
- `UrlImportDialog`: a multi-line input (one URL per line, empty lines ignored), a checkbox `Skip duplicates` (default
  on; tooltip: identical content is not stored again), `Import` and `Cancel`. After the start the dialog shows the
  answer as counts — queued, already imported, already queued, not usable — lists the unusable lines and offers `Close`.
- Channel `files:importUrls`, needs an open workspace:
  request `{ urls: string[] (1–5000 lines, each at most 2000 characters), target?: FileTarget, skipDuplicates?: boolean }`
  (`skipDuplicates` defaults to `true`); response
  `{ queued: number, alreadyImported: number, alreadyQueued: number, invalid: { line: number, text: string }[] }`
  (`line` counts from 1 over the lines as sent, `text` cut to 200 characters). More than 5000 lines answers
  `invalid_request`; an unknown target asset answers `not_found` and queues nothing.
- The URL rule is the one of asset sources (`normalizeSourceUrl`: `http`/`https`, a host, no user name or password, at
  most 2000 characters) with one addition: the fragment is dropped, since it is never sent. The normalised `href` is the
  identity of a URL everywhere below. The same URL twice in one request counts once (the repeat is `alreadyQueued`).
- `alreadyImported`: a file row with this origin exists (also one in the trash — a file the owner threw away is not
  brought back by importing the list again; after a purge the URL is forgotten). No job is created.
- `alreadyQueued`: an active job for this URL exists (dedupe key `url:<href>`). No job is created.
- All jobs of one request are inserted in one transaction; then the scheduler is woken.

### 7.2 The job

- Type `file.download`, resource class `io`, `onInterrupted: 'requeue'`, lane = the URL's `host` (lower case, with a
  non-default port), stored in the existing lane column.
- Payload `{ v: 1, url, target: { assetId, role } | null, skipDuplicates }`.
- Limits: 2 downloads at a time per host (the `io` limit per lane, as today) and **4 in total** — a new optional total
  per resource class in the scheduler, because lanes are otherwise unbounded in number (ReadMe §15.3: 2–4 concurrent
  downloads). The total applies to the class, not to a job type.
- Run:
  1. If a file with this origin exists by now, succeed with the result `already_present` without any request.
  2. Open the URL through the port (§7.3). Derive the file name (§7.4) and refuse types the import refuses.
  3. Hand the stream to the import steps (pending row → staging → checksum → move → complete).
  4. With `skipDuplicates` and a complete file outside the trash with the same SHA-256: the staged bytes and the pending
     row are removed, the oldest such file gets the URL as a further origin (unless it already carries 50), and the job
     succeeds with the result `already_present` and that file. This needs a `skip` option in `importStream`, checked
     after the checksum and before the move; without the option the import behaves exactly as today.
  5. Otherwise the file is completed **together with its origin row in one transaction** — a complete file of a URL
     import always has its origin — and the job points at the new file.
  6. With a target, the file is moved into the asset with the role (best effort, as for generation results: when the
     asset is gone or the move fails the file stays in the inbox and the job still succeeds).
- The job records what it produced: `job.file_id` is set to the resulting or existing file and a new nullable column
  `job.result` holds `already_present` or null; `JobView` carries both (`result` as an enum with that one value).
- A cancel aborts the request and removes staging and the pending row through the existing failure path of the import
  steps. `jobs:retry` and `jobs:retryFailed` requeue download jobs like analysis jobs; `jobs:reroute` never touches them.
- Two downloads with identical content running at the same moment may both be stored (each checks before the other
  completes). Accepted; they are then marked as duplicates of each other as today.

### 7.3 The network port and its rules

Core port `RemoteFileSource`: `open(url, signal)` → `{ stream, finalUrl, contentType, contentLength, dispositionName }`
or a typed failure that maps to exactly one job error code. The adapter (Node `http`/`https`, in `packages/storage`
beside the ZIP reader) applies these rules; they are the security core of the feature:

- Schemes `http` and `https` only, any port. Method `GET`, headers `User-Agent: AssetForge/<version>`,
  `Accept: */*`, `Accept-Encoding: identity`; nothing else. A response with a content encoding is refused.
- **Address check before every connection:** the host is resolved once, **every** returned address must be public, and
  the connection is made to exactly the checked address (TLS still verifies the host name). Refused: loopback,
  private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), carrier NAT (100.64/10), 0/8, multicast,
  reserved and broadcast ranges, `::`, `::1`, unique local (fc00::/7), IPv4-mapped and NAT64/6to4 forms of any of these.
  An IP literal as host goes through the same check.
- **Redirects** (301, 302, 303, 307, 308) are followed by hand, at most 5, and each target passes the URL rule and the
  address check again. A redirect to another scheme, without a usable `Location` or beyond the limit is refused.
- **Limits:** 500 MiB per file — refused from `Content-Length` before the body, and cut off while streaming when the
  header is missing or wrong; 30 s until the response headers, 60 s without received data, 30 min in total.
- The address policy is a parameter of the adapter so tests can serve from an in-process server; the application wires
  the public-only policy and there is no setting, environment variable or flag to weaken it.

### 7.4 File name and type

- Name: the `Content-Disposition` file name when present, otherwise the last path segment of the final URL
  (percent-decoded), otherwise `download`; then through `sanitizeFileName`. When the name has no extension the
  application knows and the content type maps to one (JPEG, PNG, WebP, GIF, AVIF, TIFF, BMP, SVG, PDF, ZIP, GLB), that
  extension is appended.
- `text/html` and `application/xhtml+xml` are refused: the address is a web page, not a file. This is the usual mistake
  (a gallery page instead of an image address) and gets its own message.
- Everything else follows the import rules: programs, installers and shortcuts are refused by name
  (`isRefusedImportName`); a ZIP is stored as a file.

### 7.5 Failures, retry, throttling, pause

New job error codes with fixed messages (never a cause, a path or the URL):

| Code | When | Retried | Counts toward the host pause |
| --- | --- | --- | --- |
| `download_unreachable` | DNS failure, refused or lost connection, TLS failure, a timeout | yes | yes |
| `download_unavailable` | 5xx, 408 | yes | yes |
| `download_throttled` | 429, 503 | yes, see below | yes |
| `download_blocked` | 401, 403, 407, 451 | no | yes |
| `download_not_found` | 404, 410 | no | no |
| `download_rejected` | other 4xx, a refused redirect, a content encoding | no | no |
| `download_address_refused` | the address check failed (URL or redirect target) | no | no |
| `download_too_large` | over the size limit | no | no |
| `download_not_a_file` | an HTML page | no | no |
| `download_type_refused` | a type the import refuses | no | no |

- Retry as today: three runs with 5 s and 30 s between them.
- **Throttling:** a `download_throttled` failure carries a wait — `Retry-After` (seconds or a date) clamped to
  5 s – 15 min, 60 s without the header. The job waits that long, and so does every waiting job of the same host: the
  scheduler holds the lane until then (the waiting jobs get the same `run_after`, their run count unchanged). This is
  the one new scheduler behaviour besides the total limit; a job error may carry a wait, and no other handler uses it.
- **Pause:** three consecutive failures of a counting code on one host pause that host for the application session
  (the existing gate; a success or a non-counting failure resets the count). So a host that keeps answering 403 or 429
  is stopped after three, and the owner decides. The pause banner shows one line per paused host — the host and the
  reason — with `Resume`; no `Settings`, no `Move jobs`. `jobs:summary.paused` and `jobs:resume` are extended so a host
  lane can be listed and resumed.

### 7.6 Origin on the file

- Table `file_origin` (migration `0015`): `id`, `file_id` (cascade), `url`, `created_at`; unique on file and URL; an
  index on `url`. At most 50 per file. Purging a file removes its origins; trash and restore keep them.
- `files:origins { fileId }` → `{ id, url, createdAt }[]` (ordered by `createdAt`, then `id`), fetched by the file
  detail dialog, which shows them in the details column under `Source` through the `Link` component with a copy button.
- `files:openOrigin { fileId, originId }`: the main process reads the stored URL, applies the URL rule again and hands
  it to `HostActions.openExternal` — the renderer never passes a URL to be opened (as `assets:openSource`).
- The asset's own sources (`asset_source`) are untouched; a download into an asset does not add an asset source.

### 7.7 What the owner sees meanwhile

- Jobs screen: type `Download`; the Provider column shows the host; the file column shows the file name once there is a
  file and the URL (shortened, full in the tooltip) before; a succeeded job with `already_present` says so in its
  status. The provider filter stays a filter over provider entries.
- Inbox and asset file lists reload when a download job ends, through the signal that already refreshes lists after
  analysis jobs.
- The `Jobs` count in the navigation includes downloads, as any job.

### 7.8 Documentation

`ReadMe.md` §4.1 (URL import: what exists now), §15.2 (the job type, host lanes, the total limit, the lane hold, the
codes) and §16 (the address check) are brought in line at the end; leftovers go to `docs/backlog.md` under
"URL import".

## 8. Left to the builder

- File and function names not fixed above, the exact shape of the extended `paused` entries and of `jobs:resume`,
  how the scheduler stores the lane hold, and how the handler hands `file_id`/`result` to the job row.
- Label texts and tooltips (English, in `labels.ts`), the layout of the dialog and of the `Source` lines.
- The exact wording of the ten fixed messages.
- Where in the renderer the reload signal is taken from.

## 9. Calls made by the designer (not asked)

1. 2 per host, 4 in total; three consecutive 403/429/unreachable pause a host; a single 403 only fails its job.
2. 429/503 hold the whole host for `Retry-After` (5 s – 15 min, 60 s default) instead of pausing at once.
3. Size limit 500 MiB; timeouts 30 s / 60 s idle / 30 min.
4. A URL whose file is in the trash counts as already imported; a purged one does not.
5. Up to 5000 URLs per request; the fragment is not part of a URL's identity.
6. HTML answers are refused with their own message; a ZIP is stored unpacked-never.
7. Honest `User-Agent`, no cookies or `Referer`; hosts that refuse such clients simply fail.
8. With `Skip duplicates` the existing file is never moved: a duplicate downloaded "into an asset" leaves the existing
   file where it is and only adds the origin.
9. Origins are read-only in this version and are fetched per file, not carried on every list row.
