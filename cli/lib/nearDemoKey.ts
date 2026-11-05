import { createPrivateKey, createPublicKey, generateKeyPairSync, timingSafeEqual } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function encodeBase58(value: Uint8Array): string {
  const bytes = Buffer.from(value);
  let number = BigInt(`0x${bytes.toString('hex') || '0'}`);
  let encoded = '';
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = ALPHABET[remainder] + encoded;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function decodeBase58(value: string): Buffer {
  if (!value || [...value].some((character) => !ALPHABET.includes(character))) throw new Error('Private key is not valid base58.');
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(ALPHABET.indexOf(character));
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 0xffn));
    number >>= 8n;
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

export interface NearDemoKeyPair {
  accountId: string;
  privateKey: string;
}

export function generateNearDemoKeyPair(): NearDemoKeyPair {
  const pair = generateKeyPairSync('ed25519');
  const privateDer = Buffer.from(pair.privateKey.export({ format: 'der', type: 'pkcs8' }));
  const publicDer = Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' }));
  const seed = privateDer.subarray(-32);
  const publicBytes = publicDer.subarray(-32);
  return {
    accountId: publicBytes.toString('hex'),
    privateKey: `ed25519:${encodeBase58(Buffer.concat([seed, publicBytes]))}`,
  };
}

export function nearDemoAccountId(privateKey: string): string {
  const [curve, encoded, ...extra] = privateKey.trim().split(':');
  if (curve !== 'ed25519' || !encoded || extra.length) throw new Error('NEAR key must use ed25519:<base58 secret> format.');
  const secret = decodeBase58(encoded);
  if (secret.length !== 64) throw new Error('NEAR Ed25519 secret must contain a 32-byte seed and 32-byte public key.');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, secret.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  const publicBytes = Buffer.from(createPublicKey(key).export({ format: 'der', type: 'spki' })).subarray(-32);
  if (!timingSafeEqual(publicBytes, secret.subarray(32))) throw new Error('NEAR private key has a mismatched public key.');
  return publicBytes.toString('hex');
}

export function nearDemoKeyMatches(privateKey: string, accountId: string): boolean {
  try { return nearDemoAccountId(privateKey) === accountId; } catch { return false; }
}
