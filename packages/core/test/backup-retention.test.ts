import { describe, expect, it } from 'vitest';
import { backupFileName, pruneSelection } from '../src/index.js';

const LINEAGE = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const NOW = new Date('2026-11-28T12:00:00.000Z');

function nameAt(iso: string, applied = 21, lineage = LINEAGE): string {
  return backupFileName(lineage, new Date(iso), applied);
}

/** Names at one-minute steps back from `start`. */
function minutesBack(start: string, count: number): string[] {
  const base = Date.parse(start);
  return Array.from({ length: count }, (_, i) => nameAt(new Date(base - i * 60_000).toISOString()));
}

describe('pruneSelection', () => {
  it('keeps the newest 5 of 20 within one day', () => {
    const names = minutesBack('2026-11-28T11:00:00.000Z', 20);
    const selected = pruneSelection(names, LINEAGE, names[0]!, NOW);
    expect(selected).toHaveLength(15);
    expect(selected).not.toContain(names[0]);
    for (const kept of names.slice(0, 5)) expect(selected).not.toContain(kept);
    for (const pruned of names.slice(5)) expect(selected).toContain(pruned);
  });

  it('keeps one per day for the last 7 UTC days, the newest of each', () => {
    const names: string[] = [];
    for (let day = 0; day < 7; day++) {
      const date = `2026-11-${String(28 - day).padStart(2, '0')}`;
      names.push(nameAt(`${date}T10:00:00.000Z`), nameAt(`${date}T09:00:00.000Z`));
    }
    const selected = pruneSelection(names, LINEAGE, names[0]!, NOW);
    const kept = names.filter((name) => !selected.includes(name));
    // Newest 5: day 0 (two), day 1 (two), day 2 10:00; then the newest of days 3 to 6.
    expect(kept).toEqual([names[0], names[1], names[2], names[3], names[4], names[6], names[8], names[10], names[12]]);
  });

  it('a backup at 23:59:59Z and one at 00:00:00Z fall on different days', () => {
    const recent = minutesBack('2026-11-28T11:00:00.000Z', 5);
    const late = nameAt('2026-11-26T23:59:59.000Z');
    const early = nameAt('2026-11-27T00:00:00.000Z');
    const earlier = nameAt('2026-11-26T23:00:00.000Z');
    const names = [...recent, early, late, earlier];
    const selected = pruneSelection(names, LINEAGE, recent[0]!, NOW);
    expect(selected).toEqual([earlier]);
  });

  it('day 8 back is pruned unless among the newest 5', () => {
    const old = nameAt('2026-11-21T10:00:00.000Z');
    expect(pruneSelection([nameAt('2026-11-28T10:00:00.000Z'), old], LINEAGE, 'x', NOW)).toEqual([]);
    const recent = minutesBack('2026-11-28T11:00:00.000Z', 5);
    expect(pruneSelection([...recent, old], LINEAGE, recent[0]!, NOW)).toEqual([old]);
  });

  it('another lineage, tmp, info file and pre-migration names are never selected', () => {
    const recent = minutesBack('2026-11-28T11:00:00.000Z', 5);
    const old = nameAt('2026-10-01T10:00:00.000Z');
    const foreign = nameAt('2026-10-01T10:00:00.000Z', 21, OTHER);
    const names = [
      ...recent,
      old,
      foreign,
      `${old}.tmp`,
      'backup-info.json',
      'assetforge.sqlite.backup-3-20261001090503',
      'assetforge.sqlite.replaced-20261001T090503Z',
      'assetforge-0123456789ab-20261332T000000Z-m1.sqlite',
    ];
    expect(pruneSelection(names, LINEAGE, recent[0]!, NOW)).toEqual([old]);
  });

  it('just written survives when its stamp is older than all others', () => {
    const recent = minutesBack('2026-11-28T11:00:00.000Z', 6);
    const written = nameAt('2026-10-01T10:00:00.000Z');
    const selected = pruneSelection([...recent, written], LINEAGE, written, NOW);
    expect(selected).toEqual([recent[5]]);
  });

  it('future stamps take newest-5 slots but match no day', () => {
    const future = minutesBack('2026-12-05T10:00:00.000Z', 5);
    const today = nameAt('2026-11-28T10:00:00.000Z');
    const todayEarlier = nameAt('2026-11-28T09:00:00.000Z');
    const selected = pruneSelection([...future, today, todayEarlier], LINEAGE, future[0]!, NOW);
    expect(selected).toEqual([todayEarlier]);
  });

  it('equal stamps: higher m wins, then name', () => {
    const stamp = '2026-11-20T10:00:00.000Z';
    const recent = minutesBack('2026-11-28T11:00:00.000Z', 5);
    const lower = nameAt(stamp, 20);
    const higher = nameAt(stamp, 21);
    // Day 2026-11-20 is outside the window; a second set on 2026-11-25 decides per day.
    const dayStamp = '2026-11-25T10:00:00.000Z';
    const dayLower = nameAt(dayStamp, 3);
    const dayHigher = nameAt(dayStamp, 30);
    const selected = pruneSelection([...recent, lower, higher, dayLower, dayHigher], LINEAGE, recent[0]!, NOW);
    expect(selected.sort()).toEqual([dayLower, higher, lower].sort());
  });

  it('orders equal stamp and count by name', () => {
    const recent = minutesBack('2026-11-28T11:00:00.000Z', 4);
    const stamp = '2026-11-20T10:00:00.000Z';
    const first = nameAt(stamp, 7);
    const second = nameAt(stamp, 7, '0123456789abffff0000000000000000');
    // Only the own lineage counts, so the other short id is never selected; the own one is the fifth newest.
    expect(pruneSelection([...recent, first, second], LINEAGE, recent[0]!, NOW)).toEqual([]);
  });

  it('empty or single list selects nothing', () => {
    expect(pruneSelection([], LINEAGE, 'x', NOW)).toEqual([]);
    const only = nameAt('2026-01-01T00:00:00.000Z');
    expect(pruneSelection([only], LINEAGE, 'x', NOW)).toEqual([]);
  });
});
