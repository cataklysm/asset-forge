import { act } from '@testing-library/react';

/** Lets every answer and render that is already queued run, without waiting real time. */
export async function settleQueued(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await act(async () => {});
}
