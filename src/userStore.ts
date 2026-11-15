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
  label: string;
  createdAt: number;
}

interface StoreFile {
  jwtSecret: string;
  users: RelayUser[];
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
    };
    writeFileSync(path, JSON.stringify(fresh, null, 2), 'utf-8');
    return fresh;
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as StoreFile;
}

function saveStore(store: StoreFile): void {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf-8');
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

export function createUser(input: {
  agentId: string;
  username: string;
  passwordHash: string;
  label?: string;
}): RelayUser {
  const store = ensureStore();
  const agentId = normalizeAgentId(input.agentId);
  const username = input.username.trim();
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
    label: input.label?.trim() || agentId,
    createdAt: Date.now(),
  };
  store.users.push(user);
  saveStore(store);
  return user;
}
