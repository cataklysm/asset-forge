import { describe, expect, it, vi } from 'vitest';
import { createLoadFailureHandler } from '../src/main/load-failure.js';

const ABORTED = Object.assign(new Error("ERR_ABORTED (-3) loading 'http://localhost:5173/'"), {
  code: 'ERR_ABORTED',
  errno: -3,
});
const REFUSED = Object.assign(new Error('ERR_CONNECTION_REFUSED (-102)'), {
  code: 'ERR_CONNECTION_REFUSED',
  errno: -102,
});

describe('createLoadFailureHandler', () => {
  it('ignores a rejected load that was only superseded (ERR_ABORTED)', () => {
    const onFailure = vi.fn();
    createLoadFailureHandler(onFailure).rejected(ABORTED);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('ignores an aborted error identified only by errno', () => {
    const onFailure = vi.fn();
    createLoadFailureHandler(onFailure).rejected(Object.assign(new Error('x'), { errno: -3 }));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports a rejected load with another error', () => {
    const onFailure = vi.fn();
    createLoadFailureHandler(onFailure).rejected(REFUSED);
    expect(onFailure).toHaveBeenCalledWith(REFUSED);
  });

  it('reports a non-Error rejection', () => {
    const onFailure = vi.fn();
    createLoadFailureHandler(onFailure).rejected('boom');
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('ignores did-fail-load for aborted loads and sub-frames', () => {
    const onFailure = vi.fn();
    const handler = createLoadFailureHandler(onFailure);
    handler.didFailLoad(-3, 'ERR_ABORTED', true);
    handler.didFailLoad(-102, 'ERR_CONNECTION_REFUSED', false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports a failed main-frame load', () => {
    const onFailure = vi.fn();
    createLoadFailureHandler(onFailure).didFailLoad(-102, 'ERR_CONNECTION_REFUSED', true);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('ignores failures after the initial load finished', () => {
    const onFailure = vi.fn();
    const handler = createLoadFailureHandler(onFailure);
    handler.finished();
    handler.didFailLoad(-102, 'ERR_CONNECTION_REFUSED', true);
    handler.rejected(REFUSED);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports only once when both paths fire for the same failure', () => {
    const onFailure = vi.fn();
    const handler = createLoadFailureHandler(onFailure);
    handler.didFailLoad(-102, 'ERR_CONNECTION_REFUSED', true);
    handler.rejected(REFUSED);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
