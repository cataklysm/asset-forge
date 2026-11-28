/**
 * A vision provider; the model is an argument of every call, never bound to the instance. Each
 * method rejects with a `JobError` on provider failure, or with the signal's reason when `signal`
 * aborts. Implemented outside core.
 */
export interface VisionProvider {
  /** Resolves with the model's parsed JSON answer, requested in the format `schema`. */
  analyzeImage(r: { image: Uint8Array; prompt: string; schema: unknown; model: string; signal: AbortSignal }): Promise<unknown>;
  /** Resolves with the model's plain-text answer. */
  describeImage(r: { image: Uint8Array; prompt: string; model: string; signal: AbortSignal }): Promise<string>;
  /** The server's models; `vision` is null when the server does not report capabilities. */
  listModels(signal: AbortSignal): Promise<{ name: string; vision: boolean | null }[]>;
}

/** Renders an image for a vision model. Implemented outside core. */
export interface ModelImageSource {
  /** A JPEG of the image, longest edge at most 1024 px, EXIF-oriented; null when it cannot be produced. */
  jpeg(absolutePath: string): Promise<Uint8Array | null>;
}
