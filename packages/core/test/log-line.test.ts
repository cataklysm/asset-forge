import { describe, expect, it } from 'vitest';
import { errorLogLine, logLine, writeLine } from '../src/log-line.js';

const MARKER = 'SECRET_PATH_MARKER';

describe('logLine', () => {
  it('writes the event and the fields in order, leaving out null', () => {
    expect(logLine('Recovery on workspace open', { workspace: 'abc-1', moves: 2, skipped: null })).toBe(
      'Recovery on workspace open: workspace=abc-1 moves=2',
    );
  });

  it('writes the event alone without fields', () => {
    expect(logLine('Nothing', {})).toBe('Nothing');
  });

  it('replaces a value that could be a path, a URL or a message', () => {
    const line = logLine('Event', {
      path: `C:\\${MARKER}\\a.png`,
      url: `https://example.com/${MARKER}`,
      text: `${MARKER}\nsecond line`,
      long: 'a'.repeat(101),
      infinite: Number.POSITIVE_INFINITY,
    });
    expect(line).toBe('Event: path=? url=? text=? long=? infinite=?');
  });

  it('keeps ids, channel names and fixed words', () => {
    expect(logLine('Event', { channel: 'files:import', operation: 'archive entry', id: 'a1b2-c3' })).toBe(
      'Event: channel=files:import operation=archive entry id=a1b2-c3',
    );
  });
});

describe('errorLogLine', () => {
  it('appends the safe description of the error', () => {
    const error = Object.assign(new Error(`open '${MARKER}'`), { code: 'EPERM', syscall: 'open' });
    const line = errorLogLine('Import failed unexpectedly', { operation: 'import' }, error);
    expect(line).toBe('Import failed unexpectedly: operation=import error=Error code=EPERM syscall=open');
    expect(line).not.toContain(MARKER);
  });
});

describe('writeLine', () => {
  it('writes through the log and swallows its failure', () => {
    const lines: string[] = [];
    writeLine((line) => lines.push(line), 'one');
    writeLine(undefined, 'two');
    expect(() =>
      writeLine(() => {
        throw new Error('broken');
      }, 'three'),
    ).not.toThrow();
    expect(lines).toEqual(['one']);
  });
});
