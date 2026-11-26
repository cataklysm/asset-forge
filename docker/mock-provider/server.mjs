import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const MOCK_MODEL = 'mock-vision';

const VOCABULARY = [
  'chair', 'table', 'lamp', 'sword', 'shield', 'barrel', 'crate', 'tree', 'rock', 'house',
  'tower', 'bridge', 'door', 'window', 'statue', 'vase', 'book', 'bottle', 'helmet', 'armor',
  'wood', 'metal', 'stone', 'glass', 'leather', 'fabric', 'ceramic', 'iron', 'gold', 'rust',
  'red', 'blue', 'green', 'yellow', 'brown', 'grey', 'white', 'black', 'orange', 'purple',
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

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export async function startMockProvider(options = {}) {
  const { port = 11500, host = '127.0.0.1', delayMs = 0 } = options;
  const failures = [...(options.failures ?? [])];
  const requests = [];
  const timers = new Set();

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({ method: req.method ?? '', path, body, headers: { ...req.headers } });

      if (req.method === 'GET' && path === '/api/tags') {
        sendJson(res, 200, { models: [{ name: MOCK_MODEL, model: MOCK_MODEL }] });
        return;
      }
      if (req.method !== 'POST' || path !== '/api/chat') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }

      const failure = failures.shift();
      if (failure === 'hang') return;
      if (typeof failure === 'number') {
        sendJson(res, failure, { error: 'mock failure' });
        return;
      }

      const request = body && typeof body === 'object' ? body : {};
      if (request.model !== MOCK_MODEL) {
        sendJson(res, 404, { error: `model '${String(request.model)}' not found` });
        return;
      }
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const image = messages
        .flatMap((message) => (Array.isArray(message?.images) ? message.images : []))
        .find((entry) => typeof entry === 'string' && entry.length > 0);
      if (image === undefined) {
        sendJson(res, 400, { error: 'no image supplied' });
        return;
      }

      const content =
        failure === 'invalid'
          ? 'not json'
          : JSON.stringify({ tags: tagsFor(Buffer.from(image, 'base64')) });
      const answer = () =>
        sendJson(res, 200, {
          model: MOCK_MODEL,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content },
          done: true,
        });
      if (delayMs > 0) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          answer();
        }, delayMs);
        timers.add(timer);
      } else {
        answer();
      }
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
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
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
  });
  console.log(`mock vision provider listening on ${provider.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void provider.close().then(() => process.exit(0)));
  }
}
