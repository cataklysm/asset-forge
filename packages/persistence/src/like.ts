/** Escapes `\`, `%` and `_` so `text` matches literally inside `LIKE '%…%' ESCAPE '\'`. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
