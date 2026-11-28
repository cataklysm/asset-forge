import { createContext, useContext } from 'react';
import type { FileRecord, UpscaleScale } from '@assetforge/contracts';
import { NO_IMAGE_PROVIDER_TITLE } from './labels';
import type { StudioForm } from './studio-state';

// The studio contexts and their hooks, apart from `StudioProvider`, so the dialogs it mounts can use them
// without importing the module that mounts them.

/** What the studio context offers. */
export interface StudioState {
  /** Opens the generation studio on `file`. */
  open(file: FileRecord): void;
  /**
   * Starts an upscale of `file`. It names no entry: the main process runs the image provider used
   * last (else the first), and an accepted start records it here too. Rejects with the reason a sent
   * start failed. While an upscale of the file is in flight it sends nothing and resolves; the start
   * in flight reports its own outcome.
   */
  upscale(file: FileRecord, scale: UpscaleScale): Promise<void>;
  /** True while an upscale of the file `fileId` is being started. */
  upscaling(fileId: string): boolean;
  /**
   * Shows the file with id `fileId` in the linked file dialog, which stacks over the dialog the link
   * was followed in and over the studio; while it is open it moves on to that file. Rejects when the
   * file cannot be read.
   */
  openFile(fileId: string): Promise<void>;
  /**
   * Closes the studio and the linked file dialog and shows the library prompt `promptId` in the
   * Prompts screen (through the host, so the leave guard applies).
   */
  openPrompt(promptId: string): void;
  /** Why no generation can start (no image provider entry), as tooltip of the disabled entries; null while the list is unknown. */
  blocked: string | null;
  /** The value typed last for a library prompt variable of this name (regardless of case), for as long as the provider lives. */
  recallVariable(name: string): string | undefined;
  /** Remembers typed variable values by name; an empty value forgets the name. */
  rememberVariables(values: Readonly<Record<string, string>>): void;
}

/** The studio outside a provider. */
const EMPTY: StudioState = {
  open: () => {},
  upscale: () => Promise.reject(new Error(NO_IMAGE_PROVIDER_TITLE)),
  upscaling: () => false,
  openFile: async () => {},
  openPrompt: () => {},
  blocked: null,
  recallVariable: () => undefined,
  rememberVariables: () => {},
};

/** The studio of the workspace. */
export const StudioContext = createContext<StudioState>(EMPTY);

/** What a generation start is for: an edit or an upscale of one source file. */
export type StartKind = 'edit' | 'upscale';

/**
 * What outlives one instance of the studio dialog while the studio stays open (raising it mounts it
 * anew): the starts in flight and the form of the shown source.
 */
export interface StudioSession {
  /** A start of `kind` for the source `fileId` is in flight. */
  starting(fileId: string, kind: StartKind): boolean;
  /** Runs `start` unless a start of `kind` for `fileId` is in flight; resolves false when it did not run. */
  guardStart(fileId: string, kind: StartKind, start: () => Promise<void>): Promise<boolean>;
  /** The studio form kept for `fileId`; undefined for another file and after the studio was closed. */
  draft(fileId: string): StudioForm | undefined;
  /** Keeps the studio form of `fileId` until the studio closes or shows another file. */
  keepDraft(fileId: string, form: StudioForm): void;
  /** Why the last edit start for the source `fileId` failed; null when it did not or the studio was closed since. */
  startError(fileId: string): string | null;
  /** Sets (or with null clears) the start error of `fileId`; it outlives a raise and goes on close. */
  setStartError(fileId: string, message: string | null): void;
}

// Outside a provider nothing outlives the dialog: every start runs, and no form is kept.
const NO_SESSION: StudioSession = {
  starting: () => false,
  guardStart: async (_fileId, _kind, start) => {
    await start();
    return true;
  },
  draft: () => undefined,
  keepDraft: () => {},
  startError: () => null,
  setStartError: () => {},
};

/** The session of the studio of the workspace. */
export const StudioSessionContext = createContext<StudioSession>(NO_SESSION);

/**
 * The starts in flight and the kept form of the surrounding `StudioProvider`.
 *
 * @returns the session; outside a provider nothing is kept
 */
export function useStudioSession(): StudioSession {
  return useContext(StudioSessionContext);
}

/**
 * The studio of the surrounding `StudioProvider`.
 *
 * @returns the studio; outside a provider nothing opens and nothing starts
 */
export function useStudio(): StudioState {
  return useContext(StudioContext);
}
