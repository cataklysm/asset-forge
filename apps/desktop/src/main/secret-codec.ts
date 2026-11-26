import { safeStorage } from 'electron';

/** Encrypts secrets with the OS credential store. Everything except `createSafeStorageCodec` takes this port. */
export interface SecretCodec {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

/**
 * The only use of Electron's `safeStorage`. On Linux the `basic_text` backend is a hard-coded
 * password, so it counts as unavailable: there is no silent plaintext fallback.
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
