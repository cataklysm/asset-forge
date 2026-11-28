// Follows the Venice API shape as read from its docs on 2026-11-26 (/image/edit, /image/upscale, /models?type=inpaint).
import type { JobErrorCode } from '@assetforge/contracts';
import type { ImageInput, ImageProvider } from '@assetforge/core';
import type { VeniceConnection } from './venice-connection.js';
import { listEditModels } from './venice-model-list.js';
import { sendPaid } from './venice-paid-call.js';

/** The file name extension of the multipart image part per MIME type. */
const EXTENSIONS: Record<ImageInput['mimeType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** What `createVeniceImage` is configured with. */
export interface VeniceImageOptions {
  /** The entry's base URL, e.g. `https://api.venice.ai/api/v1`; the key goes to this origin only. */
  baseUrl: string;
  /** How long an edit or upscale may take, including streaming the answer. */
  timeoutMs: number;
  /** The API key in force at call time; null for none. */
  apiKey: () => string | null;
  /** Told the code and HTTP status of every failed call. */
  onFailure?: (code: JobErrorCode, status: number | null) => void;
  /** Replaces the global fetch, for tests. */
  fetch?: typeof fetch;
}

/** What an edit is asked with. */
type EditRequest = Parameters<ImageProvider['editImage']>[0];
/** What an upscale is asked with. */
type UpscaleRequest = Parameters<ImageProvider['upscaleImage']>[0];

/**
 * An `ImageProvider` over Venice's `POST /image/edit`, `POST /image/upscale` and `GET /models?type=inpaint`.
 * The key is sent as a bearer token only to `baseUrl`: redirects are never followed and the key never enters a
 * body, an error or a log. Only the code and the HTTP status of a failure leave the adapter.
 *
 * @param options the base URL, the time limit, the key supplier, the failure report and the fetch
 * @returns the provider
 */
export function createVeniceImage(options: VeniceImageOptions): ImageProvider {
  const connection: VeniceConnection = {
    base: options.baseUrl.replace(/\/+$/, ''),
    fetchImpl: options.fetch ?? fetch,
    options,
  };
  return {
    editImage: (request) => sendPaid(connection, '/image/edit', editForm(request), request.signal),
    upscaleImage: (request) => sendPaid(connection, '/image/upscale', upscaleForm(request), request.signal),
    listEditModels: (callerSignal) => listEditModels(connection, callerSignal),
  };
}

/**
 * The multipart body of an edit.
 *
 * @param request the image, the model, the prompt and the chosen settings
 * @returns the form
 */
function editForm({ image, model, prompt, aspectRatio, resolution, safeMode }: EditRequest): FormData {
  const form = new FormData();
  appendImage(form, image);
  form.append('prompt', prompt);
  form.append('model', model);
  if (aspectRatio !== null) form.append('aspect_ratio', aspectRatio);
  if (resolution !== null) form.append('resolution', resolution);
  form.append('output_format', 'png');
  form.append('safe_mode', safeMode ? 'true' : 'false');
  return form;
}

/**
 * The multipart body of an upscale.
 *
 * @param request the image and the scale
 * @returns the form
 */
function upscaleForm({ image, scale }: UpscaleRequest): FormData {
  const form = new FormData();
  appendImage(form, image);
  form.append('scale', String(scale));
  return form;
}

/**
 * Adds the image as the multipart file `image`.
 *
 * @param form the form
 * @param image the image's bytes and MIME type
 */
function appendImage(form: FormData, image: ImageInput): void {
  form.append(
    'image',
    new Blob([image.data as Uint8Array<ArrayBuffer>], { type: image.mimeType }),
    `image.${EXTENSIONS[image.mimeType]}`,
  );
}
