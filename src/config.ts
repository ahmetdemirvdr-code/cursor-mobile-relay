import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUserByAgentId, findUserByAgentToken, listUsers } from './userStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '../config.json');

export interface RelayAgentConfig {
  id: string;
  token: string;
  label?: string;
}

export interface RelayConfig {
  port: number;
  defaultAgentId: string;
  agents: RelayAgentConfig[];
  httpProxyTimeoutMs: number;
}

const DEFAULTS: RelayConfig = {
  port: 8080,
  defaultAgentId: 'default',
  agents: [
    {
      id: 'default',
      token: 'CHANGE_ME_LONG_RANDOM_AGENT_TOKEN',
      label: 'Home PC',
    },
  ],
  httpProxyTimeoutMs: 60_000,
};

function fromEnv(): Partial<RelayConfig> | null {
  const token = process.env.RELAY_AGENT_TOKEN?.trim();
  if (!token) return null;
  const agentId = process.env.RELAY_AGENT_ID?.trim() || 'default';
  return {
    port: process.env.RELAY_PORT ? Number(process.env.RELAY_PORT) : DEFAULTS.port,
    defaultAgentId: process.env.RELAY_DEFAULT_AGENT_ID?.trim() || agentId,
    agents: [
      {
        id: agentId,
        token,
        label: process.env.RELAY_AGENT_LABEL?.trim() || 'Home PC',
      },
    ],
    httpProxyTimeoutMs: process.env.RELAY_HTTP_TIMEOUT_MS
      ? Number(process.env.RELAY_HTTP_TIMEOUT_MS)
      : DEFAULTS.httpProxyTimeoutMs,
  };
}

export function loadRelayConfig(): RelayConfig {
  const envCfg = fromEnv();
  if (envCfg?.agents?.length) {
    return {
      port: envCfg.port ?? DEFAULTS.port,
      defaultAgentId: envCfg.defaultAgentId ?? DEFAULTS.defaultAgentId,
      agents: envCfg.agents,
      httpProxyTimeoutMs: envCfg.httpProxyTimeoutMs ?? DEFAULTS.httpProxyTimeoutMs,
    };
  }

  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), 'utf-8');
    return { ...DEFAULTS, agents: [...DEFAULTS.agents] };
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<RelayConfig>;
  const agents = Array.isArray(raw.agents)
    ? raw.agents
        .filter((a) => a && typeof a.id === 'string' && typeof a.token === 'string')
        .map((a) => ({
          id: a.id.trim(),
          token: a.token.trim(),
          label: typeof a.label === 'string' ? a.label : undefined,
        }))
        .filter((a) => a.id && a.token)
    : [...DEFAULTS.agents];

  return {
    port: typeof raw.port === 'number' ? raw.port : DEFAULTS.port,
    defaultAgentId:
      typeof raw.defaultAgentId === 'string' && raw.defaultAgentId.trim()
        ? raw.defaultAgentId.trim()
        : agents[0]?.id || DEFAULTS.defaultAgentId,
    agents,
    httpProxyTimeoutMs:
      typeof raw.httpProxyTimeoutMs === 'number' ? raw.httpProxyTimeoutMs : DEFAULTS.httpProxyTimeoutMs,
  };
}

/** Static config agents + self-registered users. */
export function allKnownAgents(config: RelayConfig): RelayAgentConfig[] {
  const map = new Map<string, RelayAgentConfig>();
  for (const a of config.agents) map.set(a.id, a);
  for (const u of listUsers()) {
    map.set(u.agentId, { id: u.agentId, token: u.agentToken, label: u.label });
  }
  return [...map.values()];
}

export function findAgentByToken(
  config: RelayConfig,
  token: string
): RelayAgentConfig | undefined {
  const fromConfig = config.agents.find((a) => a.token === token);
  if (fromConfig) return fromConfig;
  const user = findUserByAgentToken(token);
  if (user) return { id: user.agentId, token: user.agentToken, label: user.label };
  return undefined;
}

export function findAgentById(
  config: RelayConfig,
  id: string
): RelayAgentConfig | undefined {
  const fromConfig = config.agents.find((a) => a.id === id);
  if (fromConfig) return fromConfig;
  const user = findUserByAgentId(id);
  if (user) return { id: user.agentId, token: user.agentToken, label: user.label };
  return undefined;
}

export function staticAgentIds(config: RelayConfig): string[] {
  return config.agents.map((a) => a.id);
}
