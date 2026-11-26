export type View =
  | { name: 'assets' }
  | { name: 'asset'; id: string }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'inbox' }
  | { name: 'jobs' }
  | { name: 'settings' };
