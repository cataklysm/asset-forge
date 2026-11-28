import { BACKUP_FOLDER_NAME } from '@assetforge/contracts';
import { BACKUP_NAME_PATTERN } from '../src/backup-names.js';
import { BackupError } from '../src/errors.js';
import type {
  BackupFileInfo,
  BackupLocation,
  BackupSource,
  DatabaseSnapshot,
  LocalBackupFile,
  SnapshotFacts,
  StagedRestore,
  WorkspaceBackups,
} from '../src/ports/workspace-backups.js';

/** One call of the fake, as recorded. */
export interface BackupCall {
  /** The method. */
  method: keyof WorkspaceBackups;
  /** Its arguments, without the abort signal. */
  args: unknown[];
}

/** The lineage the fake answers for a workspace nobody set one for. */
export const FAKE_LINEAGE_ID = '0123456789abcdef0123456789abcdef';

/**
 * The backup port over maps: directories of files, local pre-migration copies, lineages and staged restores. Every
 * call is recorded; `failures` makes a method throw (until cleared); `writeDelay` holds every `write` until it
 * resolves.
 */
export class FakeWorkspaceBackups implements WorkspaceBackups {
  /** Every call in order. */
  readonly calls: BackupCall[] = [];
  /** A method listed here throws its error instead of running. */
  readonly failures = new Map<keyof WorkspaceBackups, Error>();
  /** While set, every `write` waits for it before the file appears. */
  writeDelay: Promise<void> | null = null;
  /** The files per absolute directory. */
  readonly directories = new Map<string, Map<string, BackupFileInfo>>();
  /** Directories whose listing fails as unreachable. */
  readonly unreachable = new Set<string>();
  /** The lineage of each workspace's local database; a workspace missing here answers `FAKE_LINEAGE_ID`. */
  readonly lineages = new Map<string, string | null>();
  /** The pre-migration copies per workspace. */
  readonly localFiles = new Map<string, LocalBackupFile[]>();
  /** The place per workspace id; missing means the default place in the workspace folder. */
  readonly locations = new Map<string, BackupLocation>();
  /** What `stageRestore` finds per backup name; a name missing here stages as unreadable (facts null). */
  readonly stagedFacts = new Map<string, SnapshotFacts | null>();
  /** The facts `snapshotClosed` answers per workspace; missing means facts built from the workspace and lineage. */
  readonly closedFacts = new Map<string, SnapshotFacts>();
  /** The sources installed by `StagedRestore.install`, in order. */
  readonly installed: { workspaceId: string; source: BackupSource }[] = [];
  /** How many staged copies and snapshots were discarded. */
  discarded = 0;
  /** The workspaces whose install was reverted, in order. */
  readonly reverted: string[] = [];
  /** While set, `StagedRestore.install` throws it. */
  installFailure: Error | null = null;
  /** While set, `StagedRestore.revert` throws it. */
  revertFailure: Error | null = null;
  /** Runs when an install succeeds; the fake host makes the database exist. */
  onInstall: (workspaceId: string) => void = () => undefined;
  /** Runs when a revert succeeds; the fake host puts the state before the install back. */
  onRevert: (workspaceId: string) => void = () => undefined;
  /** While set, every `snapshotClosed` waits for it after it started; an aborted one then still resolves. */
  snapshotDelay: Promise<void> | null = null;

  async snapshotClosed(workspaceId: string, signal: AbortSignal): Promise<DatabaseSnapshot> {
    this.enter('snapshotClosed', [workspaceId], signal);
    if (this.snapshotDelay !== null) await this.snapshotDelay;
    const facts = this.closedFacts.get(workspaceId) ?? {
      workspaceId,
      lineageId: this.lineages.get(workspaceId) ?? FAKE_LINEAGE_ID,
      formatVersion: 1,
      appliedMigrations: 0,
      newerThanApp: false,
    };
    return this.snapshotOf(facts, 0);
  }

  async localLineage(workspaceId: string): Promise<string | null> {
    this.enter('localLineage', [workspaceId]);
    return this.lineages.has(workspaceId) ? (this.lineages.get(workspaceId) ?? null) : FAKE_LINEAGE_ID;
  }

  async listLocal(workspaceId: string): Promise<LocalBackupFile[]> {
    this.enter('listLocal', [workspaceId]);
    return [...(this.localFiles.get(workspaceId) ?? [])];
  }

  async stageRestore(workspaceId: string, source: BackupSource, signal: AbortSignal): Promise<StagedRestore> {
    this.enter('stageRestore', [workspaceId, source], signal);
    const facts = this.stagedFacts.get(source.name) ?? null;
    return {
      facts,
      install: async () => {
        if (this.installFailure !== null) throw this.installFailure;
        this.installed.push({ workspaceId, source });
        this.onInstall(workspaceId);
      },
      revert: async () => {
        if (this.revertFailure !== null) throw this.revertFailure;
        this.reverted.push(workspaceId);
        this.onRevert(workspaceId);
      },
      discard: async () => {
        this.discarded++;
      },
    };
  }

  async locationOf(workspace: { id: string; name: string; rootPath: string }): Promise<BackupLocation> {
    this.enter('locationOf', [workspace]);
    return (
      this.locations.get(workspace.id) ?? {
        kind: 'workspace',
        directory: `${workspace.rootPath}/${BACKUP_FOLDER_NAME}`,
        chosenPath: null,
      }
    );
  }

  async write(snapshot: DatabaseSnapshot, location: BackupLocation, fileName: string, signal: AbortSignal) {
    this.enter('write', [snapshot, location, fileName], signal);
    if (this.writeDelay !== null) await this.writeDelay;
    if (signal.aborted) throw new BackupError('backup_failed');
    const files = this.directories.get(location.directory) ?? new Map<string, BackupFileInfo>();
    files.set(fileName, { name: fileName, sizeBytes: snapshot.sizeBytes, modifiedAt: new Date().toISOString() });
    this.directories.set(location.directory, files);
  }

  async list(directory: string): Promise<BackupFileInfo[]> {
    this.enter('list', [directory]);
    if (this.unreachable.has(directory)) throw new BackupError('backup_location_unreachable');
    return [...(this.directories.get(directory)?.values() ?? [])];
  }

  async remove(directory: string, name: string): Promise<void> {
    this.enter('remove', [directory, name]);
    if (!BACKUP_NAME_PATTERN.test(name)) throw new BackupError('backup_failed');
    this.directories.get(directory)?.delete(name);
  }

  /**
   * Puts a file into a directory, as if a backup had been written there earlier.
   *
   * @param directory the absolute directory
   * @param name the file name
   * @param sizeBytes the size
   */
  addFile(directory: string, name: string, sizeBytes = 4096): void {
    const files = this.directories.get(directory) ?? new Map<string, BackupFileInfo>();
    files.set(name, { name, sizeBytes, modifiedAt: new Date().toISOString() });
    this.directories.set(directory, files);
  }

  /**
   * A snapshot over facts, as the fake database and `snapshotClosed` answer it.
   *
   * @param facts what the check found
   * @param changeCount the change count at the start
   * @returns the snapshot
   */
  snapshotOf(facts: SnapshotFacts, changeCount: number): DatabaseSnapshot {
    return {
      ...facts,
      path: `memory:snapshot-${facts.workspaceId}`,
      sizeBytes: 4096,
      changeCount,
      discard: async () => {
        this.discarded++;
      },
    };
  }

  /**
   * Records a call, then throws a set failure or the error of an aborted signal.
   *
   * @param method the method
   * @param args its arguments without the signal
   * @param signal the abort signal, when the method takes one
   */
  private enter(method: keyof WorkspaceBackups, args: unknown[], signal?: AbortSignal): void {
    this.calls.push({ method, args });
    const failure = this.failures.get(method);
    if (failure !== undefined) throw failure;
    if (signal?.aborted) throw new BackupError('backup_failed');
  }
}
