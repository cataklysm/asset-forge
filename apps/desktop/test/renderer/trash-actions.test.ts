import { expect, it } from 'vitest';
import { ApiError } from '../../src/renderer/src/api';
import { runFileBatch, throwFirst } from '../../src/renderer/src/trash-actions';
import { installFakeApi } from './fake-api';
import { fileRecord } from './fixtures';

it('a single failed item is thrown with its error code', async () => {
  installFakeApi({
    'files:trashMany': () => ({
      items: [
        {
          fileId: 'f1',
          file: null,
          error: { code: 'invalid_operation' as const, message: 'This file is still being imported' },
        },
      ],
    }),
  });
  const { firstError } = await runFileBatch('files:trashMany', [fileRecord({ id: 'f1' })]);
  let thrown: unknown = null;
  try {
    throwFirst(firstError);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  expect((thrown as ApiError).code).toBe('invalid_operation');
  expect((thrown as ApiError).message).toBe('This file is still being imported');
});

it('nothing is thrown when every item went through', async () => {
  installFakeApi({ 'files:trashMany': () => ({ items: [{ fileId: 'f1', file: null, error: null }] }) });
  const outcome = await runFileBatch('files:trashMany', [fileRecord({ id: 'f1' })]);
  expect(outcome).toEqual({ doneIds: ['f1'], failures: [], firstError: null });
  expect(() => throwFirst(outcome.firstError)).not.toThrow();
});
