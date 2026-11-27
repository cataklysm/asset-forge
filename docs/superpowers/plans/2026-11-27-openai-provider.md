# OpenAI-compatible vision provider and request options — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third provider kind `openai` (vLLM and other OpenAI-compatible chat servers) for image analysis, and per-entry request options (temperature, thinking, maximum answer length, extra JSON parameters) on every analysis entry.

**Architecture:** The kind enum grows by `openai`; "can analyse" becomes a purpose (`vision` | `image`) derived from the kind. The transport of the Ollama adapter moves into a shared module used by a second adapter for `POST /chat/completions` and `GET /models`. Options are stored with the entry (settings file version 4) and handed to the adapter when it is built.

**Tech Stack:** TypeScript, Zod 4, Vitest (+ jsdom for the renderer), Electron main, React. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-27-openai-provider-design.md` — binding; where this plan and the spec differ, the spec wins.

## Global Constraints

- Everything in the repository is English. Commit messages carry no attribution or co-author lines. Implementers commit and never push.
- Tests never touch the internet, never call host port 11434 or any real provider, and never start, stop or remove Docker containers. HTTP tests start the mock provider in-process (`startMockProvider` from `docker/mock-provider/server.mjs`). The only key literals are `test-key-not-real` and `test-key-not-real-2`. Nobody launches the app.
- The untracked file `gallery-import-konzept.md` is the owner's: never touch, add or commit it.
- The API key is sent as a bearer token only to the entry's own base URL; it never appears in IPC, logs, jobs or the database. Logs carry the entry id, the error code and the HTTP status only. Messages forwarded to the renderer never carry a cause, a path, a URL or user text.
- `core` and `contracts` import no adapter and no Electron. No new dependency. No database migration.
- With the default options an `ollama` request body equals today's as parsed JSON: `{ model, stream: false, options: { temperature: 0 }, messages, [format] }` and no other key.
- Kinds: `'ollama' | 'openai' | 'venice'`. `purposeOf`: `ollama`, `openai` → `'vision'`; `venice` → `'image'`. A kind never changes.
- Options: `temperature` 0–2 (default 0); `thinking` `'default' | 'off' | 'on'` (default `'default'`); `maxTokens` integer 1–100 000 or null (default null); `extra` text of at most 4000 characters (default `''`).
- Reserved top-level keys in `extra`: `ollama`: `model`, `messages`, `stream`, `format`; `openai`: `model`, `messages`, `stream`, `response_format`, `n`, `tools`, `tool_choice`.
- Fixed messages: `The extra parameters are not a JSON object`, `The extra parameters must not set <key>` (`<key>` is one of the reserved names).
- Fingerprint provider ids: `OLLAMA_PROVIDER = 'ollama'`, `OPENAI_PROVIDER = 'openai'`.
- Renderer: no explanatory text in the layout (explanations only as `title` tooltips), buttons only through the constants in `apps/desktop/src/renderer/src/ui.ts`, labels in `labels.ts`, no colour literals (`test/theme.test.ts` guards it).
- Commands: `pnpm typecheck`, `pnpm test`, `pnpm --filter @assetforge/<package> test <file>` (no `--`). Every task ends with `pnpm typecheck` and the whole `pnpm test` green. Known unrelated flakes: `inbox.test.tsx > filters and scroll offset survive navigation`, `venice-image.test.ts > maps a refused connection to provider_unreachable`.

## Review Focus

1. A hand-edited settings file or a future bug puts a reserved key into the extra parameters → the adapter's own fields (`model`, `messages`, `stream`, the JSON format) still win in the request. (Task 2, Task 4)
2. vLLM model ids contain `/` and `:` (`Qwen/Qwen2.5-VL-7B-Instruct`) → listed, stored and sent verbatim. (Task 4)
3. A base URL typed with a trailing slash, or without `/v1` → the trailing slash is dropped, nothing is appended or guessed. (Task 4)
4. A thinking model spends the whole answer on reasoning: `content` is `null` or empty, only `reasoning_content` is filled → `invalid_response`, never a crash or an empty tag set. (Task 4)
5. The temperature or token field holds something that is not a number in range (empty, `0,5`, `3`) → Save is disabled; nothing is sent as `NaN` or `null` by accident. (Task 6)

---

### Task 1: Contracts — kind, purpose, options, extra-parameter rule

**Files:**
- Modify: `packages/contracts/src/provider-ref.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/jobs.ts` (comment on `PausedProviderSchema.kind` only), `packages/contracts/src/index.ts` if exports are listed there
- Modify (minimal, to keep the repository compiling): `apps/desktop/src/main/provider-store.ts`, test fixtures and fakes that build a `ProviderView`
- Test: `packages/contracts/test/provider-options.test.ts` (new), existing contracts tests

**Interfaces — Produces:**

```ts
// provider-ref.ts
export const ProviderKindSchema = z.enum(['ollama', 'openai', 'venice']);
export type ProviderPurpose = 'vision' | 'image';
export type VisionKind = 'ollama' | 'openai';
export function purposeOf(kind: ProviderKind): ProviderPurpose;
export function isVisionKind(kind: ProviderKind): kind is VisionKind;

// settings.ts
export const ThinkingSchema = z.enum(['default', 'off', 'on']);
export type Thinking = z.infer<typeof ThinkingSchema>;
export const PROVIDER_EXTRA_MAX = 4000;
export const ProviderOptionsSchema = z.object({
  temperature: z.number().min(0).max(2),
  thinking: ThinkingSchema,
  maxTokens: z.number().int().min(1).max(100_000).nullable(),
  extra: z.string().max(PROVIDER_EXTRA_MAX),
});
export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>;
export const DEFAULT_PROVIDER_OPTIONS: ProviderOptions; // { temperature: 0, thinking: 'default', maxTokens: null, extra: '' }
export const RESERVED_EXTRA_KEYS: Record<VisionKind, readonly string[]>;
export type ExtraParameters =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'not_json' | 'not_object' }
  | { ok: false; reason: 'reserved'; key: string };
export function parseExtraParameters(text: string, kind: VisionKind): ExtraParameters;
/** The fixed message of a refused text. */
export function extraParametersMessage(refusal: Extract<ExtraParameters, { ok: false }>): string;
/** What an adapter is built with: the fixed fields and the parsed extra object. */
export interface VisionRequestOptions { temperature: number; thinking: Thinking; maxTokens: number | null; extra: Record<string, unknown> }
// ProviderViewSchema gains: options: ProviderOptionsSchema.nullable()   (null for venice)
// SaveProviderSchema gains: options: ProviderOptionsSchema.optional()
```

`parseExtraParameters`: empty or whitespace-only text → `{ ok: true, value: {} }`; text that `JSON.parse` refuses → `not_json`; a parsed value that is not a plain object (array, null, scalar) → `not_object`; a top-level key in `RESERVED_EXTRA_KEYS[kind]` → `reserved` with the first such key in the order of the reserved list; nested occurrences are allowed.

- [ ] **Step 1: Failing tests** in `provider-options.test.ts`: `purposeOf` for the three kinds; `isVisionKind`; `ProviderOptionsSchema` accepts the defaults, refuses temperature `-0.1` and `2.1`, `maxTokens` `0`, `1.5`, `100001`, `extra` of 4001 characters, thinking `'auto'`; `parseExtraParameters('')` and `('  \n')` → `{}`; `'[1]'`, `'null'`, `'3'`, `'"x"'` → `not_object`; `'{'` → `not_json`; every reserved key per kind → `reserved` with that key; `{"format":1}` is fine for `openai` and `{"response_format":1}` is fine for `ollama`; `{"options":{"model":"x"}}` is fine; both messages word for word (`extraParametersMessage`); `ProviderViewSchema` accepts `options: null` and the defaults; `SaveProviderSchema` accepts a payload without `options`.
- [ ] **Step 2:** Run `pnpm --filter @assetforge/contracts test provider-options` — fails.
- [ ] **Step 3:** Implement. Update the doc comments that say "`ollama` entries analyse" to the purpose wording.
- [ ] **Step 4: Keep the repository compiling.** In `provider-store.ts` give `ProviderEntry` the field `options: ProviderOptions | null` and fill it in memory only: `DEFAULT_PROVIDER_OPTIONS` for vision kinds, `null` for `venice`, on every path that builds an entry (file read, upgrade, save, environment). Nothing about options is written to or read from the file yet, and `save` still treats every non-`venice` kind as it treats `ollama` today (Task 5 does the real work). Fix every fixture, fake and exhaustive `ProviderKind` switch that no longer compiles, with the smallest change. Do not change behaviour anywhere else.
- [ ] **Step 5:** `pnpm typecheck` and `pnpm test` green.
- [ ] **Step 6:** Commit `feat(contracts): provider kind openai, purposes and request options`.

---

### Task 2: Providers — shared transport and request options in the Ollama adapter

**Files:**
- Create: `packages/providers/src/json-request.ts`, `packages/providers/src/request-options.ts`
- Modify: `packages/providers/src/ollama-vision.ts`, `packages/providers/src/index.ts`
- Test: `packages/providers/test/request-options.test.ts` (new), `packages/providers/test/ollama-options.test.ts` (new); the existing `ollama-*.test.ts` stay unchanged and green

**Interfaces — Consumes:** `VisionRequestOptions`, `Thinking` (Task 1). **Produces:**

```ts
// json-request.ts — today's inner `request` of ollama-vision.ts with its helpers, behaviour unchanged
export interface JsonRequestOptions {
  baseUrl: string;                       // trailing slashes are dropped
  apiKey?: () => string | null;
  fetch?: typeof fetch;
  onFailure?: (code: JobErrorCode, status: number | null) => void;
}
export interface JsonRequest {
  path: string;                          // appended to the base URL, starts with '/'
  body?: unknown;                        // present → POST with JSON, absent → GET
  signal: AbortSignal;
  timeoutMs: number;
  silent?: boolean;                      // a failure is not reported through onFailure
}
export function createJsonRequester(o: JsonRequestOptions): <T>(r: JsonRequest, interpret: (body: unknown) => T) => Promise<T>;
/** Failed requests reject with a JobError; this one also carries the HTTP status for callers that branch on it. */
export function statusOf(error: unknown): number | null;

// request-options.ts
export const DEFAULT_REQUEST_OPTIONS: VisionRequestOptions; // { temperature: 0, thinking: 'default', maxTokens: null, extra: {} }
/** Fixed fields, then `extra` over them, then `own` over everything. Objects under `deepKeys` are merged one level deep, every other key is replaced. */
export function composeBody(fixed: Record<string, unknown>, extra: Record<string, unknown>, own: Record<string, unknown>, deepKeys: readonly string[]): Record<string, unknown>;
export function ollamaFixedFields(o: VisionRequestOptions): Record<string, unknown>;
// → { options: { temperature, [num_predict] }, [think: boolean] }
export function openAiFixedFields(o: VisionRequestOptions): Record<string, unknown>;
// → { temperature, [max_tokens], [chat_template_kwargs: { enable_thinking: boolean }] }

// ollama-vision.ts
export interface OllamaVisionOptions { /* as today */ requestOptions?: VisionRequestOptions }
```

`statusOf`: how the status travels is the builder's choice (for example a `WeakMap<JobError, number>` inside `json-request.ts`); it must not change the `JobError` class in core nor put the status into a message.

Ollama deep keys: `['options']`. Own fields: `model`, `stream: false`, `messages`, and `format` when a schema is passed.

- [ ] **Step 1: Failing tests.** `request-options.test.ts`: `ollamaFixedFields(DEFAULT_REQUEST_OPTIONS)` equals `{ options: { temperature: 0 } }`; temperature 0.7, `maxTokens: 512` → `options: { temperature: 0.7, num_predict: 512 }`; thinking `off` → `think: false`, `on` → `think: true`, `default` → no `think` key; `openAiFixedFields`: defaults → `{ temperature: 0 }`; `maxTokens: 512` → `max_tokens: 512`; thinking `off`/`on` → `chat_template_kwargs: { enable_thinking: false/true }`, `default` → no such key; `composeBody`: extra replaces a fixed scalar; with deep key `options`, `extra.options = { top_p: 0.9 }` gives `options: { temperature: 0, top_p: 0.9 }` and `extra.options = { temperature: 1 }` gives `options: { temperature: 1 }`; a non-object under a deep key replaces; own fields win over an `extra` that carries `model`, `messages`, `stream`, `format` (Review Focus 1). `ollama-options.test.ts` (against the in-process mock, reading `mock.requests`): no `requestOptions` → the parsed body of a tagging request has exactly the keys `model`, `stream`, `format`, `options`, `messages` and `options` equals `{ temperature: 0 }`; a describe request has the same without `format`; with `{ temperature: 0.4, thinking: 'off', maxTokens: 300, extra: { keep_alive: '5m', options: { top_p: 0.8 } } }` the body has `think: false`, `keep_alive: '5m'`, `options: { temperature: 0.4, num_predict: 300, top_p: 0.8 }`; an `extra` of `{ model: 'evil', stream: true }` still sends the requested model and `stream: false`.
- [ ] **Step 2:** Run them — fail.
- [ ] **Step 3:** Move the transport into `json-request.ts` (no behaviour change; `ollama-vision.ts` keeps its paths, bodies, `hasVision`, `listModels`). Implement `request-options.ts` and use it in the Ollama `chat`.
- [ ] **Step 4:** `pnpm --filter @assetforge/providers test` green with the existing files untouched; `pnpm typecheck`, `pnpm test`.
- [ ] **Step 5:** Commit `feat(providers): shared JSON transport and request options for the Ollama adapter`.

---

### Task 3: Mock provider — OpenAI endpoints

**Files:**
- Modify: `docker/mock-provider/server.mjs`, `docker/mock-provider/server.d.mts`
- Test: `packages/providers/test/mock-provider.test.ts` (extend)

**Interfaces — Produces:**

```ts
export const MOCK_THINKING_MODEL = 'mock-thinking';
export const MOCK_FENCED_MODEL = 'mock-fenced';
export const MOCK_REASONING_ONLY_MODEL = 'mock-reasoning-only';
// startMockProvider option: refuseResponseFormat?: boolean
```

- `GET /v1/models` → `200 { object: 'list', data: [{ id, object: 'model' }] }` with the three existing names, then `mock-thinking`, `mock-fenced`, `mock-reasoning-only`, then `Qwen/Mock-VL:7B` (a name with `/` and `:` that behaves like `mock-vision`). `/api/tags` is unchanged.
- `POST /v1/chat/completions` → `200 { id, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }`. With `response_format.type === 'json_schema'` the content is the same deterministic tag JSON the `/api/chat` path gives when `format` is set; without it, the same plain-text description as `/api/chat` without `format`. A request without `response_format` whose text part asks for JSON gets the plain text all the same (the mock does not read prompts) — except after a refused `response_format` (below), where the builder makes the mock answer the tag JSON when the request carries no `response_format` and the option `refuseResponseFormat` is set, so the fallback can be tested end to end.
- `mock-thinking`: the content starts with `<think>\nmock reasoning\n</think>\n\n` before the normal content. `mock-fenced`: a JSON answer is wrapped as "```json\n…\n```". `mock-reasoning-only`: `content: null`, `reasoning_content: 'mock reasoning'`. A model name the mock does not know → `404`.
- `refuseResponseFormat: true`: a chat request carrying `response_format` is answered `400 { error: … }`.
- Same optional key check (401), same `requests` recording, same request log line. The failure queue (`failures`) and `delayMs` are shared: the next chat request on either API consumes the next queued failure.

- [ ] **Step 1: Failing tests** for each bullet above (model list contents and order; JSON and text answers equal the `/api/chat` ones for the same image; the three special models; unknown model 404; 401 without the key when one is set; `refuseResponseFormat`; a queued `500` is consumed by a `/v1` chat request and the next succeeds; the request is recorded with its parsed body).
- [ ] **Step 2–4:** Fail, implement, `pnpm --filter @assetforge/providers test mock-provider` and the whole suite green.
- [ ] **Step 5:** Commit `feat(mock-provider): OpenAI-compatible chat and model endpoints`.

---

### Task 4: Providers — the OpenAI-compatible adapter

**Files:**
- Create: `packages/providers/src/openai-vision.ts`
- Modify: `packages/providers/src/index.ts`
- Test: `packages/providers/test/openai-vision.test.ts` (new)

**Interfaces — Consumes:** `createJsonRequester`, `statusOf`, `composeBody`, `openAiFixedFields`, `DEFAULT_REQUEST_OPTIONS` (Task 2); the mock endpoints (Task 3); `VisionProvider` from core. **Produces:**

```ts
export const OPENAI_PROVIDER = 'openai';
export type OpenAiVisionOptions = OllamaVisionOptions;   // same shape, including requestOptions
export function createOpenAiVision(options: OpenAiVisionOptions): VisionProvider;
/** Removes one leading <think>…</think> block (after optional whitespace); an unclosed block removes nothing. */
export function stripThinking(content: string): string;
```

Rules (spec §5.4):
- Paths `/chat/completions` and `/models` under the base URL; a trailing slash of the base URL is dropped; nothing else is appended.
- Chat body: own fields `model`, `stream: false`, `messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,<base64>' } }] }]`, and for `analyzeImage` `response_format: { type: 'json_schema', json_schema: { name: 'tags', strict: true, schema } }`. Deep keys: `['chat_template_kwargs', 'extra_body']`.
- Answer: `choices[0].message.content` must be a non-empty string after `stripThinking` and trimming, else `invalid_response` (reported through `onFailure('invalid_response', 200)` like the Ollama adapter does for unparsable content). `reasoning_content` is ignored.
- `analyzeImage`: parse the stripped content as JSON; if that fails and the trimmed content is exactly one Markdown code fence (```` ``` ```` with an optional language word, then the body, then ```` ``` ````), parse its body; else `invalid_response`.
- Fallback: when an `analyzeImage` request fails with HTTP 400, send it once more without `response_format`. If the second succeeds, remember the model in a `Set` of the adapter instance and send later tagging requests for it without `response_format` from the start. If the second fails, its failure is the result. `onFailure` is called once, for the final outcome only (the first attempt is sent `silent`). No other status and no describe request is ever repeated.
- `describeImage`: the stripped, trimmed content.
- `listModels`: `GET /models`, `data[].id` through `ModelNameSchema`, at most the same maximum as the Ollama adapter, each `{ name, vision: null }`, bounded by the same list timeout rule; a body without a `data` array → `invalid_response`.

- [ ] **Step 1: Failing tests** against the in-process mock (and a stub `fetch` where the mock cannot produce the case):
  - tagging returns the parsed tag object; the recorded body has the `messages` shape above with a `data:image/jpeg;base64,` URL, `stream: false`, `temperature: 0`, the `response_format` above, and no `chat_template_kwargs`;
  - describe returns the text and sends no `response_format`;
  - options: `{ temperature: 0.3, thinking: 'off', maxTokens: 200, extra: { top_p: 0.9, chat_template_kwargs: { foo: 1 } } }` → `temperature: 0.3`, `max_tokens: 200`, `top_p: 0.9`, `chat_template_kwargs: { enable_thinking: false, foo: 1 }`; an `extra` carrying `model`, `messages`, `stream`, `response_format` changes none of them (Review Focus 1);
  - model `Qwen/Mock-VL:7B` is listed and sent verbatim (Review Focus 2); `listModels` returns the seven names with `vision: null`;
  - base URL `<mock>/v1/` and `<mock>/v1` both request `/v1/chat/completions`; base URL `<mock>` requests `/chat/completions` and fails as `provider_rejected` (404) — nothing is guessed (Review Focus 3);
  - `mock-thinking`: tagging parses, describe returns the text without the block; `stripThinking` unit cases (leading whitespace, no block, unclosed block unchanged, a block in the middle unchanged);
  - `mock-fenced`: tagging parses;
  - `mock-reasoning-only`: tagging and describe reject with `invalid_response` and `onFailure` saw `('invalid_response', 200)` once (Review Focus 4); an empty string content and a missing `choices` do the same;
  - `refuseResponseFormat`: the first tagging call makes two requests (with, then without `response_format`) and resolves; the second tagging call for that model makes one request without it; `onFailure` was never called; a 400 on both attempts (stub fetch) rejects `provider_rejected` with one `onFailure('provider_rejected', 400)`; a 400 on describe is not repeated;
  - transport parity with the Ollama adapter, one case each: the key as `Authorization: Bearer test-key-not-real` and absent without a key; 401 → `provider_unauthorized`; 429 and 500 → `provider_unavailable`; a redirect → `provider_rejected` and not followed; timeout → `provider_timeout`; caller abort rejects with the signal's reason and no `onFailure`; a closed port → `provider_unreachable`.
- [ ] **Step 2–4:** Fail, implement, `pnpm --filter @assetforge/providers test`, `pnpm typecheck`, `pnpm test` green.
- [ ] **Step 5:** Commit `feat(providers): OpenAI-compatible vision adapter`.

---

### Task 5: Desktop main — settings version 4, purposes, adapter per kind, fingerprint per kind

**Files:**
- Modify: `apps/desktop/src/main/provider-store.ts`, `provider-gateway.ts`, `provider-handlers.ts` (if it names a kind), `job-handlers.ts`, `job-host.ts`, `composition.ts`, `describe-controller.ts` (only if it names a kind); `packages/core/src/analysis-handler.ts` and its callers and tests
- Test: `apps/desktop/test/provider-store.test.ts`, `provider-gateway.test.ts`, `provider-ipc.test.ts`, `jobs-ipc.test.ts`, `analysis-harness.ts`, `packages/core/test/…analysis-handler…`; new `apps/desktop/test/openai-acceptance.test.ts`

**Interfaces — Consumes:** Tasks 1, 2, 4. **Produces:**

```ts
// provider-store.ts
export interface ProviderEntry { /* as today */ options: ProviderOptions | null }   // null exactly for venice
// ProviderStore: `first(purpose?: ProviderPurpose)`, `resolve(id: string | undefined, purpose?: ProviderPurpose)`; default 'vision'
export const wrongKind: (wanted: ProviderPurpose) => string;   // 'image' → CANNOT_GENERATE, 'vision' → CANNOT_ANALYSE

// provider-gateway.ts
export type VisionAdapterFactory = (o: {
  baseUrl: string; timeoutMs: number; apiKey: () => string | null;
  onFailure: (code: JobErrorCode, status: number | null) => void;
  requestOptions: VisionRequestOptions;
}) => VisionProvider;
// createProviderGateway({ store, createVision: Record<VisionKind, VisionAdapterFactory>, createImage, log })

// packages/core analysis handler deps
/** The fingerprint provider id of the job's lane; null when the lane has no usable entry. */
provider: (lane: string | null) => string | null;
```

Rules:
- **File version 4.** Schema: every entry has `options: ProviderOptionsSchema.nullable()`; refine: `options === null` exactly when `kind === 'venice'`; refine: for a vision entry `parseExtraParameters(options.extra, kind).ok`. The existing refinements stay, with "not `venice`" read as "vision purpose" (`editModel === null` for vision kinds). A version 3 file is read in memory with `DEFAULT_PROVIDER_OPTIONS` on every `ollama` entry and `null` on `venice`; the first write stores version 4 (the pattern of 2 → 3). Versions 1 and 2 keep upgrading as today and end with the same options.
- **Save.** `kind` may be `openai` for a new entry. Base URL rule for `openai` as for `ollama`. Model fields by purpose. `options`: absent → the stored options of an existing vision entry, the defaults for a new one; present → validated with `parseExtraParameters(options.extra, kind)`; a refusal throws `ValidationFailedError(extraParametersMessage(refusal))` and writes nothing. For `venice` the stored value is always `null`.
- **Purposes.** `first`, `resolve`, `lastUsed` and `markUsed` work by purpose: the vision slot may name an entry of either vision kind. Every `'ollama'` / `'venice'` literal in the main process that means a purpose goes through `purposeOf`.
- **Gateway.** `vision(id)` returns the adapter of any vision entry, built with the factory of its kind and `requestOptions = { temperature, thinking, maxTokens, extra: parsed }` (a stored `extra` that does not parse — impossible after the schema — is treated as `{}`). `models` works for both vision kinds. The log label stays `Vision`.
- **Fingerprint.** `composition.ts` passes `provider: (lane) => …` answering the entry's kind for a vision entry (`'ollama'` | `'openai'`, equal to `OLLAMA_PROVIDER` / `OPENAI_PROVIDER`) and `null` otherwise; the handler throws `JobError('provider_not_configured')` on `null`. `analysis:preview` and `analysis:enqueue` use the resolved entry's kind as `provider`.
- **Summary.** `jobs:summary.paused[].kind`: the real kind of the lane's entry; for a lane without an existing entry what the resource class implies (`local_gpu` → `ollama`, `remote_api` → `venice`). The name lookup branches on the resource class, not on the kind.
- **Reroute.** `jobs:reroute` accepts any vision entry as target (`resolve(id, 'vision')`).
- The environment entry has `kind: 'ollama'` and `DEFAULT_PROVIDER_OPTIONS`.

- [ ] **Step 1: Failing tests.**
  - store: a version 3 file with one `ollama` and one `venice` entry lists options defaults / `null`, and after one save the file on disk is version 4 and reads back equal; saving a new `openai` entry (`http://127.0.0.1:1/v1`) round-trips with its options; `options` absent on an update keeps the stored ones; `extra: '[1]'` → `validation_failed` with `The extra parameters are not a JSON object`; `extra: '{"model":"x"}'` → `The extra parameters must not set model`; `{"response_format":{}}` is refused for `openai` and accepted for `ollama`; a refused save leaves the file untouched; options sent for a `venice` entry are stored as `null`; a kind change `ollama` → `openai` is still refused; `resolve(undefined)` returns an `openai` entry when it was marked used last, and `resolve(openaiId, 'image')` throws with `This provider cannot generate images`; a version 4 file whose vision entry has `options: null` is treated like any other invalid file.
  - gateway: an `openai` entry gets the `openai` factory and an `ollama` entry the `ollama` one; the factory receives the parsed `requestOptions`; saving the entry with other options builds a new adapter with them; `models` works for an `openai` entry and refuses a `venice` one.
  - core handler: `provider` returning `null` fails the job as `provider_not_configured`; the fingerprint written uses the returned id.
  - jobs IPC: a paused `local_gpu` lane of an `openai` entry reports `kind: 'openai'`; of a deleted entry `kind: 'ollama'`; reroute from an `ollama` to an `openai` entry moves the waiting jobs.
  - `openai-acceptance.test.ts` (in-process mock, the harness of `analysis-acceptance.test.ts`): with an `openai` entry on `<mock>/v1` and the key `test-key-not-real`, `analysis:enqueue` for one image ends with AI tags on the file and the mock saw `POST /v1/chat/completions` with the bearer key; the same file and model name enqueued for an `ollama` entry on the same mock is analysed again (not skipped), and a second enqueue for the `openai` entry is skipped by the fingerprint; `analysis:describe` through the `openai` entry returns the text; saving the entry with `thinking: 'off'` makes the next request carry `chat_template_kwargs.enable_thinking === false`; the main log contains neither the key nor the base URL.
- [ ] **Step 2–4:** Fail, implement, `pnpm typecheck`, `pnpm test` green.
- [ ] **Step 5:** Commit `feat(desktop): OpenAI-compatible provider entries with request options`.

---

### Task 6: Renderer — both vision kinds everywhere, option fields in Settings

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/ProviderSettings.tsx`, `ProviderSelect.tsx`, `MoveJobsDialog.tsx`, `AppShell.tsx`, `provider-context.tsx`, `provider-choice.ts`, `provider-gate.ts`, `labels.ts`; `apps/desktop/test/renderer/fake-api.ts`
- Test: the existing renderer tests of those files, extended; file names as found in `apps/desktop/test/renderer/`

**Interfaces — Consumes:** `purposeOf`, `isVisionKind`, `ProviderOptions`, `DEFAULT_PROVIDER_OPTIONS`, `parseExtraParameters`, `extraParametersMessage`, `PROVIDER_EXTRA_MAX` (Task 1). **Produces:** no new exports other files rely on.

Rules (spec §5.6):
- Everything that selects or filters entries by `kind === 'ollama'` / a `kind` parameter defaulting to `'ollama'` works by purpose: `ProviderSelect` (prop `purpose`, default `'vision'`), `provider-choice.ts`, `provider-gate.ts`, `defaultProviderId`, `MoveJobsDialog` (source and targets: any vision entry), the pause banner (Move jobs when `purposeOf(entry.kind) === 'vision'`). Callers that passed `kind="venice"` pass `purpose="image"`.
- A model list in which every model has `vision: null` behaves as today: all selectable, no `no vision model` state.
- `ProviderSettings`: the kind select of a new entry offers `Ollama`, `OpenAI-compatible`, `Venice` (labels in `labels.ts`); a new `openai` entry starts with an empty base URL and the placeholder `http://localhost:8000/v1`; the model fields of an `openai` entry are those of an `ollama` entry.
- For vision kinds four fields below the models, labelled `Temperature` (number input, min 0, max 2, step 0.1), `Thinking` (select `Server default` / `Off` / `On`), `Max. answer tokens` (number input, empty means not sent) and `Extra parameters` (monospace textarea, 4 rows, `maxLength` 4000, `spellCheck={false}`). Each has a `title` tooltip; no helper text in the layout. Tooltips: temperature — `0 gives the most repeatable answers`; thinking — `Sent as think (Ollama) or chat_template_kwargs.enable_thinking (OpenAI-compatible). For other models leave Server default and use Extra parameters`; tokens — `Empty: the server decides`; extra — `A JSON object merged into every request of this provider`.
- Validation in the form, before Save: temperature must parse as a number within 0–2 (the raw text is kept in the form state; an empty text or `0,5` is invalid); tokens empty or an integer 1–100 000; extra through `parseExtraParameters` for the entry's kind. An invalid field gets `aria-invalid`, Save is disabled, and for the extra field the fixed message is shown where the form shows its other field errors. Save sends `options` for vision kinds and omits it for `venice`.
- In environment mode the fields are shown disabled with the entry's values.
- `fake-api.ts`: `providers:save` stores and returns `options` with the same defaulting as the main process; fixtures carry `options`.

- [ ] **Step 1: Failing tests.** Settings: the kind select has three options; choosing `OpenAI-compatible` shows the placeholder and the four fields, choosing `Venice` hides them; an existing `ollama` entry shows its stored options; Save sends the typed options (`temperature: 0.5`, `thinking: 'off'`, `maxTokens: 256`, `extra: '{"top_p":0.9}'`) and for an empty token field `maxTokens: null`; temperature `''`, `0,5` and `3` each disable Save and set `aria-invalid`; tokens `0` and `1.5` likewise (Review Focus 5); extra `[1]` shows `The extra parameters are not a JSON object` and disables Save; extra `{"response_format":{}}` shows `The extra parameters must not set response_format` for an `openai` entry and is accepted for an `ollama` entry; no explanatory text node besides labels and the error message (the tooltips are `title` attributes). Analysis dialogs: `ProviderSelect` lists an `ollama` and an `openai` entry and no `venice` one; with the `openai` entry last used it is preselected with its default model; a model list of `vision: null` models lets the dialog start. `MoveJobsDialog` offers an `openai` target for an `ollama` source. The pause banner shows Move jobs for a paused `openai` entry and not for a `venice` one.
- [ ] **Step 2–4:** Fail, implement, `pnpm typecheck`, `pnpm test` green (including `theme.test.ts` and `labels.test.ts`).
- [ ] **Step 5:** Commit `feat(desktop): provider options and the OpenAI-compatible kind in the renderer`.

---

### Task 7: Documentation

**Files:**
- Modify: `ReadMe.md` (the provider and settings sections: kinds and purposes, the options and their mapping per kind, the reserved keys, the structured-output fallback, think-block and fence handling, fingerprint id per kind, settings file version 4), `docs/backlog.md` (section "Vision providers")

- [ ] **Step 1:** Read the spec and the code as built (`packages/providers/src/openai-vision.ts`, `request-options.ts`, `apps/desktop/src/main/provider-store.ts`), then update `ReadMe.md` so every statement is true of the code. Find the sections by searching for `Ollama`, `provider-settings.json` and `capabilit`.
- [ ] **Step 2:** Backlog leftovers under "Vision providers": no environment mode for `openai`; the thinking switch of the `openai` kind covers only `enable_thinking`; no capability report, so every model of an `openai` entry is offered; options per entry, not per model or prompt; options are not part of the fingerprint; a request in flight keeps the old options; the adapter was tested only against the mock provider.
- [ ] **Step 3:** `pnpm typecheck` and `pnpm test` green (nothing should change). Commit `docs: OpenAI-compatible provider and request options`.
