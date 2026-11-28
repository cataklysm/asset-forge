import { describe, expect, test } from 'vitest';
import {
  CreatePromptSchema,
  ListPromptsSchema,
  PromptDefaultsSchema,
  PromptDetailSchema,
  PromptPageSchema,
  PromptSummarySchema,
  PromptVariableSchema,
  PromptVersionSchema,
  SavePromptVersionSchema,
  UpdatePromptSchema,
} from '../src/index';

const id = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';
const now = '2026-11-27T10:00:00.000Z';
const version = {
  id,
  number: 1,
  content: 'A {{view}}',
  variables: [{ name: 'view', defaultValue: '' }],
  createdAt: now,
};
const summary = {
  id,
  title: 'T',
  description: '',
  tags: [{ name: 'x', displayName: 'X', origin: 'manual' }],
  currentVersion: version,
  updatedAt: now,
};

describe('prompt schemas', () => {
  test('each accepts a minimal valid object', () => {
    expect(PromptVariableSchema.safeParse({ name: 'a', defaultValue: '' }).success).toBe(true);
    expect(PromptVersionSchema.safeParse(version).success).toBe(true);
    expect(PromptSummarySchema.safeParse(summary).success).toBe(true);
    expect(PromptDetailSchema.safeParse({ ...summary, versions: [version], createdAt: now }).success).toBe(true);
    expect(PromptPageSchema.safeParse({ items: [summary], total: 1 }).success).toBe(true);
    expect(ListPromptsSchema.safeParse({ offset: 0, limit: 50 }).success).toBe(true);
    expect(CreatePromptSchema.safeParse({ title: 'T', description: '', content: 'c', defaults: {} }).success).toBe(
      true,
    );
    expect(UpdatePromptSchema.safeParse({ promptId: id, title: 'T', description: '' }).success).toBe(true);
    expect(
      SavePromptVersionSchema.safeParse({ promptId: id, baseVersionId: id, content: 'c', defaults: {} }).success,
    ).toBe(true);
  });

  test('defaults refuse 41 keys and a 2001-character value', () => {
    const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, 'v']));
    expect(PromptDefaultsSchema.safeParse(keys(40)).success).toBe(true);
    const many = PromptDefaultsSchema.safeParse(keys(41));
    expect(many.success).toBe(false);
    expect(many.error?.issues[0]?.message).toBe('At most 40 default values');
    expect(PromptDefaultsSchema.safeParse({ a: 'v'.repeat(2001) }).success).toBe(false);
    expect(PromptDefaultsSchema.safeParse({ a: 'v'.repeat(2000) }).success).toBe(true);
  });

  test('defaults carry keys that differ only by whitespace; the transport does not fold them', () => {
    expect(PromptDefaultsSchema.parse({ view: 'a', ' view ': 'b' })).toEqual({ view: 'a', ' view ': 'b' });
  });

  test('the list limit is 1 to 200', () => {
    expect(ListPromptsSchema.safeParse({ offset: 0, limit: 0 }).success).toBe(false);
    expect(ListPromptsSchema.safeParse({ offset: 0, limit: 201 }).success).toBe(false);
    expect(ListPromptsSchema.safeParse({ offset: 0, limit: 200 }).success).toBe(true);
  });
});
