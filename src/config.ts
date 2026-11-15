import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // Coolify / Docker: prefer environment variables
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

export function findAgentByToken(
  config: RelayConfig,
  token: string
): RelayAgentConfig | undefined {
  return config.agents.find((a) => a.token === token);
}

export function findAgentById(
  config: RelayConfig,
  id: string
): RelayAgentConfig | undefined {
  return config.agents.find((a) => a.id === id);
}
