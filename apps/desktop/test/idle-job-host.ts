import type { HostActions } from '../src/main/ipc.js';
import type { JobHost } from '../src/main/job-host.js';

/** A job host that never runs a job, for tests that do not exercise jobs. */
export const idleJobHost: JobHost = {
  workspaceOpened: async () => {},
  workspaceClosing: async () => {},
  changes: () => 0,
  changed: () => {},
  wake: () => {},
  cancel: async () => {},
};

/** Host actions that do nothing. */
export const noopHost: HostActions = {
  openPath: async () => '',
  showItemInFolder: () => {},
  workspaceOpened: async () => {},
  workspaceClosing: async () => {},
};
