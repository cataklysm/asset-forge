import { ModelNameSchema, type VisionRequestOptions } from '@assetforge/contracts';
import { JobError, type VisionProvider } from '@assetforge/core';
import { createJsonRequester, statusOf, type JsonRequest } from './json-request.js';
import { LIST_MODELS_TIMEOUT_MS, type OllamaVisionOptions } from './ollama-vision.js';
import { composeBody, DEFAULT_REQUEST_OPTIONS, openAiFixedFields } from './request-options.js';

/** The provider id of an OpenAI-compatible entry, part of the analysis fingerprint. */
export const OPENAI_PROVIDER = 'openai';

/** The time limit of a chat request when none is configured. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Keys of an OpenAI chat body whose objects `extra` merges into rather than replaces. */
const OPENAI_DEEP_KEYS = ['chat_template_kwargs', 'extra_body'] as const;

/** `listModels` keeps at most this many models, the same bound as the Ollama adapter. */
const MAX_LISTED_MODELS = 100;

/** The status a server without structured output answers a `response_format` with. */
const REFUSED_FORMAT_STATUS = 400;

/** What `createOpenAiVision` is configured with: the same options as the Ollama adapter. */
export type OpenAiVisionOptions = OllamaVisionOptions;

/** One leading think block after optional whitespace. */
const LEADING_THINK = /^\s*<think>[\s\S]*?<\/think>/;
/** Exactly one Markdown code fence: an optional language word, the body, the closing fence. */
const SINGLE_FENCE = /^```[\w+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/** One chat request: the image, the prompt, the model and the caller's signal. */
interface ChatInput {
  /** The image's bytes, sent as a JPEG data URL. */
  image: Uint8Array;
  /** The prompt text. */
  prompt: string;
  /** The model name. */
  model: string;
  /** Aborts the request. */
  signal: AbortSignal;
}

/** One listed model with its vision capability, null when unknown. */
type VisionModel = Awaited<ReturnType<VisionProvider['listModels']>>[number];

/** What a requester of `createJsonRequester` is. */
type JsonRequester = ReturnType<typeof createJsonRequester>;

/**
 * Removes one leading <think>…</think> block (after optional whitespace); an unclosed block removes nothing.
 *
 * @param content the answer's content
 * @returns the content without the block
 */
export function stripThinking(content: string): string {
  return content.replace(LEADING_THINK, '');
}

/**
 * The tag JSON of a stripped, trimmed answer: the text itself, or the body of a single code fence.
 *
 * @param text the answer's text
 * @returns the parsed JSON
 * @throws SyntaxError when neither the text nor a single fence's body is JSON
 */
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
 * The answer's text as it is.
 *
 * @param text the answer's text
 * @returns the text
 */
function asText(text: string): string {
  return text;
}

/**
 * The text of a chat completion answer: the first choice's content without a leading think block, trimmed.
 *
 * @param body the parsed answer
 * @returns the text
 * @throws TypeError when the answer has no string content or the text is empty
 */
function answerText(body: unknown): string {
  // `reasoning_content` is never read: only the answer itself counts.
  const content = (body as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new TypeError('no message content');
  const text = stripThinking(content).trim();
  if (text.length === 0) throw new TypeError('empty message content');
  return text;
}

/**
 * The models of a `/models` answer, with an unknown vision capability.
 *
 * @param body the parsed answer
 * @returns at most `MAX_LISTED_MODELS` models whose ids pass `ModelNameSchema`
 * @throws TypeError when the answer has no model list
 */
function listedModels(body: unknown): VisionModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new TypeError('no model list');
  return data
    .map((entry) => (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => ModelNameSchema.safeParse(id).success)
    .slice(0, MAX_LISTED_MODELS)
    .map((name) => ({ name, vision: null }));
}

/**
 * A `VisionProvider` over the OpenAI-compatible `POST /chat/completions` and `GET /models`
 * (vLLM, llama.cpp, LM Studio and others). Both paths are appended to `baseUrl` as given.
 * The key, when there is one, is sent as a bearer token on every request and only to `baseUrl`.
 *
 * @param options the base URL, the key supplier, the time limits, the fetch, the failure report and the request
 *   options
 * @returns the provider
 */
export function createOpenAiVision(options: OpenAiVisionOptions): VisionProvider {
  const vision = new OpenAiVision(options);
  return {
    analyzeImage: (request) => vision.analyzeImage(request),
    describeImage: (request) => vision.describeImage(request),
    listModels: (signal) => vision.listModels(signal),
  };
}

/** The configured limits, the fixed body fields, the requester and the format memory of one entry. */
class OpenAiVision {
  /** The time limit of a chat request. */
  private readonly timeoutMs: number;
  /** The time limit of the model list. */
  private readonly listTimeoutMs: number;
  /** The request options in force. */
  private readonly requestOptions: VisionRequestOptions;
  /** The body fields the request options set. */
  private readonly fixed: ReturnType<typeof openAiFixedFields>;
  /** Sends one request. */
  private readonly request: JsonRequester;
  /** Models whose server refused `response_format` and accepted the request without it. */
  private readonly withoutFormat = new Set<string>();

  /**
   * @param options the options the provider was created with
   */
  constructor(private readonly options: OpenAiVisionOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.listTimeoutMs = options.listTimeoutMs ?? Math.min(this.timeoutMs, LIST_MODELS_TIMEOUT_MS);
    this.requestOptions = options.requestOptions ?? DEFAULT_REQUEST_OPTIONS;
    this.fixed = openAiFixedFields(this.requestOptions);
    this.request = createJsonRequester(options);
  }

  /**
   * Tags an image with `response_format` `json_schema`; after an HTTP 400 once more without it, remembered per model.
   *
   * @param request the image, the prompt, the schema, the model and the signal
   * @returns the parsed answer
   */
  async analyzeImage({ image, prompt, schema, model, signal }: Parameters<VisionProvider['analyzeImage']>[0]) {
    const r = { image, prompt, model, signal };
    if (this.withoutFormat.has(model)) return this.chat(r, parseTagging);

    const responseFormat = {
      response_format: { type: 'json_schema', json_schema: { name: 'tags', strict: true, schema } },
    };
    try {
      // Silent: only the final outcome is reported, and a refused format may still be repeated.
      return await this.chat(r, parseTagging, responseFormat, true);
    } catch (error) {
      if (!(error instanceof JobError)) throw error;
      if (statusOf(error) !== REFUSED_FORMAT_STATUS) {
        this.options.onFailure?.(error.code, statusOf(error));
        throw error;
      }
    }
    // A server without structured output: the prompt carries the JSON format line, so ask once more without it.
    const result = await this.chat(r, parseTagging);
    this.withoutFormat.add(model);
    return result;
  }

  /**
   * Describes an image.
   *
   * @param request the image, the prompt, the model and the signal
   * @returns the answer's text
   */
  describeImage({ image, prompt, model, signal }: Parameters<VisionProvider['describeImage']>[0]): Promise<string> {
    return this.chat({ image, prompt, model, signal }, asText);
  }

  /**
   * The models through `GET /models`, within `listTimeoutMs`.
   *
   * @param signal aborts the call
   * @returns the models
   */
  listModels(signal: AbortSignal): Promise<VisionModel[]> {
    return this.request({ path: '/models', signal, timeoutMs: this.listTimeoutMs }, listedModels);
  }

  /**
   * One chat completion request.
   *
   * @param r the image, the prompt, the model and the signal
   * @param interpret turns the answer's text into the result
   * @param extraOwn further fields of the adapter's own, such as `response_format`
   * @param silent when true, a failure is not reported
   * @returns the result
   */
  private chat<T>(
    r: ChatInput,
    interpret: (text: string) => T,
    extraOwn: Record<string, unknown> = {},
    silent = false,
  ): Promise<T> {
    const url = `data:image/jpeg;base64,${Buffer.from(r.image).toString('base64')}`;
    const request: JsonRequest = {
      path: '/chat/completions',
      signal: r.signal,
      timeoutMs: this.timeoutMs,
      silent,
      // The adapter's own fields come last: `extra` can never change the model, the stream or the format.
      body: composeBody(
        this.fixed,
        this.requestOptions.extra,
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
    };
    return this.request(request, (body) => interpret(answerText(body)));
  }
}
