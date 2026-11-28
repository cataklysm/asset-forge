import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@assetforge/contracts';

/** What the preload hands the renderer as `window.assetForge`. */
export interface AssetForgeApi {
  /**
   * Sends one request to the main process.
   *
   * @param channel the channel
   * @param request the request, validated in main
   * @returns the result
   */
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>>;
}

declare global {
  interface Window {
    /** The IPC bridge of the preload. */
    readonly assetForge: AssetForgeApi;
  }
}
