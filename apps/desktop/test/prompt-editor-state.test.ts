import { describe, expect, it } from 'vitest';
import type { PromptDetail, PromptVersion } from '@assetforge/contracts';
import {
  draftOf,
  metaDirty,
  variablesOf,
  versionDirty,
  type EditorDraft,
} from '../src/renderer/src/prompt-editor-state.js';

const VERSION_ID = '00000000-0000-4000-8000-000000000001';
const OLD_VERSION_ID = '00000000-0000-4000-8000-000000000002';

function version(p: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: VERSION_ID,
    number: 2,
    content: 'A {{view}} of a {{Subject}}',
    variables: [
      { name: 'view', defaultValue: 'front' },
      { name: 'Subject', defaultValue: '' },
    ],
    createdAt: '2026-11-27T10:00:00.000Z',
    ...p,
  };
}

function detail(p: Partial<PromptDetail> = {}): PromptDetail {
  const current = p.currentVersion ?? version();
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    title: 'Hero shot',
    description: 'For the shop',
    tags: [],
    currentVersion: current,
    updatedAt: current.createdAt,
    createdAt: '2026-11-26T10:00:00.000Z',
    versions: [
      current,
      version({ id: OLD_VERSION_ID, number: 1, content: 'Old {{x}}', variables: [{ name: 'x', defaultValue: 'y' }] }),
    ],
    ...p,
  };
}

const draft = (d: Partial<EditorDraft> = {}): EditorDraft => ({ ...draftOf(detail()), ...d });

describe('draftOf', () => {
  it('takes title, description and the current version', () => {
    expect(draftOf(detail())).toEqual({
      title: 'Hero shot',
      description: 'For the shop',
      content: 'A {{view}} of a {{Subject}}',
      defaults: { view: 'front', Subject: '' },
    });
  });

  it('takes the text and defaults of another version when given', () => {
    const d = detail();
    expect(draftOf(d, d.versions[1])).toMatchObject({ title: 'Hero shot', content: 'Old {{x}}', defaults: { x: 'y' } });
  });
});

describe('variablesOf', () => {
  it('follows the text as it is typed', () => {
    expect(variablesOf(draft({ content: 'A {{vi', defaults: {} }))).toEqual([]);
    expect(variablesOf(draft({ content: 'A {{view}}', defaults: {} }))).toEqual([{ name: 'view', defaultValue: '' }]);
    expect(variablesOf(draft({ content: 'A {{view}} {{light}}', defaults: { view: 'front' } }))).toEqual([
      { name: 'view', defaultValue: 'front' },
      { name: 'light', defaultValue: '' },
    ]);
  });

  it('keeps a default typed for View when the text now says {{view}}', () => {
    expect(variablesOf(draft({ content: 'A {{view}}', defaults: { View: 'side' } }))).toEqual([
      { name: 'view', defaultValue: 'side' },
    ]);
  });
});

describe('versionDirty', () => {
  it('is false for the loaded version', () => {
    expect(versionDirty(draftOf(detail()), detail())).toBe(false);
  });

  it('is false for a text differing only in surrounding whitespace', () => {
    expect(versionDirty(draft({ content: '  A {{view}} of a {{Subject}}\n' }), detail())).toBe(false);
  });

  it('is false for a default of a removed variable', () => {
    expect(versionDirty(draft({ defaults: { view: 'front', Subject: '', gone: 'kept' } }), detail())).toBe(false);
  });

  it('is true for a changed default', () => {
    expect(versionDirty(draft({ defaults: { view: 'side', Subject: '' } }), detail())).toBe(true);
  });

  it('is true for a changed text', () => {
    expect(versionDirty(draft({ content: 'A {{view}}' }), detail())).toBe(true);
  });
});

describe('metaDirty', () => {
  it('ignores surrounding whitespace', () => {
    expect(metaDirty(draft({ title: '  Hero shot ', description: 'For the shop\n' }), detail())).toBe(false);
  });

  it('is true for a changed title or description', () => {
    expect(metaDirty(draft({ title: 'Hero' }), detail())).toBe(true);
    expect(metaDirty(draft({ description: '' }), detail())).toBe(true);
  });
});
