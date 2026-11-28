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
import type { IpcHandlers, IpcRequest, IpcResponse } from './ipc.js';

// Kept free of Electron imports. The prompt library of the open workspace: reads bypass the serial queue, every
// write goes through `exclusive` because the use cases check before they write.

/** The `prompts:*` channels. */
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

/**
 * Builds the `prompts:*` channels.
 *
 * @param manager the workspace manager
 * @returns one handler per channel
 */
export function createPromptHandlers(manager: WorkspaceManager): PromptHandlers {
  return {
    'prompts:list': (request) => manager.read((session) => listPrompts(session, request)),
    'prompts:get': (request) => manager.read((session) => getPrompt(session, request.promptId)),
    'prompts:create': (request) => manager.exclusive((session) => createPrompt(session, request)),
    'prompts:update': (request) => manager.exclusive((session) => updatePrompt(session, request)),
    'prompts:saveVersion': (request) => manager.exclusive((session) => savePromptVersion(session, request)),
    'prompts:delete': (request) => deletePromptOf(manager, request),
    'prompts:addTag': (request) => manager.exclusive((session) => addPromptTag(session, request)),
    'prompts:removeTag': (request) => manager.exclusive((session) => removePromptTag(session, request)),
  };
}

/**
 * Deletes a prompt with its versions and tag links.
 *
 * @param manager the workspace manager
 * @param request the prompt
 * @returns an empty answer
 */
async function deletePromptOf(
  manager: WorkspaceManager,
  request: IpcRequest<'prompts:delete'>,
): Promise<IpcResponse<'prompts:delete'>> {
  await manager.exclusive((session) => deletePrompt(session, request.promptId));
  return {};
}
