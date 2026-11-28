import { describe, expect, it } from 'vitest';
import { createPauseGate } from '../src/pause-gate';

describe('explicit source authentication pause', () => {
  it('pauses only the affected discovery site immediately with the actual refusal reason', () => {
    let changes = 0;
    const gate = createPauseGate({
      onChange: () => {
        changes++;
      },
    });
    expect(gate).toHaveProperty('pause');
    (gate as typeof gate & { pause(resourceClass: 'cpu', lane: string, reason: 'download_forbidden'): void }).pause(
      'cpu',
      'example.com',
      'download_forbidden',
    );
    expect(gate.reason('cpu', 'example.com')).toBe('download_forbidden');
    expect(gate.reason('cpu', 'other.example')).toBeNull();
    expect(gate.reason('io', 'example.com')).toBeNull();
    expect(changes).toBe(1);
    gate.resume('cpu', 'example.com');
    expect(gate.reason('cpu', 'example.com')).toBeNull();
  });
});
