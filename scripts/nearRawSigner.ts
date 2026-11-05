import { createPrivateKey, createPublicKey, sign as signBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function decodeBase58(value: string): Buffer {
  if (!value || [...value].some((character) => !ALPHABET.includes(character))) throw new Error('NEAR private key must contain a valid base58 key.');
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(ALPHABET.indexOf(character));
  const bytes: number[] = [];
  while (number > 0n) { bytes.unshift(Number(number & 0xffn)); number >>= 8n; }
  for (const character of value) { if (character !== '1') break; bytes.unshift(0); }
  return Buffer.from(bytes);
}

export function encodeBase58(value: Uint8Array): string {
  const bytes = Buffer.from(value);
  let number = BigInt(`0x${bytes.toString('hex') || '0'}`);
  let encoded = '';
  while (number > 0n) { const remainder = Number(number % 58n); encoded = ALPHABET[remainder] + encoded; number /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; encoded = `1${encoded}`; }
  return encoded || '1';
}

export interface NearRawEd25519Signer {
  accountId: string;
  publicKey: string;
  sign(payload: string): string;
}

export function createNearRawEd25519Signer(serializedKey: string): NearRawEd25519Signer {
  const [curve, encoded] = serializedKey.trim().split(':');
  if (curve !== 'ed25519' || !encoded) throw new Error('Tidepool settle key must be a NEAR ed25519:<base58 secret key>.');
  const keyBytes = decodeBase58(encoded);
  if (keyBytes.length !== 64) throw new Error('NEAR ed25519 private key must decode to 64 bytes.');
  const seed = keyBytes.subarray(0, 32);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicBytes = Buffer.from(publicDer).subarray(-32);
  if (!timingSafeEqual(publicBytes, keyBytes.subarray(32))) throw new Error('NEAR private key contains a mismatched Ed25519 public key.');
  return {
    accountId: publicBytes.toString('hex'),
    publicKey: `ed25519:${encodeBase58(publicBytes)}`,
    sign: (payload) => `ed25519:${encodeBase58(signBytes(null, Buffer.from(payload, 'utf8'), privateKey))}`,
  };
}
