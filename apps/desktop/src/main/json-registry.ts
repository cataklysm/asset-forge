import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkspaceRegistry } from '@assetforge/core';
import { WorkspaceSummarySchema, type WorkspaceSummary } from '@assetforge/contracts';

const WorkspaceListSchema = WorkspaceSummarySchema.array();

/** Workspace registry persisted as `{ "workspaces": [...] }` in a single JSON file. */
export class JsonWorkspaceRegistry implements WorkspaceRegistry {
  constructor(private readonly settingsFilePath: string) {}

  async list(): Promise<WorkspaceSummary[]> {
    return this.read();
  }

  async get(id: string): Promise<WorkspaceSummary | null> {
    return (await this.read()).find((w) => w.id === id) ?? null;
  }

  async upsert(entry: WorkspaceSummary): Promise<void> {
    const all = await this.read();
    const index = all.findIndex((w) => w.id === entry.id);
    if (index >= 0) all[index] = entry;
    else all.push(entry);
    await this.write(all);
  }

  async remove(id: string): Promise<void> {
    const all = await this.read();
    const kept = all.filter((w) => w.id !== id);
    if (kept.length !== all.length) await this.write(kept);
  }

  private async read(): Promise<WorkspaceSummary[]> {
    let text: string;
    try {
      text = await readFile(this.settingsFilePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed = parseList(text);
    if (parsed) return parsed;
    await this.quarantine();
    return [];
  }

  private async quarantine(): Promise<void> {
    // ISO timestamp without ':' (invalid in Windows file names).
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await rename(this.settingsFilePath, `${this.settingsFilePath}.corrupt-${stamp}`);
  }

  private async write(workspaces: WorkspaceSummary[]): Promise<void> {
    await mkdir(dirname(this.settingsFilePath), { recursive: true });
    const tmp = `${this.settingsFilePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify({ workspaces }, null, 2)}\n`, 'utf8');
      await rename(tmp, this.settingsFilePath);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }
}

function parseList(text: string): WorkspaceSummary[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || !('workspaces' in json)) return null;
  const result = WorkspaceListSchema.safeParse(json.workspaces);
  return result.success ? result.data : null;
}
