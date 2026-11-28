import { describe, expect, it } from 'vitest';
import * as visionConfig from '../src/main/vision-config.js';

const { usableBaseUrl } = visionConfig;

describe('usableBaseUrl', () => {
  it('takes a valid URL without its trailing slash', () => {
    expect(usableBaseUrl('https://host:1234/')).toBe('https://host:1234');
    expect(usableBaseUrl('http://h/base/')).toBe('http://h/base');
  });

  it.each([
    '',
    'nonsense',
    'file:///x',
    'http://user:secret@host',
    'http://:secret@host',
    'http://h/?k=secret',
    'http://h/#x',
    'http://h/?',
    'http://h/#',
  ])('refuses %j', (value) => {
    expect(usableBaseUrl(value)).toBeNull();
  });

  it('has no default base URL or model any more', () => {
    expect(Object.keys(visionConfig)).toEqual(['usableBaseUrl']);
  });
});
