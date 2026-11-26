import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VISION_BASE_URL, DEFAULT_VISION_MODEL, readVisionConfig } from '../src/main/vision-config.js';

describe('readVisionConfig', () => {
  it('uses the mock defaults without environment variables', () => {
    const warn = vi.fn();
    expect(readVisionConfig({}, warn)).toEqual({ baseUrl: 'http://127.0.0.1:11500', model: 'mock-vision' });
    expect(DEFAULT_VISION_BASE_URL).toBe('http://127.0.0.1:11500');
    expect(DEFAULT_VISION_MODEL).toBe('mock-vision');
    expect(warn).not.toHaveBeenCalled();
  });

  it('takes a valid URL without its trailing slash and the given model', () => {
    const warn = vi.fn();
    expect(
      readVisionConfig({ ASSETFORGE_VISION_BASE_URL: 'https://host:1234/', ASSETFORGE_VISION_MODEL: 'qwen3.5:9b' }, warn),
    ).toEqual({ baseUrl: 'https://host:1234', model: 'qwen3.5:9b' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the default model for an empty one', () => {
    expect(readVisionConfig({ ASSETFORGE_VISION_MODEL: '' }).model).toBe('mock-vision');
    expect(readVisionConfig({ ASSETFORGE_VISION_MODEL: '   ' }).model).toBe('mock-vision');
  });

  it('keeps a path base URL without its trailing slash', () => {
    const warn = vi.fn();
    expect(readVisionConfig({ ASSETFORGE_VISION_BASE_URL: 'http://h/base/' }, warn).baseUrl).toBe('http://h/base');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['', 'nonsense', 'file:///x', 'http://user:secret@host', 'http://:secret@host', 'http://h/?k=secret', 'http://h/#x'])(
    'falls back to the default for %j and warns without the value',
    (value) => {
      const warn = vi.fn<(message: string) => void>();
      expect(readVisionConfig({ ASSETFORGE_VISION_BASE_URL: value }, warn).baseUrl).toBe(DEFAULT_VISION_BASE_URL);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0]![0];
      expect(message).not.toContain('secret');
      if (value !== '') expect(message).not.toContain(value);
    },
  );
});
