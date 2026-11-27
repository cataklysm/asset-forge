import { describe, expect, it } from 'vitest';
import { formatBytes, shortUrl } from '../src/renderer/src/format.js';

describe('formatBytes', () => {
  it.each([
    [null, '–'],
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [1572864, '1.5 MiB'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});

describe('shortUrl', () => {
  it.each([
    ['https://example.com/packs/rock.png?x=1', 'example.com/rock.png'],
    ['https://example.com/', 'example.com'],
    ['https://cdn.example.com:8443/a/rock%20moss.png', 'cdn.example.com:8443/rock moss.png'],
    ['https://example.com/bad%E0%A4%A.png', 'example.com/bad%E0%A4%A.png'],
  ])('shortens %s to %s', (input, expected) => {
    expect(shortUrl(input)).toBe(expected);
  });

  it('keeps a segment encoded when decoding would yield a control or format character', () => {
    // U+202E (right-to-left override) would reorder the shown text; U+0007 is a control character.
    expect(shortUrl('https://example.com/gnp.%E2%80%AEexe')).toBe('example.com/gnp.%E2%80%AEexe');
    expect(shortUrl('https://example.com/a%07b.png')).toBe('example.com/a%07b.png');
    expect(shortUrl('https://example.com/a%E2%80%8Bb.png')).toBe('example.com/a%E2%80%8Bb.png');
  });

  it('cuts at 60 characters without splitting a surrogate pair', () => {
    // 'example.com/' is 12 characters; 47 letters put the emoji across the 60th UTF-16 unit.
    const segment = `${'a'.repeat(47)}%F0%9F%98%80tail.png`;
    const short = shortUrl(`https://example.com/${segment}`);
    expect(short).toBe(`example.com/${'a'.repeat(47)}😀`);
    expect(Array.from(short)).toHaveLength(60);
  });

  it('cuts an address that does not parse to 60 characters', () => {
    const text = `not a url ${'b'.repeat(80)}`;
    expect(shortUrl(text)).toBe(text.slice(0, 60));
  });
});
