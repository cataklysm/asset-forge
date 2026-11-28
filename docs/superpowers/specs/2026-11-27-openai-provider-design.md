# OpenAI-compatible vision provider and request options — design

Date: 2026-11-27. Status: draft for approval.

## 1. Intent

The owner wants to analyse images (tagging and Image-to-prompt) through a vLLM server. vLLM speaks the OpenAI chat API, which the app cannot talk to today: the only analysis adapter is Ollama's native API. The owner also wants to set, per provider entry, how the model is asked: temperature, thinking, and whatever else a model needs. Today the Ollama adapter sends a fixed `temperature: 0` and never says anything about thinking.

## 2. Goals, non-goals, anti-goals

Goals

- A third provider kind `openai` for any OpenAI-compatible chat server (vLLM first; LM Studio, llama.cpp server and similar come for free).
- Request options on every analysis entry (`ollama` and `openai`): temperature, thinking, maximum answer length, and a free JSON object of extra request parameters.
- Everything that works for an `ollama` entry works for an `openai` entry: tagging jobs, proposals, Image-to-prompt, the provider select and its states, the pause gate, moving waiting jobs between entries of either kind.

Non-goals

- Options on `venice` entries. Options per model or per analysis prompt. Options chosen in the analysis dialogs.
- Streaming, tool calls, text-only chat, embeddings, OpenAI's Responses API.
- An environment mode for the new kind: `ASSETFORGE_VISION_BASE_URL` keeps yielding one `ollama` entry.
- Changing the kind of an existing entry.
- A filter or marker for the kind on the Jobs screen.

Anti-goals (would make the feature a failure even if it works)

- The API key reaching any address other than the entry's own origin, or appearing in IPC, logs, jobs or the database. The extra parameters must not become a way to send headers or change the address.
- A change in what existing `ollama` entries send when the owner has not touched the new options.
- An SDK or other dependency that decides retries, redirects or headers on its own.

## 3. Constraints

- `core` and `contracts` stay free of concrete providers. Adapters live in `packages/providers`, wiring in `apps/desktop/src/main`.
- Tests use only the mock provider started in-process and the key literals `test-key-not-real` and `test-key-not-real-2`. No test and no agent calls a real server, host port 11434 or the internet. The owner checks against the real vLLM server in the running app.
- Error messages forwarded to the renderer never carry a cause, a path, a URL or a credential. Logs carry the entry id, the code and the HTTP status only.
- Renderer rules: no explanatory text in the layout (tooltips through `title`), buttons only through the constants in `ui.ts`, labels in `labels.ts`, tokens only.
- No database migration is needed and none is added.

## 4. Approaches

A. **A second adapter beside the Ollama adapter, sharing one request helper** (chosen). The transport part of `ollama-vision.ts` (bearer key, timeout, no redirects, capped answer, error mapping, failure reporting) moves into a shared module; each adapter keeps only its own paths and body shapes. The security rules exist once; each API stays readable.

B. One adapter with a dialect switch. Fewer files, but a branch at every difference (paths, image encoding, JSON format, thinking, model list), and every further kind makes it worse.

C. The official OpenAI SDK. A dependency that retries, follows redirects and sets headers by itself; the app's rules would have to be enforced around it, for two endpoints.

The owner picked A.

## 5. Design

### 5.1 Kinds and purposes

`ProviderKindSchema` becomes `['ollama', 'openai', 'venice']`. A kind never changes after creation.

Much code today uses the kind `'ollama'` to mean "can analyse". That meaning gets its own name in contracts (`provider-ref.ts`):

```ts
export type ProviderPurpose = 'vision' | 'image';
export function purposeOf(kind: ProviderKind): ProviderPurpose; // ollama, openai → 'vision'; venice → 'image'
```

Every place that selects, resolves, filters or refuses entries by "is `ollama`" / "is `venice`" switches to the purpose: `ProviderStore.first/resolve` and the last-used slots, `ProviderGateway.vision/models`, `wrongKind`, `jobs:reroute`, the lane-name lookup in `job-handlers.ts`, and in the renderer `ProviderSelect`, `provider-choice.ts`, `provider-gate.ts`, `provider-context.tsx` (`defaultProviderId`), `MoveJobsDialog` and the pause banner in `AppShell.tsx`. The entry used last for analysis may be of either vision kind. The fixed refusals `This provider cannot analyse images` and `This provider cannot generate images` stay.

Per kind:

| | `ollama` | `openai` | `venice` |
|---|---|---|---|
| purpose | vision | vision | image |
| base URL rule | as today | as `ollama` (http or https, no user info, query or fragment) | as today |
| models stored | tagging, prompt | tagging, prompt | edit |
| options | yes | yes | none |

The base URL of an `openai` entry is the API root as OpenAI clients expect it, normally ending in `/v1` (for vLLM `http://host:8000/v1`). The adapter appends `/chat/completions` and `/models`. Nothing is appended or guessed when `/v1` is missing.

### 5.2 Request options

Contracts (`provider-settings.ts`, the extra-parameter rule in `extra-parameters.ts`):

```ts
export const ThinkingSchema = z.enum(['default', 'off', 'on']);
export const ProviderOptionsSchema = z.object({
  temperature: z.number().min(0).max(2),               // default 0
  thinking: ThinkingSchema,                            // default 'default'
  maxTokens: z.number().int().min(1).max(100_000).nullable(), // default null = not sent
  extra: z.string().max(4000),                         // default '', the JSON text as typed
});
export const DEFAULT_PROVIDER_OPTIONS = { temperature: 0, thinking: 'default', maxTokens: null, extra: '' };
```

`ProviderView.options` is the object for vision kinds and `null` for `venice`. `SaveProvider.options` is optional: absent keeps the stored options of an existing entry and gives a new entry the defaults; it is ignored for `venice`.

`extra` is kept as the text the owner typed (so the editor shows it unchanged) and must be empty or parse as a JSON object. The rule lives in contracts as a pure function shared by the settings form and the main process:

```ts
export function parseExtraParameters(text: string, kind: 'ollama' | 'openai'):
  | { ok: true; value: Record<string, unknown> }   // {} for empty or blank text
  | { ok: false; reason: 'not_json' | 'not_object' | 'reserved'; key?: string };
```

Reserved top-level keys, refused at save with `reason: 'reserved'`:

- `ollama`: `model`, `messages`, `stream`, `format`
- `openai`: `model`, `messages`, `stream`, `response_format`, `n`, `tools`, `tool_choice`

Saving an entry whose `extra` is refused answers `validation_failed` with one of the fixed messages `The extra parameters are not a JSON object` or `The extra parameters must not set <key>` (the key is one of the fixed names above, never user text).

The options are part of the adapter built for an entry, like the timeout: saving an entry drops its adapter (`store.onChange`), so the next request is built from the new options. A change therefore applies to waiting jobs too and is not copied into the job payload; a request already in flight finishes with the old options.

The options are not part of the analysis fingerprint. A file analysed before a change still counts as analysed; only `force` redoes it. (Same rule as for analysis prompts.)

### 5.3 How the options reach the request

Each adapter builds the body in this order; later steps win, and step 4 can never be overridden.

1. Fixed fields: temperature, maximum length, thinking.
2. `extra`, merged over step 1. Merge rule: for the keys `options` (Ollama) and `chat_template_kwargs` and `extra_body` (OpenAI) plain objects are merged one level deep; every other key is replaced.
3. (nothing else)
4. The adapter's own fields: `model`, `messages`, `stream: false` and the JSON format of a tagging request.

Mapping of the fixed fields:

| option | `ollama` (`POST /api/chat`) | `openai` (`POST /chat/completions`) |
|---|---|---|
| temperature | `options.temperature` | `temperature` |
| maxTokens (when not null) | `options.num_predict` | `max_tokens` |
| thinking `off` / `on` | `think: false` / `think: true` | `chat_template_kwargs: { enable_thinking: false / true }` |
| thinking `default` | no `think` field | no `chat_template_kwargs` from this option |

With the default options an `ollama` request body equals today's as parsed JSON (`options: { temperature: 0 }`, no `think`, no further key; key order is not part of the rule). A test pins this.

The thinking switch of the `openai` kind fits models whose chat template reads `enable_thinking` (Qwen and others). For a model that is steered differently the owner leaves the switch at `default` and puts the model's parameter into `extra`. The tooltip of the switch says so.

### 5.4 The OpenAI-compatible adapter

`packages/providers/src/openai-vision.ts`: `createOpenAiVision(options): VisionProvider`, same options type as `createOllamaVision` plus `requestOptions`. Exported constant `OPENAI_PROVIDER = 'openai'`.

- **Shared transport** — `packages/providers/src/json-request.ts` holds what is today the inner `request` function of `ollama-vision.ts` with its helpers, unchanged in behaviour: bearer key read per request and sent only to the base URL, `redirect: 'manual'` and a redirect answered as `provider_rejected`, the timeout, the answer capped at `MAX_RESPONSE_BYTES`, the status mapping (401/403 `provider_unauthorized`, 429 and 5xx `provider_unavailable`, other non-2xx `provider_rejected`), `invalid_response` for a body that is not JSON or not the expected shape, no cause that could quote the request, `onFailure(code, status)` once per failed request. Both adapters use it. The existing Ollama tests must pass unchanged.
- **Chat** — body `{ model, stream: false, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,…' } }] }], …options }`. The image is the same 1024 px JPEG the Ollama adapter gets.
- **Tagging** (`analyzeImage`) adds `response_format: { type: 'json_schema', json_schema: { name: 'tags', strict: true, schema } }` with the schema core already passes.
- **Servers without structured output** — when a tagging request is answered with HTTP 400, the adapter sends it once more without `response_format` (the prompt already carries the fixed JSON format line, and the fence handling below is the safety net). If that second request succeeds, the adapter instance stops sending `response_format` for that model; if it fails, its failure is the result. Only the final outcome is reported through `onFailure`. This is the only repeat inside the adapter and applies to nothing but HTTP 400 on a tagging request.
- **Answer** — `choices[0].message.content` must be a string, else `invalid_response`. A `reasoning_content` field is ignored. A leading `<think>…</think>` block in the content is removed (one block at the start, after optional whitespace; with an unclosed block nothing is removed, so tagging ends as `invalid_response` and Image-to-prompt returns the content unchanged). For tagging the remaining text is parsed as JSON; if that fails and the text is a single Markdown code fence, its inner text is parsed; otherwise `invalid_response`.
- **Models** (`listModels`) — `GET /models`, `data[].id` filtered through `ModelNameSchema`, at most `MAX_LISTED_MODELS`, each with `vision: null`: the API does not report capabilities, and the renderer already treats `null` as "unknown, allowed". One request, bounded by the list timeout.

The Ollama adapter's answer handling does not change (Ollama returns thinking in a separate field).

### 5.5 Main process

- `provider-store.ts`: settings file **version 4**. A version 3 file is read with every `ollama` entry getting the default options and `venice` entries none; the first write stores version 4 (same in-memory upgrade pattern as 2 → 3). The validation of a stored file requires options on vision entries and their absence on `venice` entries. `save` applies the base URL rule per kind, the model fields per purpose, and `parseExtraParameters` for the entry's kind. `ProviderEntry.options` is `ProviderOptions | null`. The environment entry has the default options.
- `provider-gateway.ts`: takes one vision factory per vision kind (`createVision: Record<'ollama' | 'openai', factory>`), builds the adapter of an entry from its kind and passes `requestOptions` (the three fixed fields and the parsed `extra` object). `models` works for both vision kinds.
- **Fingerprint provider id** — today the analysis handler gets one constant (`OLLAMA_PROVIDER`). It becomes a function of the job's lane: `provider: (entryId) => string | null`, answered from the entry's kind (`'ollama'` or `'openai'`). `analysis:preview` and `analysis:enqueue` use the resolved entry's kind the same way. Consequence: a file analysed through an `ollama` entry counts as not analysed for an `openai` entry with the same model name, and the reverse. Existing fingerprints are untouched.
- `jobs:reroute` accepts any vision entry as the target, across kinds.
- `jobs:summary.paused[].kind` is the real kind of the lane's entry (`openai` for an OpenAI-compatible entry). For a lane whose entry no longer exists it stays what the resource class implies today (`local_gpu` → `ollama`, `remote_api` → `venice`). The banner decides on Move jobs through `purposeOf(kind)`.
- No new IPC channel. `providers:save`, `providers:list` and `providers:listModels` carry the new kind and the options through the changed schemas.

### 5.6 Renderer

`ProviderSettings.tsx`:

- The kind select of a new entry offers three kinds; labels `Ollama`, `OpenAI-compatible`, `Venice`.
- A new `openai` entry starts with an empty base URL; the input's placeholder is `http://localhost:8000/v1`.
- For vision kinds the editor shows four more fields under the models: `Temperature` (number input, step 0.1), `Thinking` (select: `Server default`, `Off`, `On`), `Max. answer tokens` (number input, empty = not sent) and `Extra parameters` (a monospace textarea, 4 rows). Each carries its explanation as a tooltip only.
- The extra parameters are checked with `parseExtraParameters` while typing; a refused text marks the field invalid, shows the fixed message in the place where the form shows its other field errors, and disables Save.
- In the read-only environment mode the fields are shown disabled with the defaults.

The three analysis dialogs, the provider select with its states, the gate, the pause banner (with Move jobs for every vision entry) and the Jobs screen need no visible change beyond accepting both vision kinds. A model list in which every entry has `vision: null` keeps behaving as today (all models selectable, no `no vision model` state).

### 5.7 Mock provider

`docker/mock-provider/server.mjs` gains the OpenAI endpoints under `/v1`, behind the same optional `MOCK_API_KEY` check and recorded in `requests` like the Ollama ones:

- `GET /v1/models` → `{ object: 'list', data: [{ id }] }` with seven ids: the three existing names, `mock-thinking`, `mock-fenced`, `mock-reasoning-only` and `Qwen/Mock-VL:7B`. The Ollama list (`/api/tags`) stays as it is.
- `POST /v1/chat/completions` → `{ choices: [{ message: { role: 'assistant', content } }] }`. With a `response_format` of type `json_schema` the content is the deterministic tag JSON the Ollama path gives for the same image; without it the plain-text description. `mock-thinking` answers with a leading `<think>…</think>` block before the content, `mock-fenced` wraps the JSON in a code fence, `mock-reasoning-only` answers `content: null` with the text in `reasoning_content`, and `Qwen/Mock-VL:7B` behaves like `mock-vision` (a name with `/` and `:`). `mock-text` and `mock-legacy` are listed but chat answers 404 for them, as for any other name; a request without an image answers 400. The existing failure queue and slow-answer switches are shared: a queued failure is consumed by the next chat request on either API.
- The start option `refuseResponseFormat` answers HTTP 400 to a chat request carrying `response_format` and the tag JSON to one without it (for the fallback above).

## 6. Tests

- contracts: `purposeOf`; `ProviderOptionsSchema` bounds; `parseExtraParameters` (empty, blank, array, scalar, invalid JSON, each reserved key per kind, a nested reserved name is allowed).
- providers: the existing Ollama suite unchanged and green after the transport extraction; default options give today's exact body; each option's mapping for both kinds; the merge order (extra overrides a fixed field, deep merge of `options` / `chat_template_kwargs`, adapter fields win even if `extra` were to carry them); the OpenAI adapter against the in-process mock: tagging, description, model list, key sent as bearer and only to the base URL, redirect refused, every status mapping, capped answer, timeout, abort, think block and code fence handling, missing `choices`.
- desktop main: version 3 → 4 upgrade and round trip; save rules per kind; a refused `extra`; options reach the adapter and a save rebuilds it; fingerprint id per kind (same model analysed through both kinds is analysed twice, a second run through the same kind is skipped); reroute between an `ollama` and an `openai` entry; an end-to-end analysis job through an `openai` entry against the mock.
- renderer: the kind select, the four fields, invalid extra blocks Save, the analysis dialogs list and gate both vision kinds, Move jobs offers both.

## 7. Left to the builder

- The exact split of `json-request.ts` (names, whether the capped reader stays private).
- Layout of the four fields inside the existing editor grid.
- Wording of the tooltips, within the UI rules.

## 8. Documentation

`ReadMe.md` (provider capabilities and settings sections), `docs/backlog.md` section "Vision providers" (leftovers: no environment mode for `openai`, thinking switch covers only `enable_thinking`, no capability report so every model is offered, options not per model).
