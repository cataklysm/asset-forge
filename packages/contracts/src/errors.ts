import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'workspace_not_found',
  'storage_unreachable',
  'directory_not_empty',
  'unsupported_format_version',
  'workspace_mismatch',
  'workspace_duplicate',
  'trash_failed',
  'invalid_manifest',
  'no_workspace_open',
  'path_escape',
  'source_not_readable',
  'checksum_mismatch',
  'storage_access_denied',
  'storage_full',
  'not_found',
  'invalid_operation',
  'validation_failed',
  'unknown_channel',
  'invalid_request',
  'internal_error',
  'shutting_down',
  'forbidden_sender',
  'credential_store_unavailable',
  'provider_not_configured',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const IpcErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
});
export type IpcError = z.infer<typeof IpcErrorSchema>;
