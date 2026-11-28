import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_OPTIONS, type ProviderOptions, type ProviderView } from '@assetforge/contracts';
import { OLLAMA_PROVIDER, OPENAI_PROVIDER } from '@assetforge/providers';
import { MOCK_MODEL, startMockProvider, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { createHarness, NONE_SKIPPED, TEST_KEY, type Harness } from './analysis-harness.js';

const REQUEST_ID = '4e2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';

describe('OpenAI-compatible provider acceptance', () => {
  let h: Harness;
  let mock: MockProvider;

  beforeEach(async () => {
    h = await createHarness();
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
  });
  afterEach(async () => {
    await h.close();
    await mock.close();
  });

  /** Saves the `openai` entry on the mock's `/v1` API with the test key; `id` replaces it, keeping the key. */
  const saveOpenAi = (o: { id?: string; options?: ProviderOptions } = {}): Promise<ProviderView> =>
    h.ok('providers:save', {
      ...(o.id === undefined ? { apiKey: TEST_KEY } : { id: o.id }),
      kind: 'openai',
      name: 'vLLM',
      baseUrl: `${mock.url}/v1`,
      timeoutSeconds: 30,
      taggingModel: null,
      promptModel: null,
      ...(o.options === undefined ? {} : { options: o.options }),
    });
  const createWorkspace = () => h.ok('workspace:create', { name: 'OpenAI', rootPath: join(h.base, 'workspace') });
  const chatCompletions = () => mock.requests.filter((r) => r.path === '/v1/chat/completions');
  const ollamaChats = () => mock.requests.filter((r) => r.path === '/api/chat');
  const enqueue = (fileId: string, providerId: string) =>
    h.ok('analysis:enqueue', {
      target: { kind: 'files', fileIds: [fileId] },
      model: MOCK_MODEL,
      mode: 'apply',
      force: false,
      providerId,
    });

  it('analyses through an openai entry, keeps its fingerprint apart from an ollama one and describes an image', async () => {
    const openai = await saveOpenAi();
    expect(openai).toMatchObject({ kind: 'openai', hasApiKey: true, options: DEFAULT_PROVIDER_OPTIONS });
    await createWorkspace();
    const [fileId] = await h.importImages(1);

    expect(await enqueue(fileId!, openai.id)).toEqual({ enqueued: 1, skipped: NONE_SKIPPED });
    await h.until((s) => s.succeeded === 1);
    const [file] = (await h.ok('files:list', { limit: 10, offset: 0, scope: { kind: 'all' } })).items;
    expect(file!.tags.filter((t) => t.origin === 'ai').length).toBeGreaterThan(0);
    expect(await h.manager.read((s) => s.database.analyses.get(fileId!))).toMatchObject({
      provider: OPENAI_PROVIDER,
      model: MOCK_MODEL,
    });
    expect(chatCompletions()).toHaveLength(1);
    expect(chatCompletions()[0]!.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);

    // A second enqueue on the openai entry is skipped by the fingerprint.
    expect(await enqueue(fileId!, openai.id)).toEqual({
      enqueued: 0,
      skipped: { ...NONE_SKIPPED, alreadyAnalysed: 1 },
    });

    // The same file and model name on an ollama entry is another provider: analysed again, not skipped.
    const ollama = await h.provider({ name: 'Ollama', url: mock.url, apiKey: TEST_KEY });
    expect(await enqueue(fileId!, ollama.id)).toEqual({ enqueued: 1, skipped: NONE_SKIPPED });
    await h.until((s) => s.succeeded === 2);
    expect(ollamaChats()).toHaveLength(1);
    expect(await h.manager.read((s) => s.database.analyses.get(fileId!))).toMatchObject({ provider: OLLAMA_PROVIDER });
    expect(chatCompletions()).toHaveLength(1);

    const answer = await h.ok('analysis:describe', {
      requestId: REQUEST_ID,
      fileId: fileId!,
      model: MOCK_MODEL,
      providerId: openai.id,
    });
    expect(answer.ok).toBe(true);
    expect(answer.ok && answer.text.length).toBeGreaterThan(0);
    expect(chatCompletions()).toHaveLength(2);

    // Saved with thinking off, the next request carries the switch.
    await saveOpenAi({ id: openai.id, options: { ...DEFAULT_PROVIDER_OPTIONS, thinking: 'off' } });
    const [second] = await h.importImages(1);
    await enqueue(second!, openai.id);
    await h.until((s) => s.succeeded === 3);
    const last = chatCompletions().at(-1)!;
    expect(
      (last.body as { chat_template_kwargs?: { enable_thinking?: unknown } }).chat_template_kwargs?.enable_thinking,
    ).toBe(false);
    expect(last.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);

    for (const line of h.logs) {
      expect(line).not.toContain(TEST_KEY);
      expect(line).not.toContain(mock.url);
    }
    for (const response of h.responses) expect(response).not.toContain(TEST_KEY);
  });
});
