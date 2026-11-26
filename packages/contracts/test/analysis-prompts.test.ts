import { describe, expect, test } from 'vitest';
import {
  ANALYSIS_TAG_LIMIT_DEFAULT,
  AnalysisPromptListSchema,
  AnalysisPromptNameSchema,
  AnalysisPromptSchema,
  AnalysisPromptTextSchema,
  AnalysisTagLimitSchema,
  AnalyzeFilePayloadSchema,
  ProposalViewSchema,
  SaveAnalysisPromptSchema,
  ipcContract,
} from '../src/index';

const id = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';

describe('analysis prompt fields', () => {
  test('a name is trimmed and holds 1 to 60 characters', () => {
    expect(AnalysisPromptNameSchema.parse('  General  ')).toBe('General');
    expect(AnalysisPromptNameSchema.safeParse('   ').success).toBe(false);
    expect(AnalysisPromptNameSchema.safeParse('a'.repeat(61)).success).toBe(false);
    expect(AnalysisPromptNameSchema.safeParse('a'.repeat(60)).success).toBe(true);
  });

  test('a text is trimmed and holds 1 to 8000 characters', () => {
    expect(AnalysisPromptTextSchema.safeParse(' \n ').success).toBe(false);
    expect(AnalysisPromptTextSchema.safeParse('a'.repeat(8001)).success).toBe(false);
    expect(AnalysisPromptTextSchema.safeParse('a'.repeat(8000)).success).toBe(true);
    expect(AnalysisPromptTextSchema.parse('Describe.\n\n')).toBe('Describe.');
  });

  test('a tag limit is an integer from 1 to 50', () => {
    expect(ANALYSIS_TAG_LIMIT_DEFAULT).toBe(15);
    expect(AnalysisTagLimitSchema.safeParse(1).success).toBe(true);
    expect(AnalysisTagLimitSchema.safeParse(50).success).toBe(true);
    expect(AnalysisTagLimitSchema.safeParse(0).success).toBe(false);
    expect(AnalysisTagLimitSchema.safeParse(51).success).toBe(false);
    expect(AnalysisTagLimitSchema.safeParse(2.5).success).toBe(false);
  });
});

describe('analysis prompts', () => {
  test('only a tagging prompt carries maxTags', () => {
    expect(AnalysisPromptSchema.safeParse({ id, purpose: 'tagging', name: 'General', text: 'x', maxTags: 15 }).success).toBe(true);
    expect(AnalysisPromptSchema.safeParse({ id, purpose: 'tagging', name: 'General', text: 'x' }).success).toBe(false);
    expect(AnalysisPromptSchema.safeParse({ id, purpose: 'image_prompt', name: 'Scene', text: 'x' }).success).toBe(true);
    expect(AnalysisPromptSchema.safeParse({ id: 'nope', purpose: 'image_prompt', name: 'Scene', text: 'x' }).success).toBe(false);
  });

  test('a save without an id creates, a tagging save needs maxTags', () => {
    expect(SaveAnalysisPromptSchema.safeParse({ purpose: 'tagging', name: 'General', text: 'x' }).success).toBe(false);
    expect(SaveAnalysisPromptSchema.safeParse({ purpose: 'tagging', name: 'General', text: 'x', maxTags: 15 }).success).toBe(true);
    expect(SaveAnalysisPromptSchema.safeParse({ purpose: 'image_prompt', name: 'Scene', text: 'x' }).success).toBe(true);
    expect(SaveAnalysisPromptSchema.safeParse({ id, purpose: 'image_prompt', name: 'Scene', text: 'x' }).success).toBe(true);
  });

  test('a list carries the prompts and the ones used last', () => {
    const prompts = [{ id, purpose: 'tagging', name: 'General', text: 'x', maxTags: 15 }];
    expect(AnalysisPromptListSchema.safeParse({ prompts, lastUsed: { tagging: id, imagePrompt: null } }).success).toBe(true);
    expect(AnalysisPromptListSchema.safeParse({ prompts, lastUsed: { tagging: id } }).success).toBe(false);
  });
});

describe('analysis payload v3', () => {
  test('v1, v2 and v3 parse; v3 needs its prompt', () => {
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 1 }).success).toBe(true);
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 2, model: 'm', mode: 'propose' }).success).toBe(true);
    const v3 = { version: 3, model: 'm', mode: 'apply', prompt: { name: 'General', text: 'x', maxTags: 15 } };
    expect(AnalyzeFilePayloadSchema.safeParse(v3).success).toBe(true);
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 3, model: 'm', mode: 'apply' }).success).toBe(false);
  });
});

describe('proposal view with a prompt name', () => {
  const tags = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `tag ${i}`, displayName: `tag ${i}` }));
  const view = { model: 'qwen', promptName: null, createdAt: '2026-11-26T10:00:00.000Z', stale: false };

  test('holds up to 50 tags and a nullable prompt name', () => {
    expect(ProposalViewSchema.safeParse({ ...view, tags: tags(50) }).success).toBe(true);
    expect(ProposalViewSchema.safeParse({ ...view, promptName: 'General', tags: tags(1) }).success).toBe(true);
    expect(ProposalViewSchema.safeParse({ ...view, tags: tags(51) }).success).toBe(false);
  });

  test('accepting a proposal takes up to 50 names', () => {
    const request = ipcContract['analysis:acceptProposal'].request;
    expect(request.safeParse({ fileId: id, names: Array.from({ length: 50 }, (_, i) => `t${i}`) }).success).toBe(true);
    expect(request.safeParse({ fileId: id, names: Array.from({ length: 51 }, (_, i) => `t${i}`) }).success).toBe(false);
  });

  test('enqueue and describe take an optional prompt id', () => {
    const enqueue = ipcContract['analysis:enqueue'].request;
    const base = { target: { kind: 'files', fileIds: [id] }, model: 'm', mode: 'apply', force: false };
    expect(enqueue.safeParse(base).success).toBe(true);
    expect(enqueue.safeParse({ ...base, promptId: id }).success).toBe(true);
    expect(enqueue.safeParse({ ...base, promptId: 'nope' }).success).toBe(false);
    const describeRequest = ipcContract['analysis:describe'].request;
    expect(describeRequest.safeParse({ requestId: id, fileId: id, model: 'm', promptId: id }).success).toBe(true);
    expect(describeRequest.safeParse({ requestId: id, fileId: id, model: 'm', promptId: 'nope' }).success).toBe(false);
  });
});
