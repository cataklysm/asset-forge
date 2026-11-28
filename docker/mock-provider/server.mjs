import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

export const MOCK_MODEL = 'mock-vision';
/** A model whose capabilities lack vision. */
export const MOCK_TEXT_MODEL = 'mock-text';
/** A model whose show answer carries no capabilities, like an older server. */
export const MOCK_LEGACY_MODEL = 'mock-legacy';

const MODELS = [MOCK_MODEL, MOCK_TEXT_MODEL, MOCK_LEGACY_MODEL];
const SHOW = {
  [MOCK_MODEL]: { capabilities: ['completion', 'vision'] },
  [MOCK_TEXT_MODEL]: { capabilities: ['completion'] },
  [MOCK_LEGACY_MODEL]: { modelfile: '' },
};

const VOCABULARY = [
  'chair',
  'table',
  'lamp',
  'sword',
  'shield',
  'barrel',
  'crate',
  'tree',
  'rock',
  'house',
  'tower',
  'bridge',
  'door',
  'window',
  'statue',
  'vase',
  'book',
  'bottle',
  'helmet',
  'armor',
  'wood',
  'metal',
  'stone',
  'glass',
  'leather',
  'fabric',
  'ceramic',
  'iron',
  'gold',
  'rust',
  'red',
  'blue',
  'green',
  'yellow',
  'brown',
  'grey',
  'white',
  'black',
  'orange',
  'purple',
];
const VIEWS = ['front view', 'side view', 'three-quarter view', 'top view', 'close-up'];
const STYLES = ['photorealistic', 'stylized', 'concept art', 'line drawing', 'pixel art'];

/** Picks six distinct vocabulary words, one view and one style from the image hash. */
function tagsFor(imageBytes) {
  const hash = createHash('sha256').update(imageBytes).digest();
  const picked = [];
  let cursor = 0;
  let salt = 0;
  while (picked.length < 6) {
    if (cursor >= 24) {
      cursor = 0;
      salt += 1;
    }
    const word = VOCABULARY[(hash[cursor] + hash[cursor + 1] * 7 + salt * 13) % VOCABULARY.length];
    cursor += 2;
    if (!picked.includes(word)) picked.push(word);
  }
  picked.push(VIEWS[hash[28] % VIEWS.length], STYLES[hash[29] % STYLES.length]);
  return picked;
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

/** A plain-text description for a chat request without `format`, derived from the same picks as the tags. */
function descriptionFor(imageBytes) {
  const tags = tagsFor(imageBytes);
  return `A ${tags[7]} ${tags[6]} of a ${tags[0]} with ${tags[1]} and ${tags[2]}.`;
}

// --- OpenAI-shaped chat and model endpoints under /v1 --------------------------------------------

/** Answers with a `<think>` block before the content. */
export const MOCK_THINKING_MODEL = 'mock-thinking';
/** Wraps a JSON answer in a code fence. */
export const MOCK_FENCED_MODEL = 'mock-fenced';
/** Answers `content: null` with the text in `reasoning_content`. */
export const MOCK_REASONING_ONLY_MODEL = 'mock-reasoning-only';
/** A name with `/` and `:` that behaves like `mock-vision`. */
export const MOCK_SLASH_MODEL = 'Qwen/Mock-VL:7B';

const OPENAI_MODELS = [...MODELS, MOCK_THINKING_MODEL, MOCK_FENCED_MODEL, MOCK_REASONING_ONLY_MODEL, MOCK_SLASH_MODEL];
/** The models that answer a chat on `/v1/chat/completions`. */
const OPENAI_CHAT_MODELS = [
  MOCK_MODEL,
  MOCK_THINKING_MODEL,
  MOCK_FENCED_MODEL,
  MOCK_REASONING_ONLY_MODEL,
  MOCK_SLASH_MODEL,
];
const MOCK_REASONING = 'mock reasoning';

/** The base64 data of the first `image_url` data URL in the messages; undefined when there is none. */
function openAiImageOf(messages) {
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      const url = part?.type === 'image_url' ? part.image_url?.url : undefined;
      if (typeof url !== 'string') continue;
      const comma = url.indexOf(',');
      const data = url.startsWith('data:') && comma >= 0 ? url.slice(comma + 1) : '';
      if (data.length > 0) return data;
    }
  }
  return undefined;
}

/** The assistant message of a completion for `model`, given the plain content and whether it is JSON. */
function openAiMessage(model, content, isJson) {
  if (model === MOCK_REASONING_ONLY_MODEL)
    return { role: 'assistant', content: null, reasoning_content: MOCK_REASONING };
  if (model === MOCK_THINKING_MODEL)
    return { role: 'assistant', content: `<think>\n${MOCK_REASONING}\n</think>\n\n${content}` };
  if (model === MOCK_FENCED_MODEL && isJson) return { role: 'assistant', content: '```json\n' + content + '\n```' };
  return { role: 'assistant', content };
}

// --- Venice-shaped image endpoints under /api/v1 -------------------------------------------------

export const MOCK_EDIT_MODEL = 'mock-edit';
/** An edit model that states no constraints and no pricing. */
export const MOCK_EDIT_BASIC_MODEL = 'mock-edit-basic';

/** Edit prompts that make the mock fail in a fixed way. */
export const MOCK_PROMPT_NO_BALANCE = 'mock:402';
export const MOCK_PROMPT_VIOLATION = 'mock:422';
export const MOCK_PROMPT_BUSY = 'mock:429';
export const MOCK_PROMPT_FAIL = 'mock:500';
/** Answers after 30 s, or at once when the mock is closed. */
export const MOCK_PROMPT_SLOW = 'mock:slow';
/** A 200 with the content-violation header. */
export const MOCK_PROMPT_VIOLATION_OK = 'mock:violation-200';

/** How many entries `requests` and `imageRequests` keep by default; beyond it the oldest is dropped. */
export const MOCK_MAX_RECORDED = 1000;

/** Appends an entry to a record list, dropping the oldest beyond `limit` while keeping the same array. */
function record(list, entry, limit) {
  list.push(entry);
  if (list.length > limit) list.splice(0, list.length - limit);
}

const SLOW_MS = 30_000;
const VIOLATION_HEADER = 'x-venice-is-content-violation';
const TRIGGERS = {
  [MOCK_PROMPT_NO_BALANCE]: { status: 402, error: 'Insufficient balance' },
  [MOCK_PROMPT_VIOLATION]: { status: 422, error: 'Content violation', violation: true },
  [MOCK_PROMPT_BUSY]: { status: 429, error: 'Rate limit exceeded' },
  [MOCK_PROMPT_FAIL]: { status: 500, error: 'Inference failed' },
};

const EDIT_MODELS = [
  {
    id: MOCK_EDIT_MODEL,
    object: 'model',
    type: 'inpaint',
    owned_by: 'mock',
    model_spec: {
      name: 'Mock Edit',
      constraints: {
        aspectRatios: ['1:1', '16:9', '9:16'],
        resolutions: ['1K', '2K', '4K'],
        defaultResolution: '1K',
        promptCharacterLimit: 1500,
      },
      pricing: { inpaint: { usd: 0.04, diem: 0.04 } },
    },
  },
  {
    id: MOCK_EDIT_BASIC_MODEL,
    object: 'model',
    type: 'inpaint',
    owned_by: 'mock',
    model_spec: { name: 'Mock Edit Basic' },
  },
];
const LONG_EDGE = { '1K': 64, '2K': 128, '4K': 256 };

const CRC_TABLE = Array.from({ length: 256 }, (_, entry) => {
  let value = entry;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A deterministic RGB PNG of the given size, coloured from `seed`. */
function pngOf(width, height, seed) {
  const [red, green, blue] = createHash('sha256').update(seed).digest();
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([red, green, blue], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The IHDR size of a PNG; null for anything else. */
function pngSizeOf(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR')
    return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function sendPng(response, bytes, headers = {}) {
  response.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length, ...headers });
  response.end(bytes);
}

/** The multipart fields of a request body: text fields and the bytes of `image`. */
async function readForm(contentType, raw) {
  try {
    const form = await new Request('http://mock/', {
      method: 'POST',
      headers: { 'content-type': contentType ?? '' },
      body: raw,
    }).formData();
    const fields = {};
    let image = null;
    for (const [name, value] of form) {
      if (typeof value === 'string') fields[name] = value;
      else if (name === 'image') image = Buffer.from(await value.arrayBuffer());
    }
    return { fields, image };
  } catch {
    return { fields: {}, image: null };
  }
}

/** Answers an edit: the long edge follows the resolution, the short one the aspect ratio. */
function editAnswer(fields) {
  const model = EDIT_MODELS.find((entry) => entry.id === fields.model);
  if (!model) return { status: 400, error: 'Unknown model' };
  const constraints = model.model_spec.constraints;
  const resolution = fields.resolution ?? constraints?.defaultResolution ?? '1K';
  const aspectRatio = fields.aspect_ratio ?? '1:1';
  if (
    constraints &&
    (!constraints.resolutions.includes(resolution) || !constraints.aspectRatios.includes(aspectRatio))
  ) {
    return { status: 400, error: 'Invalid parameters' };
  }
  const edge = LONG_EDGE[resolution];
  const ratio = /^(\d{1,2}):(\d{1,2})$/.exec(aspectRatio);
  if (!edge || !ratio || Number(ratio[1]) === 0 || Number(ratio[2]) === 0)
    return { status: 400, error: 'Invalid parameters' };
  const [widthRatio, heightRatio] = [Number(ratio[1]), Number(ratio[2])];
  const width = widthRatio >= heightRatio ? edge : Math.max(1, Math.round((edge * widthRatio) / heightRatio));
  const height = heightRatio >= widthRatio ? edge : Math.max(1, Math.round((edge * heightRatio) / widthRatio));
  return { status: 200, png: pngOf(width, height, `${fields.model}\n${fields.prompt}\n${aspectRatio}\n${resolution}`) };
}

// --------------------------------------------------------------------------------------------------

export async function startMockProvider(options = {}) {
  const { port = 11500, host = '127.0.0.1', delayMs = 0, log = () => {}, refuseResponseFormat = false } = options;
  // An empty key means none: the Compose file passes an unset variable through as an empty string.
  const apiKey = options.apiKey ? String(options.apiKey) : null;
  const failures = [...(options.failures ?? [])];
  const maxRecorded =
    Number.isInteger(options.maxRecorded) && options.maxRecorded >= 0 ? options.maxRecorded : MOCK_MAX_RECORDED;
  const requests = [];
  const imageRequests = [];
  const timers = new Set();
  /** Slow answers still waiting; `close` sends them at once. */
  const slow = new Set();

  const authorized = (request) => apiKey === null || request.headers.authorization === `Bearer ${apiKey}`;
  let completionCount = 0;

  /** Sends a chat answer after `delayMs`; `close` drops the ones still waiting. */
  function answerLater(answer) {
    if (delayMs <= 0) return answer();
    const timer = setTimeout(() => {
      timers.delete(timer);
      answer();
    }, delayMs);
    timers.add(timer);
  }

  /** `POST /v1/chat/completions`, after the key check; consumes the shared failure queue. */
  function openAiChat(response, body) {
    const failure = failures.shift();
    if (failure === 'hang') return;
    if (typeof failure === 'number') return sendJson(response, failure, { error: 'mock failure' });

    const request = body && typeof body === 'object' ? body : {};
    if (!OPENAI_CHAT_MODELS.includes(request.model)) {
      return sendJson(response, 404, {
        error: { message: `model '${String(request.model)}' not found`, type: 'invalid_request_error' },
      });
    }
    const hasFormat = request.response_format !== undefined;
    if (hasFormat && refuseResponseFormat) {
      return sendJson(response, 400, {
        error: { message: 'response_format is not supported', type: 'invalid_request_error' },
      });
    }
    const image = openAiImageOf(Array.isArray(request.messages) ? request.messages : []);
    if (image === undefined)
      return sendJson(response, 400, { error: { message: 'no image supplied', type: 'invalid_request_error' } });

    const bytes = Buffer.from(image, 'base64');
    // With the refusal switch on, a request without `response_format` stands for the caller's fallback and gets the JSON.
    const isJson = request.response_format?.type === 'json_schema' || (!hasFormat && refuseResponseFormat);
    const message =
      failure === 'invalid'
        ? { role: 'assistant', content: 'not json' }
        : openAiMessage(
            request.model,
            isJson ? JSON.stringify({ tags: tagsFor(bytes) }) : descriptionFor(bytes),
            isJson,
          );
    completionCount += 1;
    const id = `chatcmpl-mock-${completionCount}`;
    answerLater(() =>
      sendJson(response, 200, {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
      }),
    );
  }

  async function venice(request, response, path, raw) {
    // The multipart body is not kept on `requests`; `imageRequests` records its fields and the image size.
    record(
      requests,
      { method: request.method ?? '', path, body: undefined, headers: { ...request.headers } },
      maxRecorded,
    );
    const query = new URL(request.url ?? '/', 'http://mock').searchParams;
    if (request.method === 'GET' && path === '/api/v1/models') {
      if (!authorized(request)) return sendJson(response, 401, { error: 'Authentication failed' });
      const type = query.get('type') ?? 'text';
      return sendJson(response, 200, { object: 'list', type, data: type === 'inpaint' ? EDIT_MODELS : [] });
    }
    const isEdit = path === '/api/v1/image/edit';
    if (request.method !== 'POST' || (!isEdit && path !== '/api/v1/image/upscale'))
      return sendJson(response, 404, { error: 'not found' });

    const { fields, image } = await readForm(request.headers['content-type'], raw);
    record(
      imageRequests,
      { path, authorization: request.headers.authorization ?? null, fields, fileBytes: image?.length ?? 0 },
      maxRecorded,
    );
    if (!authorized(request)) return sendJson(response, 401, { error: 'Authentication failed' });
    if (!image || image.length === 0) return sendJson(response, 400, { error: 'No image supplied' });

    if (!isEdit) {
      const scale = Number(fields.scale);
      if (scale !== 2 && scale !== 4) return sendJson(response, 400, { error: 'Invalid scale' });
      const base = pngSizeOf(image) ?? { width: 32, height: 32 };
      return sendPng(response, pngOf(base.width * scale, base.height * scale, image));
    }

    if (typeof fields.prompt !== 'string' || fields.prompt.length === 0)
      return sendJson(response, 400, { error: 'No prompt supplied' });
    const trigger = Object.hasOwn(TRIGGERS, fields.prompt) ? TRIGGERS[fields.prompt] : null;
    if (trigger) {
      const text = JSON.stringify({ error: trigger.error });
      response.writeHead(trigger.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
        ...(trigger.violation ? { [VIOLATION_HEADER]: 'true' } : {}),
      });
      return response.end(text);
    }
    const answer = editAnswer(fields);
    if (answer.status !== 200) return sendJson(response, answer.status, { error: answer.error });
    if (fields.prompt === MOCK_PROMPT_VIOLATION_OK)
      return sendPng(response, answer.png, { [VIOLATION_HEADER]: 'true' });
    if (fields.prompt !== MOCK_PROMPT_SLOW) return sendPng(response, answer.png);

    const send = () => {
      clearTimeout(timer);
      slow.delete(send);
      if (!response.writableEnded && !response.destroyed) sendPng(response, answer.png);
    };
    const timer = setTimeout(send, SLOW_MS);
    slow.add(send);
    response.on('close', () => {
      clearTimeout(timer);
      slow.delete(send);
    });
  }

  const server = createServer((incoming, response) => {
    // The log line carries method, path and status only; headers (and so the key) never reach it.
    const logged = (incoming.url ?? '').split('?')[0];
    response.on('finish', () => log(`${incoming.method ?? ''} ${logged} ${response.statusCode}`));
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      const path = (incoming.url ?? '').split('?')[0];
      if (path.startsWith('/api/v1/')) {
        venice(incoming, response, path, Buffer.concat(chunks)).catch(() => {
          if (!response.headersSent) sendJson(response, 500, { error: 'mock error' });
        });
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      record(requests, { method: incoming.method ?? '', path, body, headers: { ...incoming.headers } }, maxRecorded);

      if (apiKey !== null && incoming.headers.authorization !== `Bearer ${apiKey}`) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      if (incoming.method === 'GET' && path === '/api/tags') {
        sendJson(response, 200, { models: MODELS.map((name) => ({ name, model: name })) });
        return;
      }
      if (incoming.method === 'GET' && path === '/v1/models') {
        sendJson(response, 200, { object: 'list', data: OPENAI_MODELS.map((id) => ({ id, object: 'model' })) });
        return;
      }
      if (incoming.method === 'POST' && path === '/v1/chat/completions') {
        openAiChat(response, body);
        return;
      }
      if (incoming.method === 'POST' && path === '/api/show') {
        const model = body && typeof body === 'object' ? body.model : undefined;
        if (typeof model === 'string' && Object.hasOwn(SHOW, model)) sendJson(response, 200, SHOW[model]);
        else sendJson(response, 404, { error: 'model not found' });
        return;
      }
      if (incoming.method !== 'POST' || path !== '/api/chat') {
        sendJson(response, 404, { error: 'not found' });
        return;
      }

      const failure = failures.shift();
      if (failure === 'hang') return;
      if (typeof failure === 'number') {
        sendJson(response, failure, { error: 'mock failure' });
        return;
      }

      const request = body && typeof body === 'object' ? body : {};
      if (request.model !== MOCK_MODEL) {
        sendJson(response, 404, { error: `model '${String(request.model)}' not found` });
        return;
      }
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const image = messages
        .flatMap((message) => (Array.isArray(message?.images) ? message.images : []))
        .find((entry) => typeof entry === 'string' && entry.length > 0);
      if (image === undefined) {
        sendJson(response, 400, { error: 'no image supplied' });
        return;
      }

      const bytes = Buffer.from(image, 'base64');
      const content =
        failure === 'invalid'
          ? 'not json'
          : request.format === undefined
            ? descriptionFor(bytes)
            : JSON.stringify({ tags: tagsFor(bytes) });
      answerLater(() =>
        sendJson(response, 200, {
          model: MOCK_MODEL,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content },
          done: true,
        }),
      );
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://${host}:${actualPort}`,
    requests,
    imageRequests,
    releaseSlow() {
      for (const send of [...slow]) send();
    },
    slowWaiting() {
      return slow.size;
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const send of [...slow]) send();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const provider = await startMockProvider({
    port: Number(process.env.MOCK_PORT ?? 11500),
    host: process.env.MOCK_HOST ?? '127.0.0.1',
    delayMs: Number(process.env.MOCK_DELAY_MS ?? 0),
    apiKey: process.env.MOCK_API_KEY,
    log: (line) => console.log(line),
  });
  console.log(`mock vision provider listening on ${provider.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void provider.close().then(() => process.exit(0)));
  }
}
