import type { Generation, ImageModel } from '@assetforge/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  constrain,
  formFromGeneration,
  readSafeMode,
  SAFE_MODE_KEY,
  tileState,
  writeSafeMode,
  type StudioForm,
} from '../src/renderer/src/studio-state.js';

/** The two edit models of the mock provider (`docker/mock-provider/server.mjs`). */
const MOCK_EDIT: ImageModel = {
  name: 'mock-edit',
  aspectRatios: ['1:1', '16:9', '9:16'],
  resolutions: ['1K', '2K', '4K'],
  defaultResolution: '1K',
  promptCharacterLimit: 1500,
  price: '$0.04',
};
const MOCK_EDIT_BASIC: ImageModel = {
  name: 'mock-edit-basic',
  aspectRatios: null,
  resolutions: null,
  defaultResolution: null,
  promptCharacterLimit: null,
  price: null,
};

const FORM: StudioForm = {
  providerId: 'p-1',
  model: 'mock-edit',
  prompt: 'make it blue',
  aspectRatio: null,
  resolution: null,
  safeMode: true,
  attached: null,
  origin: null,
};

const ID = '00000000-0000-4000-8000-0000000000a1';
const FILE = '00000000-0000-4000-8000-0000000000b1';

function generation(p: Partial<Generation> = {}): Generation {
  return {
    id: ID,
    kind: 'edit',
    status: 'succeeded',
    errorCode: null,
    providerId: 'p-2',
    providerName: 'Venice',
    providerKind: 'venice',
    model: 'mock-edit-basic',
    prompt: 'paint it red',
    parameters: { v: 1, aspectRatio: '16:9', resolution: '2K', safeMode: false },
    jobId: null,
    jobStatus: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    inputs: [{ fileId: FILE, name: 'a.png', sha256: 'a'.repeat(64), trashed: false }],
    outputs: [{ fileId: FILE, name: 'a edit 1.png', sha256: 'b'.repeat(64), trashed: false }],
    promptId: null,
    promptVersionId: null,
    promptTitle: null,
    promptVersionNumber: null,
    promptVariables: null,
    ...p,
  };
}

describe('constrain', () => {
  it('keeps the values mock-edit states and defaults the resolution', () => {
    expect(constrain({ ...FORM, aspectRatio: '16:9', resolution: '4K' }, MOCK_EDIT)).toMatchObject({
      aspectRatio: '16:9',
      resolution: '4K',
    });
    expect(constrain(FORM, MOCK_EDIT)).toMatchObject({ aspectRatio: null, resolution: '1K' });
  });

  it('drops values mock-edit does not state', () => {
    expect(constrain({ ...FORM, aspectRatio: '4:3', resolution: '8K' }, MOCK_EDIT)).toMatchObject({
      aspectRatio: null,
      resolution: '1K',
    });
  });

  it('drops every value for mock-edit-basic and without a model', () => {
    const form = { ...FORM, aspectRatio: '1:1', resolution: '1K' };
    expect(constrain(form, MOCK_EDIT_BASIC)).toMatchObject({ aspectRatio: null, resolution: null });
    expect(constrain(form, null)).toMatchObject({ aspectRatio: null, resolution: null });
  });

  it('leaves provider, model, prompt and safe mode alone', () => {
    const form = { ...FORM, safeMode: false };
    expect(constrain(form, MOCK_EDIT_BASIC)).toMatchObject({
      providerId: 'p-1',
      model: 'mock-edit',
      prompt: 'make it blue',
      safeMode: false,
    });
  });
});

describe('formFromGeneration', () => {
  it('copies provider, prompt, model, aspect ratio, resolution and safe mode of an edit', () => {
    expect(formFromGeneration(generation(), FORM)).toEqual({
      providerId: 'p-2',
      model: 'mock-edit-basic',
      prompt: 'paint it red',
      aspectRatio: '16:9',
      resolution: '2K',
      safeMode: false,
      attached: null,
      origin: null,
    });
  });

  it('returns the free text of a library prompt and drops an attached prompt and its origin', () => {
    const fromLibrary = generation({
      prompt: 'A side of a hero',
      promptId: '00000000-0000-4000-8000-0000000000c1',
      promptVersionId: '00000000-0000-4000-8000-0000000000c2',
      promptTitle: 'Hero shot',
      promptVersionNumber: 2,
      promptVariables: { view: 'side' },
    });
    const form = { ...FORM, origin: { promptId: '00000000-0000-4000-8000-0000000000c3', title: 'Other' } };
    expect(formFromGeneration(fromLibrary, form)).toMatchObject({ prompt: 'A side of a hero', attached: null, origin: null });
  });

  it('copies nothing but the provider of an upscale', () => {
    const upscale = generation({ kind: 'upscale', model: null, prompt: null, parameters: { v: 1, scale: 2 } });
    expect(formFromGeneration(upscale, FORM)).toEqual({ ...FORM, providerId: 'p-2' });
  });
});

describe('safe mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function memoryStorage(): Storage {
    const items = new Map<string, string>();
    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
      clear: () => items.clear(),
      key: () => null,
      get length() {
        return items.size;
      },
    };
  }

  it('defaults to true and remembers the choice', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    expect(readSafeMode()).toBe(true);
    writeSafeMode(false);
    expect(storage.getItem(SAFE_MODE_KEY)).toBe('false');
    expect(readSafeMode()).toBe(false);
    writeSafeMode(true);
    expect(readSafeMode()).toBe(true);
  });

  it('uses the key assetforge.studio.safeMode', () => {
    expect(SAFE_MODE_KEY).toBe('assetforge.studio.safeMode');
  });

  it('survives a throwing localStorage', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    vi.stubGlobal('localStorage', throwing);
    expect(readSafeMode()).toBe(true);
    expect(() => writeSafeMode(false)).not.toThrow();
  });

  it('survives a localStorage whose accessor throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('denied');
      },
    });
    try {
      expect(readSafeMode()).toBe(true);
      expect(() => writeSafeMode(false)).not.toThrow();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('tileState', () => {
  const pending = (jobStatus: Generation['jobStatus']) => generation({ status: 'pending', jobStatus, outputs: [] });

  it('shows a pending generation as queued or running by its job', () => {
    expect(tileState(pending('queued'))).toBe('queued');
    expect(tileState(pending('retry_wait'))).toBe('queued');
    expect(tileState(pending(null))).toBe('queued');
    expect(tileState(pending('running'))).toBe('running');
    expect(tileState(pending('waiting_remote'))).toBe('running');
  });

  it('shows failed and cancelled generations', () => {
    expect(tileState(generation({ status: 'failed', errorCode: 'provider_rejected', outputs: [] }))).toBe('failed');
    expect(tileState(generation({ status: 'cancelled', outputs: [] }))).toBe('cancelled');
  });

  it('shows a succeeded generation by its output', () => {
    expect(tileState(generation())).toBe('ready');
    const output = generation().outputs[0]!;
    expect(tileState(generation({ outputs: [{ ...output, trashed: true }] }))).toBe('trashed');
    expect(tileState(generation({ outputs: [{ ...output, fileId: null }] }))).toBe('deleted');
    expect(tileState(generation({ outputs: [] }))).toBe('deleted');
  });
});
