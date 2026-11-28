import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkspaceRegistry } from '@assetforge/core';
import { WorkspaceSummarySchema, type WorkspaceSummary } from '@assetforge/contracts';

const WorkspaceListSchema = WorkspaceSummarySchema.array();

/** Workspace registry persisted as `{ "workspaces": [...] }` in a single JSON file. */
export class JsonWorkspaceRegistry implements WorkspaceRegistry {
  /** @param settingsFilePath the JSON file */
  constructor(private readonly settingsFilePath: string) {}

  /** @returns every registered workspace */
  async list(): Promise<WorkspaceSummary[]> {
    return this.read();
  }

  /**
   * @param id the workspace
   * @returns the workspace, or null
   */
  async get(id: string): Promise<WorkspaceSummary | null> {
    return (await this.read()).find((workspace) => workspace.id === id) ?? null;
  }

  /**
   * Adds a workspace or replaces the one with the same id.
   *
   * @param entry the workspace
   * @returns when it was written
   */
  async upsert(entry: WorkspaceSummary): Promise<void> {
    const all = await this.read();
    const index = all.findIndex((workspace) => workspace.id === entry.id);
    if (index >= 0) all[index] = entry;
    else all.push(entry);
    await this.write(all);
  }

  /**
   * Removes a workspace; an unknown id writes nothing.
   *
   * @param id the workspace
   * @returns when it was written
   */
  async remove(id: string): Promise<void> {
    const all = await this.read();
    const kept = all.filter((workspace) => workspace.id !== id);
    if (kept.length !== all.length) await this.write(kept);
  }

  /**
   * Reads the file; a missing one reads as empty, an unreadable one is set aside and reads as empty.
   *
   * @returns the workspaces
   */
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

  /**
   * Moves the unreadable file aside under a stamped name.
   *
   * @returns when it was moved
   */
  private async quarantine(): Promise<void> {
    // ISO timestamp without ':' (invalid in Windows file names).
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await rename(this.settingsFilePath, `${this.settingsFilePath}.corrupt-${stamp}`);
  }

  /**
   * Writes the list through a temporary file and a rename.
   *
   * @param workspaces the list
   * @returns when it was written
   */
  private async write(workspaces: WorkspaceSummary[]): Promise<void> {
    await mkdir(dirname(this.settingsFilePath), { recursive: true });
    const temporary = `${this.settingsFilePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ workspaces }, null, 2)}\n`, 'utf8');
      await rename(temporary, this.settingsFilePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

/**
 * Parses the file's text.
 *
 * @param text the text
 * @returns the workspaces, or null when the text is not a valid list
 */
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
