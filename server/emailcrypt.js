// Emails are encrypted in the database (AES-256-GCM). Because each encryption
// comes out different, lookups (login by email, "already used", forgot password)
// go through email_hash: a keyed HMAC of the normalised address.
//
// EMAIL_KEY is 32 random bytes, base64, set in the environment and never stored
// with the data, so a copy of the database or a backup can't be read without it.
// Lose the key and the addresses are gone for good.
import crypto from 'node:crypto';

const raw = Buffer.from(String(process.env.EMAIL_KEY || ''), 'base64');
if (raw.length !== 32) throw new Error('EMAIL_KEY must be set to 32 random bytes in base64 (openssl rand -base64 32).');
const derive = label => Buffer.from(crypto.hkdfSync('sha256', raw, Buffer.alloc(0), label, 32));
const encKey = derive('pcc-email-encrypt-v1');
const macKey = derive('pcc-email-lookup-v1');
const PREFIX = 'enc1:';

export const normaliseEmail = email => String(email || '').trim().toLowerCase();
export const isEncrypted = value => String(value || '').startsWith(PREFIX);
export const hashEmail = email => crypto.createHmac('sha256', macKey).update(normaliseEmail(email)).digest('base64url');

// What a person sees of their own address: ni***@proton.me (one letter if the
// name part is 3 characters or fewer). The full address never leaves the server.
export function maskEmail(email) {
  const at = email.lastIndexOf('@');
  if (at < 1) return '';
  return `${email.slice(0, at > 3 ? 2 : 1)}***${email.slice(at)}`;
}

export function encryptEmail(email) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([cipher.update(normaliseEmail(email), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

export function decryptEmail(value) {
  if (!value) return '';
  const buf = Buffer.from(String(value).slice(PREFIX.length), 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
