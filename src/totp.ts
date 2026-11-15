import { randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';

const ISSUER = 'Cursor Mobil';

export function generateTotpSecret(): string {
  // 20 bytes → base32 secret suitable for authenticator apps
  return randomBytes(20).toString('hex');
}

function totpFromSecret(secret: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromHex(secret),
  });
}

export function totpAuthUrl(secret: string, username: string): string {
  return totpFromSecret(secret, username).toString();
}

export function verifyTotpCode(secret: string, code: string, username = 'user'): boolean {
  const cleaned = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const delta = totpFromSecret(secret, username).validate({ token: cleaned, window: 1 });
  return delta !== null;
}
