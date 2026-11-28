import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkspaceRegistry } from '@assetforge/core';
import { WorkspaceSummarySchema, type WorkspaceSummary } from '@assetforge/contracts';

const WorkspaceListSchema = WorkspaceSummarySchema.array();

/** The file's content: the workspaces and every other top-level key, which a write keeps as it found them. */
interface RegistryContent {
  /** The registered workspaces. */
  workspaces: WorkspaceSummary[];
  /** Top-level keys other than `workspaces`, kept unchanged. */
  otherKeys: Record<string, unknown>;
  /** Per workspace id, the keys of its entry that the schema does not know, kept while the entry stays. */
  entryKeys: Map<string, Record<string, unknown>>;
}

/**
 * Workspace registry persisted as `{ "workspaces": [...] }` in a single JSON file. Every operation runs after the
 * previous one has finished, so two concurrent read-modify-write steps never lose an entry and an unreadable file is
 * set aside only once.
 */
export class JsonWorkspaceRegistry implements WorkspaceRegistry {
  /** The end of the queue of operations; it never rejects. */
  private queue: Promise<unknown> = Promise.resolve();

  /** @param settingsFilePath the JSON file */
  constructor(private readonly settingsFilePath: string) {}

  /** @returns every registered workspace */
  async list(): Promise<WorkspaceSummary[]> {
    return this.serially(async () => (await this.read()).workspaces);
  }

  /**
   * @param id the workspace
   * @returns the workspace, or null
   */
  async get(id: string): Promise<WorkspaceSummary | null> {
    const workspaces = await this.list();
    return workspaces.find((workspace) => workspace.id === id) ?? null;
  }

  /**
   * Adds a workspace or replaces the one with the same id.
   *
   * @param entry the workspace
   * @returns when it was written
   */
  async upsert(entry: WorkspaceSummary): Promise<void> {
    return this.serially(() => this.upsertNow(entry));
  }

  /**
   * Removes a workspace; an unknown id writes nothing.
   *
   * @param id the workspace
   * @returns when it was written
   */
  async remove(id: string): Promise<void> {
    return this.serially(() => this.removeNow(id));
  }

  /**
   * Runs one operation after every earlier one has settled.
   *
   * @param operation the operation
   * @returns what the operation resolves to
   */
  private serially<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The body of `upsert`, run inside the queue.
   *
   * @param entry the workspace
   * @returns when it was written
   */
  private async upsertNow(entry: WorkspaceSummary): Promise<void> {
    const content = await this.read();
    const index = content.workspaces.findIndex((workspace) => workspace.id === entry.id);
    if (index >= 0) content.workspaces[index] = entry;
    else content.workspaces.push(entry);
    await this.write(content);
  }

  /**
   * The body of `remove`, run inside the queue.
   *
   * @param id the workspace
   * @returns when it was written
   */
  private async removeNow(id: string): Promise<void> {
    const content = await this.read();
    const kept = content.workspaces.filter((workspace) => workspace.id !== id);
    if (kept.length !== content.workspaces.length) await this.write({ ...content, workspaces: kept });
  }

  /**
   * Reads the file; a missing one reads as empty, an unreadable one is set aside and reads as empty.
   *
   * @returns the content
   */
  private async read(): Promise<RegistryContent> {
    let text: string;
    try {
      text = await readFile(this.settingsFilePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyContent();
      throw error;
    }
    const parsed = parseContent(text);
    if (parsed) return parsed;
    await this.quarantine();
    return emptyContent();
  }

  /**
   * Moves the unreadable file aside under a stamped name; a file that is already gone needs nothing.
   *
   * @returns when it was moved
   */
  private async quarantine(): Promise<void> {
    // ISO timestamp without ':' (invalid in Windows file names).
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      await rename(this.settingsFilePath, `${this.settingsFilePath}.corrupt-${stamp}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /**
   * Writes the content through a temporary file and a rename.
   *
   * @param content the workspaces and the other keys
   * @returns when it was written
   */
  private async write(content: RegistryContent): Promise<void> {
    await mkdir(dirname(this.settingsFilePath), { recursive: true });
    const temporary = `${this.settingsFilePath}.${randomUUID()}.tmp`;
    const workspaces = content.workspaces.map((workspace) => ({
      ...content.entryKeys.get(workspace.id),
      ...workspace,
    }));
    const json = { ...content.otherKeys, workspaces };
    try {
      await writeFile(temporary, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
      await rename(temporary, this.settingsFilePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

/** @returns the content of a missing or unreadable file */
function emptyContent(): RegistryContent {
  return { workspaces: [], otherKeys: {}, entryKeys: new Map() };
}

/**
 * Collects the keys of each raw entry that its parsed summary does not carry.
 *
 * @param raw the entries as stored
 * @param workspaces the parsed entries, in the same order
 * @returns per workspace id, its unknown keys
 */
function unknownEntryKeys(raw: unknown[], workspaces: WorkspaceSummary[]): Map<string, Record<string, unknown>> {
  const keys = new Map<string, Record<string, unknown>>();
  workspaces.forEach((workspace, index) => {
    const stored = raw[index] as Record<string, unknown>;
    const unknown = Object.entries(stored).filter(([key]) => !(key in workspace));
    if (unknown.length > 0) keys.set(workspace.id, Object.fromEntries(unknown));
  });
  return keys;
}

/**
 * Parses the file's text.
 *
 * @param text the text
 * @returns the content, or null when the text is not an object with a valid list
 */
function parseContent(text: string): RegistryContent | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json) || !('workspaces' in json)) return null;
  const result = WorkspaceListSchema.safeParse(json.workspaces);
  if (!result.success) return null;
  const otherKeys = Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'workspaces'));
  return { workspaces: result.data, otherKeys, entryKeys: unknownEntryKeys(json.workspaces as unknown[], result.data) };
}
