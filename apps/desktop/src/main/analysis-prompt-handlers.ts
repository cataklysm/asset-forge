import type { AnalysisPromptStore } from './analysis-prompts.js';
import type { IpcHandlers } from './ipc.js';

// Kept free of Electron imports. App-level analysis prompts: no open workspace is needed.

export type AnalysisPromptHandlers = Pick<
  IpcHandlers,
  'analysisPrompts:list' | 'analysisPrompts:save' | 'analysisPrompts:delete' | 'analysisPrompts:reset'
>;

export function createAnalysisPromptHandlers(store: AnalysisPromptStore): AnalysisPromptHandlers {
  return {
    'analysisPrompts:list': async () => store.list(),
    'analysisPrompts:save': async (r) => store.save(r),
    'analysisPrompts:delete': async (r) => {
      store.remove(r.id);
      return {};
    },
    'analysisPrompts:reset': async (r) => store.reset(r.id),
  };
}
