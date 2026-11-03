import { generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function randomSecretHex(): string {
  return randomBytes(32).toString('hex');
}

export function generateAttestationKeyPair(directory: string): { privatePath: string; publicPath: string } {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync('ed25519');
  const privatePath = path.join(directory, 'attestation-private.pem');
  const publicPath = path.join(directory, 'attestation-public.pem');
  let privateCreated = false;
  const publicExisted = fs.existsSync(publicPath);
  try {
    fs.writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    privateCreated = true;
    fs.writeFileSync(publicPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if (privateCreated && fs.existsSync(privatePath)) fs.unlinkSync(privatePath);
    if (!publicExisted && fs.existsSync(publicPath)) fs.unlinkSync(publicPath);
    throw error;
  }
  return { privatePath, publicPath };
}
