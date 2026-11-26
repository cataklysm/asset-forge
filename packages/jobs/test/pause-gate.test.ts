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
    g.record('local_gpu', 'provider_unreachable');
    g.record('local_gpu', 'provider_unavailable');
    expect(g.reason('local_gpu')).toBeNull();
    expect(changes.n).toBe(0);
    g.record('local_gpu', 'provider_timeout');
    expect(g.reason('local_gpu')).toBe('provider_timeout');
    expect(g.reason('cpu')).toBeNull();
    expect(changes.n).toBe(1);
  });

  it('resets the count on a success or any other outcome', () => {
    for (const reset of ['ok', 'other', 'invalid_response', 'provider_rejected', 'file_unavailable', 'internal_error'] as const) {
      const { g } = gate();
      g.record('local_gpu', 'provider_unreachable');
      g.record('local_gpu', 'provider_unreachable');
      g.record('local_gpu', reset);
      g.record('local_gpu', 'provider_unreachable');
      g.record('local_gpu', 'provider_unreachable');
      expect(g.reason('local_gpu')).toBeNull();
      g.record('local_gpu', 'provider_unreachable');
      expect(g.reason('local_gpu')).toBe('provider_unreachable');
    }
  });

  it('counts per resource class', () => {
    const { g } = gate();
    g.record('local_gpu', 'provider_unreachable');
    g.record('remote_api', 'provider_unreachable');
    g.record('local_gpu', 'provider_unreachable');
    g.record('remote_api', 'ok');
    g.record('local_gpu', 'provider_unreachable');
    expect(g.reason('local_gpu')).toBe('provider_unreachable');
    expect(g.reason('remote_api')).toBeNull();
  });

  it('pauses at once on provider_unauthorized and provider_not_configured', () => {
    for (const code of ['provider_unauthorized', 'provider_not_configured'] as const) {
      const { g, changes } = gate();
      g.record('local_gpu', code);
      expect(g.reason('local_gpu')).toBe(code);
      expect(changes.n).toBe(1);
    }
  });

  it('honours a custom threshold', () => {
    const { g } = gate(1);
    g.record('cpu', 'provider_timeout');
    expect(g.reason('cpu')).toBe('provider_timeout');
  });

  it('keeps the pause and its reason until resume, then counts from zero', () => {
    const { g, changes } = gate();
    g.record('local_gpu', 'provider_unauthorized');
    g.record('local_gpu', 'ok');
    g.record('local_gpu', 'provider_unreachable');
    expect(g.reason('local_gpu')).toBe('provider_unauthorized');
    expect(changes.n).toBe(1);

    g.resume('local_gpu');
    expect(g.reason('local_gpu')).toBeNull();
    expect(changes.n).toBe(2);
    g.record('local_gpu', 'provider_unreachable');
    g.record('local_gpu', 'provider_unreachable');
    expect(g.reason('local_gpu')).toBeNull();
  });

  it('fires onChange only on pause and on resume of a paused class', () => {
    const { g, changes } = gate();
    g.resume('local_gpu');
    g.record('local_gpu', 'ok');
    g.record('local_gpu', 'provider_unreachable');
    expect(changes.n).toBe(0);
    g.record('local_gpu', 'provider_not_configured');
    g.record('local_gpu', 'provider_unauthorized');
    expect(changes.n).toBe(1);
    g.resume('local_gpu');
    g.resume('local_gpu');
    expect(changes.n).toBe(2);
  });

  it('resume clears a partial count', () => {
    const { g } = gate();
    g.record('local_gpu', 'provider_unreachable');
    g.record('local_gpu', 'provider_unreachable');
    g.resume('local_gpu');
    g.record('local_gpu', 'provider_unreachable');
    expect(g.reason('local_gpu')).toBeNull();
  });
});
