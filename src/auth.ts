import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from './userStore.js';

export interface RelayJwtPayload {
  username: string;
  agentId: string;
  relay: true;
  iat?: number;
  exp?: number;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signRelayToken(username: string, agentId: string): string {
  return jwt.sign(
    { username, agentId, relay: true } satisfies Omit<RelayJwtPayload, 'iat' | 'exp'>,
    getJwtSecret(),
    { expiresIn: '7d' }
  );
}

export function verifyRelayToken(token: string): RelayJwtPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as RelayJwtPayload;
    if (!decoded?.relay || !decoded.agentId || !decoded.username) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function bearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}
