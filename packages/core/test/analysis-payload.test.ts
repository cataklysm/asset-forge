import { describe, expect, it } from 'vitest';
import { adoptForProvider, rewriteForProvider } from '../src/index.js';

const PROMPT = { name: 'Detail', text: 'Look at the armour.', maxTags: 7 };
const TO = { name: 'RunPod', model: 'qwen:9b' };

describe('rewriteForProvider', () => {
  it('turns a v1 payload into v4 apply without a prompt', () => {
    expect(rewriteForProvider({ version: 1 }, TO)).toEqual({
      version: 4,
      model: 'qwen:9b',
      mode: 'apply',
      prompt: null,
      providerName: 'RunPod',
    });
  });

  it('turns a v2 payload into v4 with prompt null and keeps the mode', () => {
    expect(rewriteForProvider({ version: 2, model: 'old', mode: 'propose' }, TO)).toEqual({
      version: 4,
      model: 'qwen:9b',
      mode: 'propose',
      prompt: null,
      providerName: 'RunPod',
    });
  });

  it('keeps the prompt object and mode propose of a v3 payload', () => {
    expect(rewriteForProvider({ version: 3, model: 'old', mode: 'propose', prompt: PROMPT }, TO)).toEqual({
      version: 4,
      model: 'qwen:9b',
      mode: 'propose',
      prompt: PROMPT,
      providerName: 'RunPod',
    });
  });

  it('replaces name and model of a v4 payload and keeps its prompt', () => {
    expect(rewriteForProvider({ version: 4, model: 'old', mode: 'apply', prompt: PROMPT, providerName: 'Local' }, TO)).toEqual({
      version: 4,
      model: 'qwen:9b',
      mode: 'apply',
      prompt: PROMPT,
      providerName: 'RunPod',
    });
    expect(rewriteForProvider({ version: 4, model: 'old', mode: 'apply', prompt: null, providerName: 'Local' }, TO)).toMatchObject({ prompt: null });
  });
});

describe('adoptForProvider', () => {
  const entry = { name: 'Ollama', taggingModel: 'llava:13b' };

  it('gives a v1 payload the tagging model of the entry', () => {
    expect(adoptForProvider({ version: 1 }, entry)).toEqual({
      version: 4,
      model: 'llava:13b',
      mode: 'apply',
      prompt: null,
      providerName: 'Ollama',
    });
  });

  it('leaves a v1 payload alone without a tagging model', () => {
    expect(adoptForProvider({ version: 1 }, { name: 'Ollama', taggingModel: null })).toBeNull();
  });

  it('keeps the model and mode of a v2 payload, with prompt null', () => {
    expect(adoptForProvider({ version: 2, model: 'own', mode: 'propose' }, { name: 'Ollama', taggingModel: null })).toEqual({
      version: 4,
      model: 'own',
      mode: 'propose',
      prompt: null,
      providerName: 'Ollama',
    });
  });

  it('keeps the model, mode and prompt of a v3 payload', () => {
    expect(adoptForProvider({ version: 3, model: 'own', mode: 'apply', prompt: PROMPT }, entry)).toEqual({
      version: 4,
      model: 'own',
      mode: 'apply',
      prompt: PROMPT,
      providerName: 'Ollama',
    });
  });

  it('leaves a payload that does not parse alone', () => {
    expect(adoptForProvider('x', entry)).toBeNull();
    expect(adoptForProvider({ version: 2 }, entry)).toBeNull();
  });
});
