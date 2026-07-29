import crypto from 'node:crypto';
import { env } from '../env.js';

// AES-256-GCM. Key is 32 bytes derived from ENCRYPTION_KEY (hex or passphrase).
function getKey() {
  const raw = env.ENCRYPTION_KEY;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  // Fallback: derive a 32-byte key from an arbitrary passphrase.
  return crypto.createHash('sha256').update(raw).digest();
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decrypt(payload) {
  const [ivHex, tagHex, ctHex] = String(payload).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}
