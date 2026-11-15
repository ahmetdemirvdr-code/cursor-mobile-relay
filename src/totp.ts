import { randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';

const ISSUER = 'CursorMobil';

/** Generate a Base32 secret (Google Authenticator “kurulum anahtarı” format). */
export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

function parseSecret(secret: string): OTPAuth.Secret {
  const cleaned = String(secret || '').replace(/\s+/g, '');
  // New secrets are Base32; older pending/users may still store hex
  if (/^[0-9a-f]+$/i.test(cleaned) && cleaned.length >= 32 && cleaned.length % 2 === 0) {
    try {
      return OTPAuth.Secret.fromHex(cleaned);
    } catch {
      // fall through
    }
  }
  return OTPAuth.Secret.fromBase32(cleaned);
}

function totpFromSecret(secret: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: parseSecret(secret),
  });
}

export function totpAuthUrl(secret: string, username: string): string {
  return totpFromSecret(secret, username).toString();
}

/** Base32 form for manual entry in authenticator apps. */
export function totpSecretForDisplay(secret: string): string {
  return parseSecret(secret).base32;
}

export function verifyTotpCode(secret: string, code: string, username = 'user'): boolean {
  const cleaned = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const delta = totpFromSecret(secret, username).validate({ token: cleaned, window: 1 });
  return delta !== null;
}
