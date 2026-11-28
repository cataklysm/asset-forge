import type { SecretCodec } from '../src/main/secret-codec.js';

const MAGIC = Buffer.from('FAKECODEC1');

/** A reversible byte transform that provably differs from the plaintext; anything else does not decrypt. */
export class FakeCodec implements SecretCodec {
  canEncrypt = true;
  encryptCalls = 0;

  available(): boolean {
    return this.canEncrypt;
  }

  encrypt(text: string): Buffer {
    this.encryptCalls++;
    const bytes = Buffer.from(text, 'utf8').map((b) => b ^ 0x5a);
    return Buffer.concat([MAGIC, bytes.reverse()]);
  }

  decrypt(data: Buffer): string {
    if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('cannot decrypt');
    const bytes = Buffer.from(data.subarray(MAGIC.length))
      .reverse()
      .map((b) => b ^ 0x5a);
    return Buffer.from(bytes).toString('utf8');
  }
}
