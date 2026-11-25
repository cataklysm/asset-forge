import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@assetforge/contracts';

export interface AssetForgeApi {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>>;
}

declare global {
  interface Window {
    readonly assetForge: AssetForgeApi;
  }
}
