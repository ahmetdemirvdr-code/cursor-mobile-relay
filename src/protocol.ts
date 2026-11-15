/** Shared wire protocol between VDS relay and PC bridge agent. */

export type AgentToRelay =
  | { type: 'agent_hello'; agentId: string; token: string }
  | {
      type: 'http_proxy_result';
      id: string;
      status: number;
      headers: Record<string, string>;
      bodyBase64: string;
    }
  | { type: 'ws_server'; sessionId: string; data: string }
  | { type: 'ws_close'; sessionId: string; code?: number; reason?: string };

export type RelayToAgent =
  | { type: 'agent_hello_ok'; agentId: string }
  | { type: 'agent_hello_fail'; error: string }
  | {
      type: 'http_proxy';
      id: string;
      method: string;
      path: string;
      headers: Record<string, string>;
      bodyBase64?: string;
    }
  | { type: 'ws_open'; sessionId: string }
  | { type: 'ws_client'; sessionId: string; data: string }
  | { type: 'ws_close'; sessionId: string; code?: number; reason?: string };
