import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { JobErrorCode } from '@assetforge/contracts';
import { describeError } from '../api';

/** The state of one banner action that `runResume` updates. */
interface ResumeState {
  /** True while a call runs; a ref, so a second click in the same render is refused. */
  runningRef: RefObject<boolean>;
  setResuming: Dispatch<SetStateAction<boolean>>;
  setResumeError: Dispatch<SetStateAction<string | null>>;
}

/** What `useResume` hands to its banner line. */
interface Resume {
  /** True while the action runs. */
  resuming: boolean;
  /** The text of the last rejection, kept until the next try or a new reason. */
  resumeError: string | null;
  /** Runs the action unless it already runs; resolves when it settled. */
  resume(): Promise<void>;
}

/**
 * Runs one banner action unless it already runs, keeping its rejection as text.
 *
 * @param action the action of the banner line
 * @param state the running flag and the setters of the line
 * @returns resolves when the action settled; never rejects
 */
async function runResume(action: () => Promise<void>, state: ResumeState): Promise<void> {
  if (state.runningRef.current) return;
  state.runningRef.current = true;
  state.setResuming(true);
  state.setResumeError(null);
  try {
    await action();
  } catch (error) {
    state.setResumeError(describeError(error));
  } finally {
    state.runningRef.current = false;
    state.setResuming(false);
  }
}

/**
 * One action of a banner line (Resume, Open site): one call at a time; a rejection is kept until the next try or a new reason.
 *
 * @param reason the pause reason of the line; a new one drops the kept rejection
 * @param onResume the action
 * @returns the running flag, the kept rejection and the function that runs the action
 */
export function useResume(reason: JobErrorCode, onResume: () => Promise<void>): Resume {
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const resumingRef = useRef(false);
  // A new pause reason drops the error of an earlier resume.
  useEffect(() => setResumeError(null), [reason]);

  const resume = () => runResume(onResume, { runningRef: resumingRef, setResuming, setResumeError });
  return { resuming, resumeError, resume };
}
