import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_WORDS, searchWords } from '../src/index.js';

describe('searchWords', () => {
  it('splits at non letters, digits and marks', () => {
    expect(searchWords('sci-fi')).toEqual(['sci', 'fi']);
    expect(searchWords('Café  "Sword"*')).toEqual(['café', 'sword']);
    expect(searchWords('"*-:')).toEqual([]);
    expect(searchWords('NEAR')).toEqual(['near']);
  });

  it('keeps at most 16 words', () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`);
    expect(MAX_SEARCH_WORDS).toBe(16);
    expect(searchWords(words.join(' '))).toEqual(words.slice(0, 16));
  });

  it('keeps a decomposed accent inside its word', () => {
    expect(searchWords('é')).toEqual(['é']);
    expect(searchWords('Café bar')).toEqual(['café', 'bar']);
  });
});
