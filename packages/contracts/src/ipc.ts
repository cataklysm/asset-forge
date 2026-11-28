import { z } from 'zod';
import type { IpcError } from './errors';
import { analysisChannels } from './ipc-analysis';
import { analysisPromptChannels } from './ipc-analysis-prompts';
import { assetChannels } from './ipc-assets';
import { changeChannels } from './ipc-changes';
import { dialogChannels } from './ipc-dialogs';
import { fileChannels } from './ipc-files';
import { generationChannels } from './ipc-generations';
import { importChannels } from './ipc-import';
import { jobChannels } from './ipc-jobs';
import { projectChannels } from './ipc-projects';
import { promptChannels } from './ipc-prompts';
import { providerChannels } from './ipc-providers';
import { siteChannels } from './ipc-sites';
import { tagChannels } from './ipc-tags';
import { trashChannels } from './ipc-trash';
import { workflowChannels } from './ipc-workflows';
import { workspaceChannels } from './ipc-workspace';

export { MAX_CHOSEN_IDS } from './ipc-shared';

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

export const ipcContract = {
  ...workspaceChannels,
  ...importChannels,
  ...siteChannels,
  ...fileChannels,
  ...trashChannels,
  ...assetChannels,
  ...projectChannels,
  ...tagChannels,
  ...workflowChannels,
  ...providerChannels,
  ...generationChannels,
  ...promptChannels,
  ...analysisPromptChannels,
  ...analysisChannels,
  ...jobChannels,
  ...changeChannels,
  ...dialogChannels,
} as const satisfies Record<string, { request: z.ZodType; response: z.ZodType }>;

export type IpcChannel = keyof typeof ipcContract;
export type IpcRequest<C extends IpcChannel> = z.infer<(typeof ipcContract)[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.infer<(typeof ipcContract)[C]['response']>;
