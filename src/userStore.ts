import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RelayUser {
  agentId: string;
  username: string;
  passwordHash: string;
  agentToken: string;
  totpSecret: string;
  label: string;
  createdAt: number;
}

export interface PendingRegistration {
  id: string;
  agentId: string;
  username: string;
  passwordHash: string;
  label: string;
  totpSecret: string;
  expiresAt: number;
}

interface StoreFile {
  jwtSecret: string;
  users: RelayUser[];
  pending?: PendingRegistration[];
}

function dataDir(): string {
  return process.env.RELAY_DATA_DIR?.trim() || resolve(__dirname, '../data');
}

function storePath(): string {
  return resolve(dataDir(), 'users.json');
}

function ensureStore(): StoreFile {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = storePath();
  if (!existsSync(path)) {
    const fresh: StoreFile = {
      jwtSecret: randomBytes(48).toString('hex'),
      users: [],
      pending: [],
    };
    writeFileSync(path, JSON.stringify(fresh, null, 2), 'utf-8');
    return fresh;
  }
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoreFile;
  if (!Array.isArray(parsed.pending)) parsed.pending = [];
  return parsed;
}

function saveStore(store: StoreFile): void {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf-8');
}

function purgeExpiredPending(store: StoreFile): void {
  const now = Date.now();
  store.pending = (store.pending || []).filter((p) => p.expiresAt > now);
}

export function getJwtSecret(): string {
  return ensureStore().jwtSecret;
}

export function listUsers(): RelayUser[] {
  return [...ensureStore().users];
}

export function findUserByAgentId(agentId: string): RelayUser | undefined {
  const id = agentId.trim().toLowerCase();
  return ensureStore().users.find((u) => u.agentId === id);
}

export function findUserByUsername(username: string): RelayUser | undefined {
  const u = username.trim().toLowerCase();
  return ensureStore().users.find((x) => x.username.toLowerCase() === u);
}

export function findUserByAgentToken(token: string): RelayUser | undefined {
  return ensureStore().users.find((u) => u.agentToken === token);
}

/** Normalize agent name → id (slug). */
export function normalizeAgentId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

export function validateAgentId(agentId: string): string | null {
  if (agentId.length < 3) return 'Agent adı en az 3 karakter olmalı';
  if (agentId.length > 32) return 'Agent adı en fazla 32 karakter';
  if (!/^[a-z][a-z0-9_-]*$/.test(agentId)) {
    return 'Agent adı harfle başlamalı; sadece a-z, 0-9, _ ve -';
  }
  return null;
}

export function isAgentIdTaken(agentId: string, staticIds: string[] = []): boolean {
  const id = agentId.toLowerCase();
  if (staticIds.map((s) => s.toLowerCase()).includes(id)) return true;
  return !!findUserByAgentId(id);
}

export function createPendingRegistration(input: {
  agentId: string;
  username: string;
  passwordHash: string;
  totpSecret: string;
  label?: string;
}): PendingRegistration {
  const store = ensureStore();
  purgeExpiredPending(store);
  const agentId = normalizeAgentId(input.agentId);
  const username = input.username.trim();
  if (store.users.some((u) => u.agentId === agentId)) {
    throw new Error('Agent adı alınmış');
  }
  if (store.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('Kullanıcı adı alınmış');
  }
  // Replace any prior pending for same agent/username
  store.pending = (store.pending || []).filter(
    (p) =>
      p.agentId !== agentId && p.username.toLowerCase() !== username.toLowerCase()
  );
  const pending: PendingRegistration = {
    id: randomBytes(16).toString('hex'),
    agentId,
    username,
    passwordHash: input.passwordHash,
    label: input.label?.trim() || agentId,
    totpSecret: input.totpSecret,
    expiresAt: Date.now() + 15 * 60 * 1000,
  };
  store.pending!.push(pending);
  saveStore(store);
  return pending;
}

export function findPendingById(id: string): PendingRegistration | undefined {
  const store = ensureStore();
  purgeExpiredPending(store);
  saveStore(store);
  return (store.pending || []).find((p) => p.id === id);
}

export function confirmPendingRegistration(id: string): RelayUser {
  const store = ensureStore();
  purgeExpiredPending(store);
  const idx = (store.pending || []).findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('Kayıt oturumu süresi dolmuş; yeniden başlayın');
  const pending = store.pending![idx];
  if (store.users.some((u) => u.agentId === pending.agentId)) {
    throw new Error('Agent adı alınmış');
  }
  if (store.users.some((u) => u.username.toLowerCase() === pending.username.toLowerCase())) {
    throw new Error('Kullanıcı adı alınmış');
  }
  const user: RelayUser = {
    agentId: pending.agentId,
    username: pending.username,
    passwordHash: pending.passwordHash,
    agentToken: randomBytes(32).toString('hex'),
    totpSecret: pending.totpSecret,
    label: pending.label,
    createdAt: Date.now(),
  };
  store.pending!.splice(idx, 1);
  store.users.push(user);
  saveStore(store);
  return user;
}

/** Legacy helper — prefer pending + confirm. */
export function createUser(input: {
  agentId: string;
  username: string;
  passwordHash: string;
  totpSecret: string;
  label?: string;
}): RelayUser {
  const store = ensureStore();
  const agentId = normalizeAgentId(input.agentId);
  const username = input.username.trim();
  if (!input.totpSecret) throw new Error('TOTP secret zorunlu');
  if (store.users.some((u) => u.agentId === agentId)) {
    throw new Error('Agent adı alınmış');
  }
  if (store.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('Kullanıcı adı alınmış');
  }
  const user: RelayUser = {
    agentId,
    username,
    passwordHash: input.passwordHash,
    agentToken: randomBytes(32).toString('hex'),
    totpSecret: input.totpSecret,
    label: input.label?.trim() || agentId,
    createdAt: Date.now(),
  };
  store.users.push(user);
  saveStore(store);
  return user;
}

export function updateUserPassword(username: string, passwordHash: string): boolean {
  const store = ensureStore();
  const u = username.trim().toLowerCase();
  const user = store.users.find((x) => x.username.toLowerCase() === u);
  if (!user) return false;
  user.passwordHash = passwordHash;
  saveStore(store);
  return true;
}

export function setUserTotpSecret(username: string, totpSecret: string): boolean {
  const store = ensureStore();
  const u = username.trim().toLowerCase();
  const user = store.users.find((x) => x.username.toLowerCase() === u);
  if (!user) return false;
  user.totpSecret = totpSecret;
  saveStore(store);
  return true;
}
