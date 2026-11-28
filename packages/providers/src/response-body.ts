/**
 * Releases a body that will not be read. Failures are irrelevant: the answer is already decided.
 *
 * @param response the answer
 * @returns resolves once the body is cancelled or the cancel failed
 */
export async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignored
  }
}

/** Thrown by `readCapped` when a body exceeds its limit. */
export class ResponseTooLarge extends Error {}

/**
 * Reads the body as UTF-8 and stops (cancelling the stream) once it exceeds `limit`.
 *
 * @param response the answer
 * @param limit the most bytes accepted
 * @returns the body's text; empty for an answer without a body
 * @throws ResponseTooLarge when the body exceeds `limit`
 */
export async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        // ignored
      }
      throw new ResponseTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
