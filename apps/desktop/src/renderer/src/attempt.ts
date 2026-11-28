import { describeError } from './api';

// A mutation whose failure is shown in a screen's alert instead of being thrown.

/**
 * Runs a mutation and reports its error through `setError`.
 *
 * @param setError clears the shown error first, then shows the failure
 * @param action the mutation
 * @param describe turns a failure into the shown message
 * @returns resolves to whether it succeeded
 */
export async function attempt(
  setError: (message: string | null) => void,
  action: () => Promise<unknown>,
  describe: (error: unknown) => string = describeError,
): Promise<boolean> {
  setError(null);
  try {
    await action();
    return true;
  } catch (error) {
    setError(describe(error));
    return false;
  }
}
