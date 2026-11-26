import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SetVisionSettings } from '@assetforge/contracts';
import { JobError, type VisionProvider } from '@assetforge/core';
import type { OllamaVisionOptions } from '@assetforge/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSettingsHandlers } from '../src/main/settings-handlers.js';
import { createVisionGateway } from '../src/main/vision-gateway.js';
import { createVisionSettingsStore, type VisionSettingsStore } from '../src/main/vision-settings.js';
import { FakeCodec } from './fake-codec.js';

const KEY = 'test-key-not-real';

let dir: string;
let settings: VisionSettingsStore;
let created: OllamaVisionOptions[];
let lines: string[];
let listCalls: number;
let listResult: () => Promise<{ name: string; vision: boolean | null }[]>;

function fakeCreate(options: OllamaVisionOptions): VisionProvider {
  created.push(options);
  return {
    analyzeImage: async () => ({}),
    describeImage: async () => '',
    listModels: async () => {
      listCalls++;
      return listResult();
    },
  };
}

const input = (o: Partial<SetVisionSettings> = {}): SetVisionSettings => ({
  baseUrl: 'http://192.168.1.20:11434',
  timeoutSeconds: 60,
  taggingModel: 'tagger',
  promptModel: null,
  ...o,
});

const gateway = () => createVisionGateway({ settings, create: fakeCreate, log: (l) => lines.push(l) });
const signal = () => new AbortController().signal;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-vision-gateway-'));
  settings = createVisionSettingsStore({ userData: dir, secrets: new FakeCodec(), env: {} });
  created = [];
  lines = [];
  listCalls = 0;
  listResult = async () => [{ name: 'tagger', vision: true }];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('vision gateway', () => {
  it('has no provider without a base URL', () => {
    expect(gateway().current()).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('builds one adapter from the settings and hands the key over as a function', () => {
    settings.save(input({ apiKey: KEY }));
    const g = gateway();
    const first = g.current();
    expect(first).not.toBeNull();
    expect(g.current()).toBe(first);
    expect(created).toHaveLength(1);
    const options = created[0]!;
    expect(options.baseUrl).toBe('http://192.168.1.20:11434');
    expect(options.timeoutMs).toBe(60_000);
    expect(typeof options.apiKey).toBe('function');
    expect(options.apiKey!()).toBe(KEY);
    expect(JSON.stringify(options)).not.toContain(KEY);
  });

  it('reads the key per call, so a deleted key is no longer sent', () => {
    settings.save(input({ apiKey: KEY }));
    gateway().current();
    const options = created[0]!;
    settings.save(input({ apiKey: null }));
    expect(options.apiKey!()).toBeNull();
  });

  it('builds a new adapter after a settings change', () => {
    settings.save(input());
    const g = gateway();
    const first = g.current();
    settings.save(input({ baseUrl: 'http://192.168.1.20:11434/v2', timeoutSeconds: 30 }));
    const second = g.current();
    expect(second).not.toBe(first);
    expect(created.map((o) => [o.baseUrl, o.timeoutMs])).toEqual([
      ['http://192.168.1.20:11434', 60_000],
      ['http://192.168.1.20:11434/v2', 30_000],
    ]);
    settings.save(input({ baseUrl: null }));
    expect(g.current()).toBeNull();
  });

  it('logs only the code and the status of a failure', () => {
    settings.save(input({ apiKey: KEY }));
    gateway().current();
    created[0]!.onFailure!('provider_unauthorized', 401);
    created[0]!.onFailure!('provider_unreachable', null);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('provider_unauthorized');
    expect(lines[0]).toContain('401');
    expect(lines[1]).toContain('provider_unreachable');
    for (const line of lines) {
      expect(line).not.toContain('192.168');
      expect(line).not.toContain(KEY);
      expect(line).not.toContain('null');
    }
  });

  it('caches the model list until a change or a refresh', async () => {
    settings.save(input());
    const g = gateway();
    expect(await g.models(false, signal())).toEqual({ ok: true, models: [{ name: 'tagger', vision: true }] });
    await g.models(false, signal());
    expect(listCalls).toBe(1);
    await g.models(true, signal());
    expect(listCalls).toBe(2);
    settings.save(input({ timeoutSeconds: 90 }));
    await g.models(false, signal());
    expect(listCalls).toBe(3);
  });

  it('answers provider_not_configured without a base URL', async () => {
    expect(await gateway().models(false, signal())).toEqual({ ok: false, code: 'provider_not_configured' });
    expect(listCalls).toBe(0);
  });

  it('turns a JobError into its code and does not cache the failure', async () => {
    settings.save(input());
    listResult = async () => {
      throw new JobError('provider_unauthorized');
    };
    const g = gateway();
    expect(await g.models(false, signal())).toEqual({ ok: false, code: 'provider_unauthorized' });
    listResult = async () => [{ name: 'x', vision: null }];
    expect(await g.models(false, signal())).toEqual({ ok: true, models: [{ name: 'x', vision: null }] });
    expect(listCalls).toBe(2);
  });

  it('rethrows anything that is not a JobError', async () => {
    settings.save(input());
    listResult = async () => {
      throw new Error('boom');
    };
    await expect(gateway().models(false, signal())).rejects.toThrow('boom');
  });

  it('does not cache a list that was started before a settings change', async () => {
    settings.save(input());
    let release!: () => void;
    listResult = () => new Promise((resolve) => (release = () => resolve([{ name: 'old', vision: true }])));
    const g = gateway();
    const pending = g.models(false, signal());
    settings.save(input({ baseUrl: 'http://192.168.1.21:11434' }));
    release();
    await pending;
    listResult = async () => [{ name: 'new', vision: true }];
    expect(await g.models(false, signal())).toEqual({ ok: true, models: [{ name: 'new', vision: true }] });
  });
});

describe('settings handlers', () => {
  it('serve the three settings channels', async () => {
    const h = createSettingsHandlers(settings, gateway());
    expect((await h['settings:getVision']({})).baseUrl).toBeNull();
    const saved = await h['settings:setVision'](input({ apiKey: KEY }));
    expect(saved).toMatchObject({ baseUrl: 'http://192.168.1.20:11434', hasApiKey: true });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(await h['settings:listVisionModels']({})).toEqual({ ok: true, models: [{ name: 'tagger', vision: true }] });
    await h['settings:listVisionModels']({ refresh: true });
    expect(listCalls).toBe(2);
  });
});
