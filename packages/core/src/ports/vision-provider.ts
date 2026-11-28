/**
 * A vision provider; the model is an argument of every call, never bound to the instance. Each
 * method rejects with a `JobError` on provider failure, or with the signal's reason when `signal`
 * aborts. Implemented outside core.
 */
export interface VisionProvider {
  /**
   * Asks the model about an image for a structured answer.
   *
   * @param request the JPEG, the prompt, the answer format `schema`, the model and the abort signal
   * @returns the model's parsed JSON answer, requested in the format `schema`
   */
  analyzeImage(request: {
    image: Uint8Array;
    prompt: string;
    schema: unknown;
    model: string;
    signal: AbortSignal;
  }): Promise<unknown>;
  /**
   * Asks the model to describe an image in prose.
   *
   * @param request the JPEG, the prompt, the model and the abort signal
   * @returns the model's plain-text answer
   */
  describeImage(request: { image: Uint8Array; prompt: string; model: string; signal: AbortSignal }): Promise<string>;
  /**
   * The server's models.
   *
   * @param signal aborts the request
   * @returns the model names; `vision` is null when the server does not report capabilities
   */
  listModels(signal: AbortSignal): Promise<{ name: string; vision: boolean | null }[]>;
}

/** Renders an image for a vision model. Implemented outside core. */
export interface ModelImageSource {
  /**
   * Renders the image a vision model is sent.
   *
   * @param absolutePath the image file
   * @param signal when it aborts, a render still waiting for a worker is dropped and answers null; one already
   *   running may finish
   * @returns a JPEG of the image, longest edge at most 1024 px, EXIF-oriented; null when it cannot be produced
   */
  jpeg(absolutePath: string, signal?: AbortSignal): Promise<Uint8Array | null>;
}
