import { useRef, useState, type MutableRefObject } from 'react';

/** What `useExclusiveRun` offers. */
export interface ExclusiveRun {
  /** An action is running. */
  busy: boolean;
  /** The message of the last refusal; null when there is none. */
  error: string | null;
  setError(error: string | null): void;
  /** Runs `action` unless one runs already; a refusal shows its message. */
  run(action: () => Promise<void>): Promise<void>;
}

/** What one exclusive run reads and writes. */
interface RunControl {
  busyRef: MutableRefObject<boolean>;
  setBusy(busy: boolean): void;
  setError(error: string | null): void;
  messageOf(error: unknown): string;
}

/**
 * Runs `action` unless one runs already; a refusal shows its message.
 *
 * @param control the refs and setters
 * @param action the action
 * @returns resolves once the action settled; never rejects
 */
async function runExclusive(control: RunControl, action: () => Promise<void>): Promise<void> {
  if (control.busyRef.current) return;
  control.busyRef.current = true;
  control.setBusy(true);
  control.setError(null);
  try {
    await action();
  } catch (error) {
    control.setError(control.messageOf(error));
  } finally {
    control.busyRef.current = false;
    control.setBusy(false);
  }
}

/**
 * Runs one action at a time; the ref answers at once, the state renders the controls disabled.
 *
 * @param messageOf the message shown for a refusal
 * @returns the busy and error state and the run function
 */
export function useExclusiveRun(messageOf: (error: unknown) => string): ExclusiveRun {
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<void>) => runExclusive({ busyRef, setBusy, setError, messageOf }, action);
  return { busy, error, setError, run };
}
