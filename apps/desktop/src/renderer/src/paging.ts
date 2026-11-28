// The offset of a list page after the list shrank.

/**
 * The offset of the last page that still has rows when `offset` lies past the end; otherwise `offset`.
 *
 * @param offset the wanted offset
 * @param total the list's total
 * @param limit the page size
 * @returns the offset to request
 */
export function clampOffset(offset: number, total: number, limit: number): number {
  if (total <= 0 || offset < total) return offset;
  return Math.floor((total - 1) / limit) * limit;
}
