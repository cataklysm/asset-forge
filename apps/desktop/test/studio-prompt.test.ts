import {
  buildPromptVariables,
  PROMPT_VARIABLE_VALUE_MAX,
  type PromptDetail,
  type PromptVersion,
} from '@assetforge/contracts';
import { describe, expect, it } from 'vitest';
import { attach, preview } from '../src/renderer/src/studio-prompt.js';

const PROMPT_ID = '00000000-0000-4000-8000-0000000000b1';

function version(
  content: string,
  defaults: Record<string, string> = {},
  id = '00000000-0000-4000-8000-0000000000c1',
): PromptVersion {
  return {
    id,
    number: 1,
    content,
    variables: buildPromptVariables(content, defaults),
    createdAt: '2026-11-27T08:00:00.000Z',
  };
}

function detail(current: PromptVersion, versions: PromptVersion[] = [current]): PromptDetail {
  return {
    id: PROMPT_ID,
    title: 'Hero shot',
    description: '',
    tags: [],
    currentVersion: current,
    versions,
    updatedAt: current.createdAt,
    createdAt: current.createdAt,
  };
}

const none = () => undefined;

describe('attach', () => {
  it('takes a given value over a recalled one over the default, matching names regardless of case', () => {
    const v = version('A {{View}} of {{who}} in {{Place}}', { view: 'front', who: 'a hero', place: 'a field' });
    const recalled: Record<string, string> = { view: 'back', who: 'a villain' };
    const a = attach(detail(v), v, (name) => recalled[name.toLowerCase()], { VIEW: 'side' });
    expect(a.values).toEqual({ View: 'side', who: 'a villain', Place: 'a field' });
    expect(a).toMatchObject({ promptId: PROMPT_ID, title: 'Hero shot', version: v, currentVersionId: v.id });
  });

  it('records the current version of the detail, also when attaching an older one', () => {
    const older = version('A {{view}}', {}, '00000000-0000-4000-8000-0000000000c2');
    const current = { ...version('B {{view}}'), number: 2 };
    const a = attach(detail(current, [current, older]), older, none);
    expect(a.version).toBe(older);
    expect(a.currentVersionId).toBe(current.id);
    expect(a.values).toEqual({ view: '' });
  });
});

describe('preview', () => {
  it('replaces the filled variables and leaves the others as written', () => {
    const v = version('A {{view}} of {{who}}');
    const a = attach(detail(v), v, none, { view: 'side' });
    expect(preview(a)).toEqual({ text: 'A side of {{who}}', blocked: 'missing' });
  });

  it('a value over the limit blocks it', () => {
    const v = version('A {{view}}');
    const a = attach(detail(v), v, none, { view: 'x'.repeat(PROMPT_VARIABLE_VALUE_MAX + 1) });
    expect(preview(a).blocked).toBe('value_too_long');
    expect(preview(a).text).toBe('A {{view}}');
  });

  it('without variables it is the text and not blocked', () => {
    const v = version('Make it blue');
    expect(preview(attach(detail(v), v, none))).toEqual({ text: 'Make it blue', blocked: null });
  });

  it('with every variable filled it is the resolved text', () => {
    const v = version('A {{view}} of {{who}}', { who: 'a hero' });
    expect(preview(attach(detail(v), v, none, { view: ' side ' }))).toEqual({
      text: 'A side of a hero',
      blocked: null,
    });
  });
});
