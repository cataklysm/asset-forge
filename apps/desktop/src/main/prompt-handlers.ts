import {
  addPromptTag,
  createPrompt,
  deletePrompt,
  getPrompt,
  listPrompts,
  removePromptTag,
  savePromptVersion,
  updatePrompt,
  type WorkspaceManager,
} from '@assetforge/core';
import type { IpcHandlers } from './ipc.js';

// Kept free of Electron imports. The prompt library of the open workspace: reads bypass the serial queue, every
// write goes through `exclusive` because the use cases check before they write.

export type PromptHandlers = Pick<
  IpcHandlers,
  | 'prompts:list'
  | 'prompts:get'
  | 'prompts:create'
  | 'prompts:update'
  | 'prompts:saveVersion'
  | 'prompts:delete'
  | 'prompts:addTag'
  | 'prompts:removeTag'
>;

export function createPromptHandlers(manager: WorkspaceManager): PromptHandlers {
  return {
    'prompts:list': (r) => manager.read((s) => listPrompts(s, r)),
    'prompts:get': (r) => manager.read((s) => getPrompt(s, r.promptId)),
    'prompts:create': (r) => manager.exclusive((s) => createPrompt(s, r)),
    'prompts:update': (r) => manager.exclusive((s) => updatePrompt(s, r)),
    'prompts:saveVersion': (r) => manager.exclusive((s) => savePromptVersion(s, r)),
    'prompts:delete': async (r) => {
      await manager.exclusive((s) => deletePrompt(s, r.promptId));
      return {};
    },
    'prompts:addTag': (r) => manager.exclusive((s) => addPromptTag(s, r)),
    'prompts:removeTag': (r) => manager.exclusive((s) => removePromptTag(s, r)),
  };
}
