import { describe, expect, test } from 'vitest';
import { buildPromptVariables, parsePromptVariables, resolvePromptText, variableKey } from '../src/index';

describe('parsePromptVariables', () => {
  test('keeps distinct names in order, in their first spelling', () => {
    expect(parsePromptVariables('A {{View}} of {{ view }} and {{pose-1}}')).toEqual(['View', 'pose-1']);
  });

  test('ignores malformed and over-long placeholders', () => {
    expect(parsePromptVariables('{{ }} {{a{{b}} {{x!}} {single} {{' + 'n'.repeat(41) + '}}')).toEqual(['b']);
  });

  test('finds a variable inside extra braces', () => {
    expect(parsePromptVariables('{{{a}}}')).toEqual(['a']);
  });

  test('accepts letters beyond ASCII and spaces', () => {
    expect(parsePromptVariables('{{Überschrift 2}}')).toEqual(['Überschrift 2']);
  });
});

describe('buildPromptVariables', () => {
  test('matches defaults regardless of case, drops others, fills missing with an empty string', () => {
    expect(buildPromptVariables('{{View}} {{pose}}', { view: 'front', gone: 'x' })).toEqual([
      { name: 'View', defaultValue: 'front' },
      { name: 'pose', defaultValue: '' },
    ]);
  });
});

describe('variableKey', () => {
  test('lower-cases', () => {
    expect(variableKey('ViEw')).toBe('view');
  });
});

describe('resolvePromptText', () => {
  const a = [{ name: 'a', defaultValue: '' }];

  test('replaces every occurrence and trims values', () => {
    expect(
      resolvePromptText('A {{View}}, again {{ view }}.', [{ name: 'View', defaultValue: '' }], { VIEW: '  side  ' }),
    ).toEqual({ ok: true, text: 'A side, again side.', values: { View: 'side' } });
  });

  test('substitutes in one pass only', () => {
    expect(resolvePromptText('{{a}}', a, { a: '{{a}} {{b}}' })).toEqual({
      ok: true,
      text: '{{a}} {{b}}',
      values: { a: '{{a}} {{b}}' },
    });
  });

  test('does not apply defaults', () => {
    expect(resolvePromptText('{{a}}', [{ name: 'a', defaultValue: 'd' }], {})).toEqual({ ok: false, reason: 'missing' });
  });

  test('whitespace counts as missing', () => {
    expect(resolvePromptText('{{a}}', a, { a: '   ' })).toEqual({ ok: false, reason: 'missing' });
  });

  test('a value for an unknown variable is refused', () => {
    expect(resolvePromptText('x', [], { a: 'v' })).toEqual({ ok: false, reason: 'unknown' });
  });

  test('two keys for one variable are refused', () => {
    expect(resolvePromptText('{{a}}', a, { a: 'v', A: 'w' })).toEqual({ ok: false, reason: 'unknown' });
  });

  test('a value over 2000 characters is refused', () => {
    expect(resolvePromptText('{{a}}', a, { a: 'v'.repeat(2001) })).toEqual({ ok: false, reason: 'value_too_long' });
  });

  test('text without variables is unchanged', () => {
    expect(resolvePromptText('no variables', [], {})).toEqual({ ok: true, text: 'no variables', values: {} });
  });
});
