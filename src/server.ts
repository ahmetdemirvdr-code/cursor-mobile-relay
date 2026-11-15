import express from 'express';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type { IncomingMessage } from 'node:http';
import {
  loadRelayConfig,
  findAgentByToken,
  findAgentById,
  allKnownAgents,
  staticAgentIds,
  type RelayConfig,
} from './config.js';
import type { AgentToRelay, RelayToAgent } from './protocol.js';
import {
  confirmPendingRegistration,
  createPendingRegistration,
  findPendingById,
  findUserByUsername,
  isAgentIdTaken,
  normalizeAgentId,
  updateUserPassword,
  validateAgentId,
  listUsers,
} from './userStore.js';
import {
  bearerToken,
  hashPassword,
  signRelayToken,
  verifyPassword,
  verifyRelayToken,
} from './auth.js';
import { generateTotpSecret, totpAuthUrl, totpSecretForDisplay, verifyTotpCode } from './totp.js';

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
  agentToken: string;
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

function parseJsonBody(req: express.Request): Record<string, unknown> {
  const buf = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === 'string' ? req.body : '');
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function pickAgentId(
  req: express.Request | IncomingMessage,
  config: RelayConfig,
  authHeader?: string
): string {
  const token = bearerToken(
    authHeader ||
      ('headers' in req ? (req.headers.authorization as string | undefined) : undefined)
  );
  if (token) {
    const payload = verifyRelayToken(token);
    if (payload?.agentId) return payload.agentId;
  }

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

async function proxyToAgent(
  agents: Map<string, AgentSession>,
  config: RelayConfig,
  agentId: string,
  req: express.Request,
  res: express.Response
): Promise<void> {
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
  // PC accepts localhost proxy with this header (matches agent token)
  headers['x-cursor-relay-proxy'] = session.agentToken;

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
}

export function startRelayServer(): http.Server {
  const config = loadRelayConfig();
  const agents = new Map<string, AgentSession>();

  const app = express();
  app.use(
    express.raw({
      type: '*/*',
      limit: '20mb',
    })
  );

  app.get('/', (_req, res) => {
    const list = allKnownAgents(config).map((a) => ({
      id: a.id,
      label: a.label || a.id,
      connected: agents.has(a.id),
    }));
    res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Cursor Mobile Relay</title></head>
<body style="font-family:sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem">
  <h1>Cursor Mobile Relay</h1>
  <p>Kayıt / giriş telefonda. Her agent kendi PC'sine bağlanır.</p>
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
      registration: true,
      agents: allKnownAgents(config).map((a) => ({
        id: a.id,
        label: a.label || a.id,
        connected: agents.has(a.id),
      })),
      registeredUsers: listUsers().length,
    });
  });

  // Live uniqueness check while typing
  app.get('/api/relay/check-agent', (req, res) => {
    const raw = String(req.query.name || '');
    const agentId = normalizeAgentId(raw);
    const formatError = validateAgentId(agentId);
    if (formatError) {
      res.json({ available: false, agentId, reason: formatError });
      return;
    }
    const taken = isAgentIdTaken(agentId, staticAgentIds(config));
    res.json({
      available: !taken,
      agentId,
      reason: taken ? 'Bu agent adı alınmış' : null,
    });
  });

  // Step 1: create pending registration + TOTP secret (account not active yet)
  app.post('/api/relay/register', async (req, res) => {
    const body = parseJsonBody(req);
    const agentName = String(body.agentName || body.agentId || '');
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const agentId = normalizeAgentId(agentName);

    const formatError = validateAgentId(agentId);
    if (formatError) {
      res.status(400).json({ success: false, error: formatError });
      return;
    }
    if (username.length < 3) {
      res.status(400).json({ success: false, error: 'Kullanıcı adı en az 3 karakter' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ success: false, error: 'Şifre en az 6 karakter' });
      return;
    }
    if (isAgentIdTaken(agentId, staticAgentIds(config))) {
      res.status(409).json({ success: false, error: 'Bu agent adı alınmış' });
      return;
    }
    if (findUserByUsername(username)) {
      res.status(409).json({ success: false, error: 'Bu kullanıcı adı alınmış' });
      return;
    }

    try {
      const passwordHash = await hashPassword(password);
      const totpSecret = generateTotpSecret();
      const pending = createPendingRegistration({
        agentId,
        username,
        passwordHash,
        totpSecret,
        label: agentName.trim() || agentId,
      });
      log('info', `Pending register agent=${pending.agentId} user=${pending.username}`);
      res.status(201).json({
        success: true,
        pendingId: pending.id,
        agentId: pending.agentId,
        username: pending.username,
        // Base32 — Google Authenticator “kurulum anahtarı” alanına bunu yapıştır
        totpSecret: totpSecretForDisplay(pending.totpSecret),
        otpauthUrl: totpAuthUrl(pending.totpSecret, pending.username),
        totpRequired: true,
        message:
          'Google Authenticator → Hesap ekle → Kurulum anahtarı gir. Anahtarı yapıştır (otpauth URL değil). Zaman tabanlı.',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ success: false, error: msg });
    }
  });

  // Step 2: confirm TOTP → activate user + return agentToken + JWT
  app.post('/api/relay/register/confirm', async (req, res) => {
    const body = parseJsonBody(req);
    const pendingId = String(body.pendingId || '').trim();
    const totpCode = String(body.totpCode || body.code || '').trim();
    if (!pendingId) {
      res.status(400).json({ success: false, error: 'pendingId gerekli' });
      return;
    }
    const pending = findPendingById(pendingId);
    if (!pending) {
      res.status(400).json({ success: false, error: 'Kayıt oturumu süresi dolmuş; yeniden başlayın' });
      return;
    }
    if (!verifyTotpCode(pending.totpSecret, totpCode, pending.username)) {
      res.status(401).json({ success: false, error: 'Authenticator kodu hatalı' });
      return;
    }
    try {
      const user = confirmPendingRegistration(pendingId);
      const token = signRelayToken(user.username, user.agentId);
      log('info', `Registered agent=${user.agentId} user=${user.username}`);
      res.status(201).json({
        success: true,
        agentId: user.agentId,
        username: user.username,
        agentToken: user.agentToken,
        token,
        message:
          'Kayıt tamam. PC bridge → relay.agentId / relay.agentToken yazın.',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ success: false, error: msg });
    }
  });

  // Re-show agentId + agentToken after username/password/TOTP (if setup dialog was closed)
  app.post('/api/relay/reveal-agent', async (req, res) => {
    const body = parseJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const totpCode = String(body.totpCode || body.code || '').trim();
    const user = findUserByUsername(username);
    if (!user) {
      res.status(401).json({ success: false, error: 'Kullanıcı adı veya şifre hatalı' });
      return;
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      res.status(401).json({ success: false, error: 'Kullanıcı adı veya şifre hatalı' });
      return;
    }
    if (!user.totpSecret || !verifyTotpCode(user.totpSecret, totpCode, user.username)) {
      res.status(401).json({ success: false, error: 'Authenticator kodu hatalı', totpRequired: true });
      return;
    }
    res.json({
      success: true,
      agentId: user.agentId,
      agentToken: user.agentToken,
      username: user.username,
      message: 'PC Bridge Setup’a agentId ve agentToken yapıştır.',
    });
  });

  // Password reset via authenticator (no email)
  app.post('/api/relay/reset-password', async (req, res) => {
    const body = parseJsonBody(req);
    const username = String(body.username || '').trim();
    const totpCode = String(body.totpCode || body.code || '').trim();
    const newPassword = String(body.newPassword || body.password || '');
    const user = findUserByUsername(username);
    if (!user || !user.totpSecret) {
      res.status(401).json({ success: false, error: 'Kullanıcı bulunamadı veya authenticator yok' });
      return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ success: false, error: 'Yeni şifre en az 6 karakter' });
      return;
    }
    if (!verifyTotpCode(user.totpSecret, totpCode, user.username)) {
      res.status(401).json({ success: false, error: 'Authenticator kodu hatalı' });
      return;
    }
    const passwordHash = await hashPassword(newPassword);
    updateUserPassword(user.username, passwordHash);
    log('info', `Password reset user=${user.username}`);
    res.json({ success: true, message: 'Şifre güncellendi; yeni şifre ile giriş yapın.' });
  });

  // VDS login — password + TOTP required for registered users
  app.post('/api/auth/login', async (req, res) => {
    const body = parseJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const totpCode = String(body.totpCode || body.code || '').trim();
    const user = findUserByUsername(username);
    if (user) {
      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) {
        res.status(401).json({ success: false, error: 'Kullanıcı adı veya şifre hatalı' });
        return;
      }
      if (!user.totpSecret) {
        res.status(403).json({
          success: false,
          error: 'Bu hesapta authenticator yok; yeniden kayıt olun',
          totpRequired: true,
        });
        return;
      }
      if (!totpCode) {
        res.status(401).json({
          success: false,
          error: 'Authenticator kodu gerekli',
          totpRequired: true,
        });
        return;
      }
      if (!verifyTotpCode(user.totpSecret, totpCode, user.username)) {
        res.status(401).json({ success: false, error: 'Authenticator kodu hatalı', totpRequired: true });
        return;
      }
      const token = signRelayToken(user.username, user.agentId);
      res.json({
        success: true,
        token,
        username: user.username,
        agentId: user.agentId,
      });
      return;
    }
    // Legacy / single-PC: proxy login to default (or header) agent
    await proxyToAgent(agents, config, pickAgentId(req, config), req, res);
  });

  app.get('/api/auth/verify', (req, res) => {
    const token = bearerToken(req.headers.authorization);
    if (token) {
      const payload = verifyRelayToken(token);
      if (payload) {
        res.json({
          valid: true,
          username: payload.username,
          agentId: payload.agentId,
        });
        return;
      }
    }
    void proxyToAgent(agents, config, pickAgentId(req, config), req, res);
  });

  // Transparent API proxy → user's agent (from JWT) or default
  app.all('/api/*', async (req, res) => {
    const agentId = pickAgentId(req, config);
    await proxyToAgent(agents, config, agentId, req, res);
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
          agentToken: cfg.token,
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
    const agentId = pickAgentId(req, config, req.headers.authorization);
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
          message: 'PC bağlı değil — bridge çalışıyor mu?',
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
    });
  });

  server.listen(config.port, () => {
    log('info', `Relay listening on :${config.port}`);
    log('info', `  Phone HTTP/WS: http://0.0.0.0:${config.port}/  and /ws`);
    log('info', `  Agent WS:      ws://0.0.0.0:${config.port}/agent`);
    log('info', `  Registration:  POST /api/relay/register (+ /confirm, TOTP)`);
    log('info', `  Reset password: POST /api/relay/reset-password`);
    log('info', `  Default agent: ${config.defaultAgentId}`);
  });

  return server;
}
