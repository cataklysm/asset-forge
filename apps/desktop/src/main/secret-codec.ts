import { safeStorage } from 'electron';

/** Encrypts secrets with the OS credential store. Everything except `createSafeStorageCodec` takes this port. */
export interface SecretCodec {
  /** @returns whether a usable credential backend exists */
  available(): boolean;
  /**
   * @param text the secret
   * @returns its encrypted form
   */
  encrypt(text: string): Buffer;
  /**
   * @param data an encrypted secret
   * @returns the secret
   */
  decrypt(data: Buffer): string;
}

/**
 * The only use of Electron's `safeStorage`. On Linux the `basic_text` backend is a hard-coded
 * password, so it counts as unavailable: there is no silent plaintext fallback.
 *
 * @returns the codec
 */
export function createSafeStorageCodec(): SecretCodec {
  return {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  };
}
