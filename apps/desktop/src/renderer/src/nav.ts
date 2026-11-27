export type View =
  | { name: 'assets' }
  | { name: 'asset'; id: string }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'prompts'; id?: string }
  | { name: 'inbox' }
  | { name: 'trash' }
  | { name: 'jobs' }
  | { name: 'settings' };
