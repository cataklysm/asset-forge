import { describe, expect, it } from 'vitest';
import { DEFAULT_PAUSE_THRESHOLD, createPauseGate } from '../src/index.js';

function gate(threshold?: number) {
  const changes = { n: 0 };
  const g = createPauseGate({ ...(threshold === undefined ? {} : { threshold }), onChange: () => changes.n++ });
  return { g, changes };
}

describe('createPauseGate', () => {
  it('has the agreed threshold', () => {
    expect(DEFAULT_PAUSE_THRESHOLD).toBe(3);
  });

  it('pauses after three consecutive provider-down outcomes with the last code', () => {
    const { g, changes } = gate();
    g.record('local_gpu', null, 'provider_unreachable');
    g.record('local_gpu', null, 'provider_unavailable');
    expect(g.reason('local_gpu', null)).toBeNull();
    expect(changes.n).toBe(0);
    g.record('local_gpu', null, 'provider_timeout');
    expect(g.reason('local_gpu', null)).toBe('provider_timeout');
    expect(g.reason('cpu', null)).toBeNull();
    expect(changes.n).toBe(1);
  });

  it('resets the count on a success or any other outcome', () => {
    for (const reset of ['ok', 'other', 'invalid_response', 'provider_rejected', 'file_unavailable', 'internal_error'] as const) {
      const { g } = gate();
      g.record('local_gpu', null, 'provider_unreachable');
      g.record('local_gpu', null, 'provider_unreachable');
      g.record('local_gpu', null, reset);
      g.record('local_gpu', null, 'provider_unreachable');
      g.record('local_gpu', null, 'provider_unreachable');
      expect(g.reason('local_gpu', null)).toBeNull();
      g.record('local_gpu', null, 'provider_unreachable');
      expect(g.reason('local_gpu', null)).toBe('provider_unreachable');
    }
  });

  it('counts per resource class', () => {
    const { g } = gate();
    g.record('local_gpu', null, 'provider_unreachable');
    g.record('remote_api', null, 'provider_unreachable');
    g.record('local_gpu', null, 'provider_unreachable');
    g.record('remote_api', null, 'ok');
    g.record('local_gpu', null, 'provider_unreachable');
    expect(g.reason('local_gpu', null)).toBe('provider_unreachable');
    expect(g.reason('remote_api', null)).toBeNull();
  });

  it('pauses at once on provider_unauthorized and provider_not_configured', () => {
    for (const code of ['provider_unauthorized', 'provider_not_configured'] as const) {
      const { g, changes } = gate();
      g.record('local_gpu', null, code);
      expect(g.reason('local_gpu', null)).toBe(code);
      expect(changes.n).toBe(1);
    }
  });

  it('honours a custom threshold', () => {
    const { g } = gate(1);
    g.record('cpu', null, 'provider_timeout');
    expect(g.reason('cpu', null)).toBe('provider_timeout');
  });

  it('keeps the pause and its reason until resume, then counts from zero', () => {
    const { g, changes } = gate();
    g.record('local_gpu', null, 'provider_unauthorized');
    g.record('local_gpu', null, 'ok');
    g.record('local_gpu', null, 'provider_unreachable');
    expect(g.reason('local_gpu', null)).toBe('provider_unauthorized');
    expect(changes.n).toBe(1);

    g.resume('local_gpu', null);
    expect(g.reason('local_gpu', null)).toBeNull();
    expect(changes.n).toBe(2);
    g.record('local_gpu', null, 'provider_unreachable');
    g.record('local_gpu', null, 'provider_unreachable');
    expect(g.reason('local_gpu', null)).toBeNull();
  });

  it('fires onChange only on pause and on resume of a paused class', () => {
    const { g, changes } = gate();
    g.resume('local_gpu', null);
    g.record('local_gpu', null, 'ok');
    g.record('local_gpu', null, 'provider_unreachable');
    expect(changes.n).toBe(0);
    g.record('local_gpu', null, 'provider_not_configured');
    g.record('local_gpu', null, 'provider_unauthorized');
    expect(changes.n).toBe(1);
    g.resume('local_gpu', null);
    g.resume('local_gpu', null);
    expect(changes.n).toBe(2);
  });

  it('pauses lane a after three provider-down outcomes and leaves lane b free', () => {
    const { g, changes } = gate();
    for (let i = 0; i < 3; i++) g.record('local_gpu', 'a', 'provider_unreachable');
    expect(g.reason('local_gpu', 'a')).toBe('provider_unreachable');
    expect(g.reason('local_gpu', 'b')).toBeNull();
    expect(g.reason('local_gpu', null)).toBeNull();
    expect(changes.n).toBe(1);
  });

  it('pauses a lane at once on provider_unauthorized', () => {
    const { g } = gate();
    g.record('local_gpu', 'a', 'provider_unauthorized');
    expect(g.reason('local_gpu', 'a')).toBe('provider_unauthorized');
    expect(g.reason('local_gpu', 'b')).toBeNull();
  });

  it('counts per lane: an ok resets only its own lane', () => {
    const { g } = gate();
    g.record('local_gpu', 'a', 'provider_unreachable');
    g.record('local_gpu', 'b', 'provider_unreachable');
    g.record('local_gpu', 'a', 'provider_unreachable');
    g.record('local_gpu', 'b', 'provider_unreachable');
    g.record('local_gpu', 'a', 'ok');
    g.record('local_gpu', 'a', 'provider_unreachable');
    g.record('local_gpu', 'b', 'provider_unreachable');
    expect(g.reason('local_gpu', 'a')).toBeNull();
    expect(g.reason('local_gpu', 'b')).toBe('provider_unreachable');
  });

  it('keeps the lane null apart from a named lane and from other classes', () => {
    const { g } = gate();
    g.record('local_gpu', null, 'provider_not_configured');
    expect(g.reason('local_gpu', null)).toBe('provider_not_configured');
    expect(g.reason('local_gpu', 'null')).toBeNull();
    expect(g.reason('remote_api', null)).toBeNull();
  });

  it('resume of lane a leaves a paused lane b', () => {
    const { g, changes } = gate();
    g.record('local_gpu', 'a', 'provider_unauthorized');
    g.record('local_gpu', 'b', 'provider_not_configured');
    expect(changes.n).toBe(2);
    g.resume('local_gpu', 'a');
    expect(changes.n).toBe(3);
    expect(g.reason('local_gpu', 'a')).toBeNull();
    expect(g.reason('local_gpu', 'b')).toBe('provider_not_configured');
    g.resume('local_gpu', 'a');
    expect(changes.n).toBe(3);
  });

  it('lists the paused lanes of a class with their reasons', () => {
    const { g } = gate();
    expect(g.paused('local_gpu')).toEqual([]);
    g.record('local_gpu', 'a', 'provider_unauthorized');
    for (let i = 0; i < 3; i++) g.record('local_gpu', null, 'provider_timeout');
    g.record('remote_api', 'c', 'provider_unauthorized');
    g.record('local_gpu', 'd', 'provider_unreachable');
    expect(g.paused('local_gpu')).toEqual([
      { lane: 'a', reason: 'provider_unauthorized' },
      { lane: null, reason: 'provider_timeout' },
    ]);
    expect(g.paused('remote_api')).toEqual([{ lane: 'c', reason: 'provider_unauthorized' }]);
    expect(g.paused('cpu')).toEqual([]);
    g.resume('local_gpu', 'a');
    expect(g.paused('local_gpu')).toEqual([{ lane: null, reason: 'provider_timeout' }]);
  });

  it('resume clears a partial count', () => {
    const { g } = gate();
    g.record('local_gpu', null, 'provider_unreachable');
    g.record('local_gpu', null, 'provider_unreachable');
    g.resume('local_gpu', null);
    g.record('local_gpu', null, 'provider_unreachable');
    expect(g.reason('local_gpu', null)).toBeNull();
  });
});
