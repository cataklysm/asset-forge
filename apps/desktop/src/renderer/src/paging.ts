/** The offset of the last page that still has rows when `offset` lies past the end; otherwise `offset`. */
export function clampOffset(offset: number, total: number, limit: number): number {
  if (total <= 0 || offset < total) return offset;
  return Math.floor((total - 1) / limit) * limit;
}
