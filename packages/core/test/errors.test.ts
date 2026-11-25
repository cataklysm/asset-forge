import { ErrorCodeSchema } from '@assetforge/contracts';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

type ErrorClass = new (message: string) => core.AssetForgeError;

describe('ErrorCodeSchema', () => {
  it('covers every code the application produces', () => {
    const subclasses = (Object.values(core) as unknown[]).filter(
      (value): value is ErrorClass =>
        typeof value === 'function' && value.prototype instanceof core.AssetForgeError,
    );
    expect(subclasses.length).toBeGreaterThan(10);
    for (const Cls of subclasses) {
      expect(() => ErrorCodeSchema.parse(new Cls('x').code), Cls.name).not.toThrow();
    }
  });

  it('ValidationFailedError carries validation_failed', () => {
    expect(new core.ValidationFailedError('x').code).toBe('validation_failed');
  });

  it('defines not_found and invalid_operation errors', () => {
    expect(new core.NotFoundError('x').code).toBe('not_found');
    expect(new core.InvalidOperationError('x').code).toBe('invalid_operation');
  });
});
