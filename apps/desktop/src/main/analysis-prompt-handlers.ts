import type { AnalysisPromptStore } from './analysis-prompts.js';
import type { IpcHandlers } from './ipc.js';

// Kept free of Electron imports. App-level analysis prompts: no open workspace is needed.

/** The `analysisPrompts:*` channels. */
export type AnalysisPromptHandlers = Pick<
  IpcHandlers,
  'analysisPrompts:list' | 'analysisPrompts:save' | 'analysisPrompts:delete' | 'analysisPrompts:reset'
>;

/**
 * Builds the `analysisPrompts:*` channels.
 *
 * @param store the analysis prompts
 * @returns one handler per channel
 */
export function createAnalysisPromptHandlers(store: AnalysisPromptStore): AnalysisPromptHandlers {
  return {
    'analysisPrompts:list': async () => store.list(),
    'analysisPrompts:save': async (request) => store.save(request),
    'analysisPrompts:delete': async (request) => {
      store.remove(request.id);
      return {};
    },
    'analysisPrompts:reset': async (request) => store.reset(request.id),
  };
}
