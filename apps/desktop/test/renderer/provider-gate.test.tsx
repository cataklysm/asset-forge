import { JOB_ERROR_MESSAGES, type ImageModel, type ListImageModelsResult, type ListModelsResult } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import {
  CHOOSE_MODEL,
  CHOOSE_PROMPT,
  MODEL_NOT_LISTED,
  MODEL_NOT_VISION,
  NO_VISION_MODEL,
  PROMPTS_LOAD_FAILED,
  PROVIDER_CHECKING,
  PROVIDER_STATE_LABELS,
  SETTINGS_LOAD_FAILED,
  START_LOADING,
} from '../../src/renderer/src/labels';
import type { ProvidersState } from '../../src/renderer/src/provider-context';
import { imageProviderGate, promptGate, providerGate } from '../../src/renderer/src/provider-gate';
import { providerView } from './fake-api';
import { imagePrompt, taggingPrompt } from './fixtures';

const TAGGING = taggingPrompt();
const IMAGE = imagePrompt();
const LOADED = { prompts: [TAGGING, IMAGE], loading: false, failed: false };

it('a failed load blocks with its own message', () => {
  expect(promptGate({ prompts: null, loading: false, failed: true }, TAGGING.id)).toBe(PROMPTS_LOAD_FAILED);
  expect(promptGate({ prompts: null, loading: true, failed: true }, null)).toBe(PROMPTS_LOAD_FAILED);
});

it('prompts not loaded yet block as loading', () => {
  expect(promptGate({ prompts: null, loading: true, failed: false }, null)).toBe(START_LOADING);
  expect(promptGate({ prompts: null, loading: false, failed: false }, TAGGING.id)).toBe(START_LOADING);
});

it('no prompt, or one not in the list, asks for a choice', () => {
  expect(promptGate(LOADED, null)).toBe(CHOOSE_PROMPT);
  expect(promptGate(LOADED, '00000000-0000-4000-8000-00000000dead')).toBe(CHOOSE_PROMPT);
  expect(CHOOSE_PROMPT).toBe('Choose a prompt');
});

it('a listed prompt lets the start go ahead', () => {
  expect(promptGate(LOADED, TAGGING.id)).toBeNull();
  expect(promptGate({ ...LOADED, loading: true }, IMAGE.id)).toBeNull();
});

// --- provider gate, per selected entry ---

const LOCAL = providerView({ name: 'Local' });
const RUNPOD = providerView({ name: 'RunPod' });
const LISTED: ListModelsResult = {
  ok: true,
  models: [
    { name: 'vision-a', vision: true },
    { name: 'text-only', vision: false },
  ],
};

function gateState(models: Record<string, ListModelsResult | undefined>, p: Partial<ProvidersState> = {}) {
  return {
    list: { providers: [LOCAL, RUNPOD], lastUsedId: null, lastUsedImageId: null, fromEnvironment: false, canStoreKey: true },
    models,
    imageModels: {},
    loading: false,
    failed: false,
    ...p,
  };
}

it('a listed vision model of the selected entry lets the start go ahead', () => {
  expect(providerGate(gateState({ [LOCAL.id]: LISTED }), LOCAL.id, 'vision-a')).toEqual({ blocked: null, offerSettings: false });
});

it('an entry still being asked blocks as checking', () => {
  expect(PROVIDER_CHECKING).toBe('The provider is being checked');
  expect(providerGate(gateState({ [RUNPOD.id]: LISTED }), LOCAL.id, 'vision-a')).toEqual({
    blocked: PROVIDER_CHECKING,
    offerSettings: false,
  });
});

it('the gate follows the selected entry, not another one', () => {
  const s = gateState({ [LOCAL.id]: LISTED, [RUNPOD.id]: { ok: false, code: 'provider_unreachable' } });
  expect(providerGate(s, LOCAL.id, 'vision-a').blocked).toBeNull();
  expect(providerGate(s, RUNPOD.id, 'vision-a').blocked).toBe(JOB_ERROR_MESSAGES.provider_unreachable);
});

it('an unreachable entry blocks with the message of its code', () => {
  for (const code of ['provider_unreachable', 'provider_timeout', 'provider_unavailable'] as const) {
    const gate = providerGate(gateState({ [LOCAL.id]: { ok: false, code } }), LOCAL.id, 'vision-a');
    expect(gate).toEqual({ blocked: JOB_ERROR_MESSAGES[code], offerSettings: false });
  }
  // Nothing to choose from without a model: the settings are the way out.
  expect(providerGate(gateState({ [LOCAL.id]: { ok: false, code: 'provider_timeout' } }), LOCAL.id, null).offerSettings).toBe(true);
});

it('a refused key blocks and offers the settings', () => {
  expect(providerGate(gateState({ [LOCAL.id]: { ok: false, code: 'provider_unauthorized' } }), LOCAL.id, 'vision-a')).toEqual({
    blocked: JOB_ERROR_MESSAGES.provider_unauthorized,
    offerSettings: true,
  });
});

it('an entry without vision models blocks and offers the settings', () => {
  const s = gateState({ [LOCAL.id]: { ok: true, models: [{ name: 'text-only', vision: false }] } });
  expect(providerGate(s, LOCAL.id, 'text-only')).toEqual({ blocked: NO_VISION_MODEL, offerSettings: true });
});

it('a model missing from the entry list, one without vision, or none blocks', () => {
  const s = gateState({ [LOCAL.id]: LISTED });
  expect(providerGate(s, LOCAL.id, 'gone-model')).toEqual({ blocked: MODEL_NOT_LISTED, offerSettings: false });
  expect(providerGate(s, LOCAL.id, 'text-only')).toEqual({ blocked: MODEL_NOT_VISION, offerSettings: false });
  expect(providerGate(s, LOCAL.id, null)).toEqual({ blocked: CHOOSE_MODEL, offerSettings: false });
});

it('no entry selected, or one not listed, is the not-configured state with Settings', () => {
  const s = gateState({ [LOCAL.id]: LISTED });
  const notConfigured = { blocked: JOB_ERROR_MESSAGES.provider_not_configured, offerSettings: true };
  expect(providerGate(s, null, 'vision-a')).toEqual(notConfigured);
  expect(providerGate(s, '00000000-0000-4000-8000-00000000dead', 'vision-a')).toEqual(notConfigured);
  expect(
    providerGate(gateState({}, { list: { providers: [], lastUsedId: null, lastUsedImageId: null, fromEnvironment: false, canStoreKey: true } }), null, null),
  ).toEqual(
    notConfigured,
  );
});

it('a failed list load blocks with its own message and offers the settings', () => {
  expect(providerGate(gateState({}, { list: null, failed: true }), null, null)).toEqual({
    blocked: SETTINGS_LOAD_FAILED,
    offerSettings: true,
  });
});

it('a list not loaded yet blocks as loading', () => {
  expect(providerGate(gateState({}, { list: null, loading: true }), null, null)).toEqual({
    blocked: START_LOADING,
    offerSettings: false,
  });
  expect(providerGate(gateState({}, { list: null, loading: true, failed: true }), null, null).blocked).toBe(START_LOADING);
});

// --- image provider gate ---

const VENICE = providerView({ kind: 'venice', name: 'Venice', taggingModel: null, promptModel: null, editModel: 'edit-a' });
const editModel = (name: string): ImageModel => ({
  name,
  aspectRatios: null,
  resolutions: null,
  defaultResolution: null,
  promptCharacterLimit: null,
  price: null,
});
const EDIT_LISTED: ListImageModelsResult = { ok: true, models: [editModel('edit-a')] };

function imageState(imageModels: ProvidersState['imageModels'], p: Partial<ProvidersState> = {}) {
  return gateState({}, { list: { providers: [LOCAL, VENICE], lastUsedId: null, lastUsedImageId: null, fromEnvironment: false, canStoreKey: true }, imageModels, ...p });
}

it('a listed edit model of the selected image entry lets the start go ahead', () => {
  expect(imageProviderGate(imageState({ [VENICE.id]: EDIT_LISTED }), VENICE.id, 'edit-a')).toEqual({ blocked: null, offerSettings: false });
});

it('an image entry still being asked blocks as checking', () => {
  expect(imageProviderGate(imageState({}), VENICE.id, 'edit-a')).toEqual({ blocked: PROVIDER_CHECKING, offerSettings: false });
  expect(imageProviderGate(imageState({ [VENICE.id]: 'checking' }), VENICE.id, 'edit-a')).toEqual({
    blocked: PROVIDER_CHECKING,
    offerSettings: false,
  });
});

it('a failed image list blocks with the message of its code', () => {
  expect(imageProviderGate(imageState({ [VENICE.id]: { ok: false, code: 'provider_unreachable' } }), VENICE.id, 'edit-a')).toEqual({
    blocked: JOB_ERROR_MESSAGES.provider_unreachable,
    offerSettings: false,
  });
  expect(imageProviderGate(imageState({ [VENICE.id]: { ok: false, code: 'provider_unauthorized' } }), VENICE.id, 'edit-a')).toEqual({
    blocked: JOB_ERROR_MESSAGES.provider_unauthorized,
    offerSettings: true,
  });
});

it('an image entry without edit models blocks and offers the settings', () => {
  expect(imageProviderGate(imageState({ [VENICE.id]: { ok: true, models: [] } }), VENICE.id, null)).toEqual({
    blocked: PROVIDER_STATE_LABELS.no_edit_model,
    offerSettings: true,
  });
});

it('an edit model missing from the list, or none, blocks', () => {
  const s = imageState({ [VENICE.id]: EDIT_LISTED });
  expect(imageProviderGate(s, VENICE.id, 'gone')).toEqual({ blocked: MODEL_NOT_LISTED, offerSettings: false });
  expect(imageProviderGate(s, VENICE.id, null)).toEqual({ blocked: CHOOSE_MODEL, offerSettings: false });
});

it('each gate treats an entry of the other kind as not configured', () => {
  const notConfigured = { blocked: JOB_ERROR_MESSAGES.provider_not_configured, offerSettings: true };
  const s = imageState({ [VENICE.id]: EDIT_LISTED }, { models: { [LOCAL.id]: LISTED } });
  expect(imageProviderGate(s, LOCAL.id, 'vision-a')).toEqual(notConfigured);
  expect(imageProviderGate(s, null, null)).toEqual(notConfigured);
  expect(providerGate(s, VENICE.id, 'edit-a')).toEqual(notConfigured);
  expect(providerGate(s, LOCAL.id, 'vision-a').blocked).toBeNull();
});

it('the image gate shares the list load states', () => {
  expect(imageProviderGate(imageState({}, { list: null, failed: true }), null, null)).toEqual({ blocked: SETTINGS_LOAD_FAILED, offerSettings: true });
  expect(imageProviderGate(imageState({}, { list: null, loading: true }), null, null)).toEqual({ blocked: START_LOADING, offerSettings: false });
});
