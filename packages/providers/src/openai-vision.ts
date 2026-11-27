import { ModelNameSchema } from '@assetforge/contracts';
import { JobError, type VisionProvider } from '@assetforge/core';
import { createJsonRequester, statusOf } from './json-request.js';
import { LIST_MODELS_TIMEOUT_MS, type OllamaVisionOptions } from './ollama-vision.js';
import { composeBody, DEFAULT_REQUEST_OPTIONS, openAiFixedFields } from './request-options.js';

export const OPENAI_PROVIDER = 'openai';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Keys of an OpenAI chat body whose objects `extra` merges into rather than replaces. */
const OPENAI_DEEP_KEYS = ['chat_template_kwargs', 'extra_body'] as const;

/** `listModels` keeps at most this many models, the same bound as the Ollama adapter. */
const MAX_LISTED_MODELS = 100;

/** The status a server without structured output answers a `response_format` with. */
const REFUSED_FORMAT_STATUS = 400;

export type OpenAiVisionOptions = OllamaVisionOptions;

const LEADING_THINK = /^\s*<think>[\s\S]*?<\/think>/;
/** Exactly one Markdown code fence: an optional language word, the body, the closing fence. */
const SINGLE_FENCE = /^```[\w+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/** Removes one leading <think>…</think> block (after optional whitespace); an unclosed block removes nothing. */
export function stripThinking(content: string): string {
  return content.replace(LEADING_THINK, '');
}

/** The tag JSON of a stripped, trimmed answer: the text itself, or the body of a single code fence. */
function parseTagging(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const fence = SINGLE_FENCE.exec(text);
    if (!fence || fence[1]!.includes('```')) throw error;
    return JSON.parse(fence[1]!) as unknown;
  }
}

/**
 * A `VisionProvider` over the OpenAI-compatible `POST /chat/completions` and `GET /models`
 * (vLLM, llama.cpp, LM Studio and others). Both paths are appended to `baseUrl` as given.
 * The key, when there is one, is sent as a bearer token on every request and only to `baseUrl`.
 */
export function createOpenAiVision(options: OpenAiVisionOptions): VisionProvider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const listTimeoutMs = options.listTimeoutMs ?? Math.min(timeoutMs, LIST_MODELS_TIMEOUT_MS);
  const requestOptions = options.requestOptions ?? DEFAULT_REQUEST_OPTIONS;
  const fixed = openAiFixedFields(requestOptions);
  const request = createJsonRequester(options);
  /** Models whose server refused `response_format` and accepted the request without it. */
  const withoutFormat = new Set<string>();

  function chat<T>(
    r: { image: Uint8Array; prompt: string; model: string; signal: AbortSignal },
    interpret: (text: string) => T,
    extraOwn: Record<string, unknown> = {},
    silent = false,
  ): Promise<T> {
    const url = `data:image/jpeg;base64,${Buffer.from(r.image).toString('base64')}`;
    return request(
      {
        path: '/chat/completions',
        signal: r.signal,
        timeoutMs,
        silent,
        // The adapter's own fields come last: `extra` can never change the model, the stream or the format.
        body: composeBody(
          fixed,
          requestOptions.extra,
          {
            model: r.model,
            stream: false,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: r.prompt },
                  { type: 'image_url', image_url: { url } },
                ],
              },
            ],
            ...extraOwn,
          },
          OPENAI_DEEP_KEYS,
        ),
      },
      (body) => {
        // `reasoning_content` is never read: only the answer itself counts.
        const content = (body as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message
          ?.content;
        if (typeof content !== 'string') throw new TypeError('no message content');
        const text = stripThinking(content).trim();
        if (text.length === 0) throw new TypeError('empty message content');
        return interpret(text);
      },
    );
  }

  return {
    async analyzeImage({ image, prompt, schema, model, signal }) {
      const r = { image, prompt, model, signal };
      if (withoutFormat.has(model)) return chat(r, parseTagging);

      const responseFormat = {
        response_format: { type: 'json_schema', json_schema: { name: 'tags', strict: true, schema } },
      };
      try {
        // Silent: only the final outcome is reported, and a refused format may still be repeated.
        return await chat(r, parseTagging, responseFormat, true);
      } catch (error) {
        if (!(error instanceof JobError)) throw error;
        if (statusOf(error) !== REFUSED_FORMAT_STATUS) {
          options.onFailure?.(error.code, statusOf(error));
          throw error;
        }
      }
      // A server without structured output: the prompt carries the JSON format line, so ask once more without it.
      const result = await chat(r, parseTagging);
      withoutFormat.add(model);
      return result;
    },

    describeImage({ image, prompt, model, signal }) {
      return chat({ image, prompt, model, signal }, (text) => text);
    },

    listModels(signal) {
      return request({ path: '/models', signal, timeoutMs: listTimeoutMs }, (body) => {
        const data = (body as { data?: unknown } | null)?.data;
        if (!Array.isArray(data)) throw new TypeError('no model list');
        return data
          .map((entry) => (entry as { id?: unknown } | null)?.id)
          .filter((id): id is string => ModelNameSchema.safeParse(id).success)
          .slice(0, MAX_LISTED_MODELS)
          .map((name) => ({ name, vision: null }));
      });
    },
  };
}
