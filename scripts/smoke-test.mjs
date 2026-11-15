/**
 * Local smoke test: relay + ephemeral agent → local bridge :3500
 * Usage: node scripts/smoke-test.mjs  (relay must already listen on :8080)
 */
import http from 'node:http';
import { WebSocket } from 'ws';

const RELAY = 'http://127.0.0.1:8080';
const AGENT_WS = 'ws://127.0.0.1:8080/agent';
const LOCAL = 'http://127.0.0.1:3500';
const TOKEN = 'local-smoke-token-12345678';
const AGENT_ID = 'default';

function httpReq(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function localProxy(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, LOCAL);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { ...headers, host: u.host },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const out = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v == null) continue;
            out[k] = Array.isArray(v) ? v.join(', ') : String(v);
          }
          resolve({
            status: res.statusCode || 502,
            headers: out,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('error', reject);
    if (body?.length) req.write(body);
    req.end();
  });
}

const ws = new WebSocket(AGENT_WS);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'agent_hello', agentId: AGENT_ID, token: TOKEN }));
});

ws.on('message', async (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'agent_hello_ok') {
    console.log('OK agent_hello');
    const status = await httpReq(`${RELAY}/api/relay/status`);
    console.log('relay status', status.status, status.body);
    const proxied = await httpReq(`${RELAY}/api/status`);
    console.log('proxied /api/status', proxied.status, proxied.body.slice(0, 200));
    if (proxied.status === 401 || proxied.status === 200) {
      console.log('SMOKE PASS');
      ws.close();
      process.exit(0);
    }
    console.error('SMOKE FAIL unexpected status');
    process.exit(1);
  }
  if (msg.type === 'agent_hello_fail') {
    console.error('auth fail', msg);
    process.exit(1);
  }
  if (msg.type === 'http_proxy') {
    try {
      const body = msg.bodyBase64 ? Buffer.from(msg.bodyBase64, 'base64') : undefined;
      const result = await localProxy(msg.method, msg.path, msg.headers || {}, body);
      ws.send(
        JSON.stringify({
          type: 'http_proxy_result',
          id: msg.id,
          status: result.status,
          headers: result.headers,
          bodyBase64: result.body.toString('base64'),
        })
      );
    } catch (e) {
      ws.send(
        JSON.stringify({
          type: 'http_proxy_result',
          id: msg.id,
          status: 502,
          headers: { 'content-type': 'application/json' },
          bodyBase64: Buffer.from(JSON.stringify({ error: String(e) })).toString('base64'),
        })
      );
    }
  }
});

ws.on('error', (e) => {
  console.error('ws error', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('SMOKE TIMEOUT');
  process.exit(1);
}, 15000);
