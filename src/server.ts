import express from 'express';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type { IncomingMessage } from 'node:http';
import {
  loadRelayConfig,
  findAgentByToken,
  findAgentById,
  type RelayConfig,
} from './config.js';
import type { AgentToRelay, RelayToAgent } from './protocol.js';

interface PendingHttp {
  resolve: (value: {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AgentSession {
  agentId: string;
  ws: WebSocket;
  pendingHttp: Map<string, PendingHttp>;
  phoneSessions: Map<string, WebSocket>;
}

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function sendAgent(ws: WebSocket, msg: RelayToAgent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function pickAgentId(req: express.Request | IncomingMessage, config: RelayConfig): string {
  const header =
    'headers' in req
      ? (req.headers['x-cursor-agent-id'] as string | undefined)
      : undefined;
  if (header && header.trim()) return header.trim();

  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const q = url.searchParams.get('agent');
    if (q && q.trim()) return q.trim();
  } catch {
    // ignore
  }
  return config.defaultAgentId;
}

export function startRelayServer(): http.Server {
  const config = loadRelayConfig();
  const agents = new Map<string, AgentSession>();

  const app = express();
  // Capture raw body for proxy (JSON + other)
  app.use(
    express.raw({
      type: '*/*',
      limit: '20mb',
    })
  );

  app.get('/', (_req, res) => {
    const list = config.agents.map((a) => ({
      id: a.id,
      label: a.label || a.id,
      connected: agents.has(a.id),
    }));
    res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Cursor Mobile Relay</title></head>
<body style="font-family:sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem">
  <h1>Cursor Mobile Relay</h1>
  <p>Telefon bu adrese bağlanır. PC bridge agent outbound bağlanır.</p>
  <h2>Agent durumu</h2>
  <ul>
    ${list
      .map(
        (a) =>
          `<li><b>${a.label}</b> (${a.id}) — ${
            a.connected ? '<span style="color:green">bağlı</span>' : '<span style="color:#c00">kopuk</span>'
          }</li>`
      )
      .join('')}
  </ul>
  <p><a href="/api/relay/status">JSON status</a></p>
</body></html>`);
  });

  app.get('/api/relay/status', (_req, res) => {
    res.json({
      ok: true,
      defaultAgentId: config.defaultAgentId,
      agents: config.agents.map((a) => ({
        id: a.id,
        label: a.label || a.id,
        connected: agents.has(a.id),
      })),
    });
  });

  // Transparent API proxy → connected agent → localhost bridge
  app.all('/api/*', async (req, res) => {
    const agentId = pickAgentId(req, config);
    const session = agents.get(agentId);
    if (!session) {
      res.status(503).json({
        success: false,
        error: 'PC bağlı değil',
        code: 'AGENT_OFFLINE',
        agentId,
      });
      return;
    }

    const id = uuidv4();
    const pathWithQuery = req.originalUrl || req.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      if (k === 'host' || k === 'connection' || k === 'content-length') continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }

    const bodyBuf = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : '');

    const resultPromise = new Promise<{
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    }>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingHttp.delete(id);
        reject(new Error('Agent HTTP proxy timeout'));
      }, config.httpProxyTimeoutMs);
      session.pendingHttp.set(id, { resolve, reject, timer });
    });

    sendAgent(session.ws, {
      type: 'http_proxy',
      id,
      method: req.method,
      path: pathWithQuery,
      headers,
      bodyBase64: bodyBuf.length ? bodyBuf.toString('base64') : undefined,
    });

    try {
      const result = await resultPromise;
      for (const [k, v] of Object.entries(result.headers)) {
        const lower = k.toLowerCase();
        if (lower === 'transfer-encoding' || lower === 'connection' || lower === 'content-length') {
          continue;
        }
        res.setHeader(k, v);
      }
      res.status(result.status).send(result.body);
    } catch (err) {
      log('warn', `HTTP proxy failed agent=${agentId}: ${err}`);
      res.status(504).json({
        success: false,
        error: 'PC yanıt vermedi',
        code: 'AGENT_TIMEOUT',
        agentId,
      });
    }
  });

  const server = http.createServer(app);
  const wssPhone = new WebSocketServer({ noServer: true });
  const wssAgent = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/agent') {
      wssAgent.handleUpgrade(req, socket, head, (ws) => {
        wssAgent.emit('connection', ws, req);
      });
      return;
    }
    if (url.pathname === '/ws') {
      wssPhone.handleUpgrade(req, socket, head, (ws) => {
        wssPhone.emit('connection', ws, req);
      });
      return;
    }
    socket.destroy();
  });

  wssAgent.on('connection', (ws) => {
    let authed: AgentSession | null = null;

    ws.on('message', (raw) => {
      let msg: AgentToRelay;
      try {
        msg = JSON.parse(raw.toString()) as AgentToRelay;
      } catch {
        return;
      }

      if (msg.type === 'agent_hello') {
        const cfg = findAgentByToken(config, msg.token);
        if (!cfg || cfg.id !== msg.agentId) {
          sendAgent(ws, { type: 'agent_hello_fail', error: 'Invalid agent credentials' });
          ws.close(4001, 'auth failed');
          return;
        }
        // Replace existing agent connection
        const prev = agents.get(cfg.id);
        if (prev && prev.ws !== ws) {
          try {
            prev.ws.close(4000, 'replaced');
          } catch {
            // ignore
          }
          for (const [, phoneWs] of prev.phoneSessions) {
            try {
              phoneWs.close(1011, 'agent replaced');
            } catch {
              // ignore
            }
          }
          for (const [, p] of prev.pendingHttp) {
            clearTimeout(p.timer);
            p.reject(new Error('Agent replaced'));
          }
        }

        authed = {
          agentId: cfg.id,
          ws,
          pendingHttp: new Map(),
          phoneSessions: new Map(),
        };
        agents.set(cfg.id, authed);
        sendAgent(ws, { type: 'agent_hello_ok', agentId: cfg.id });
        log('info', `Agent connected: ${cfg.id}`);
        return;
      }

      if (!authed) return;

      if (msg.type === 'http_proxy_result') {
        const pending = authed.pendingHttp.get(msg.id);
        if (!pending) return;
        authed.pendingHttp.delete(msg.id);
        clearTimeout(pending.timer);
        pending.resolve({
          status: msg.status,
          headers: msg.headers || {},
          body: Buffer.from(msg.bodyBase64 || '', 'base64'),
        });
        return;
      }

      if (msg.type === 'ws_server') {
        const phone = authed.phoneSessions.get(msg.sessionId);
        if (phone && phone.readyState === WebSocket.OPEN) {
          phone.send(msg.data);
        }
        return;
      }

      if (msg.type === 'ws_close') {
        const phone = authed.phoneSessions.get(msg.sessionId);
        authed.phoneSessions.delete(msg.sessionId);
        if (phone && phone.readyState === WebSocket.OPEN) {
          phone.close(msg.code || 1000, msg.reason || '');
        }
      }
    });

    ws.on('close', () => {
      if (!authed) return;
      if (agents.get(authed.agentId)?.ws === ws) {
        agents.delete(authed.agentId);
        log('info', `Agent disconnected: ${authed.agentId}`);
        for (const [, phoneWs] of authed.phoneSessions) {
          try {
            phoneWs.close(1011, 'PC bağlantısı koptu');
          } catch {
            // ignore
          }
        }
        for (const [, p] of authed.pendingHttp) {
          clearTimeout(p.timer);
          p.reject(new Error('Agent disconnected'));
        }
      }
    });
  });

  wssPhone.on('connection', (ws, req) => {
    const agentId = pickAgentId(req, config);
    if (!findAgentById(config, agentId)) {
      ws.close(4004, 'Unknown agent');
      return;
    }
    const session = agents.get(agentId);
    if (!session) {
      ws.send(
        JSON.stringify({
          type: 'error',
          id: uuidv4(),
          timestamp: Date.now(),
          code: 'AGENT_OFFLINE',
          message: 'PC bağlı değil',
        })
      );
      ws.close(1013, 'PC offline');
      return;
    }

    const sessionId = uuidv4();
    session.phoneSessions.set(sessionId, ws);
    sendAgent(session.ws, { type: 'ws_open', sessionId });
    log('info', `Phone WS opened session=${sessionId.slice(0, 8)}… agent=${agentId}`);

    ws.on('message', (raw) => {
      const current = agents.get(agentId);
      if (!current || current.ws.readyState !== WebSocket.OPEN) {
        ws.close(1011, 'PC offline');
        return;
      }
      sendAgent(current.ws, {
        type: 'ws_client',
        sessionId,
        data: raw.toString(),
      });
    });

    ws.on('close', () => {
      const current = agents.get(agentId);
      if (current) {
        current.phoneSessions.delete(sessionId);
        sendAgent(current.ws, { type: 'ws_close', sessionId });
      }
      log('info', `Phone WS closed session=${sessionId.slice(0, 8)}…`);
    });
  });

  server.listen(config.port, () => {
    log('info', `Relay listening on :${config.port}`);
    log('info', `  Phone HTTP/WS: http://0.0.0.0:${config.port}/  and /ws`);
    log('info', `  Agent WS:      ws://0.0.0.0:${config.port}/agent`);
    log('info', `  Default agent: ${config.defaultAgentId}`);
  });

  return server;
}
