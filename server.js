#!/usr/bin/env node
'use strict';
/**
 * bit-stock-mcp — MCP server (Streamable HTTP, stateless, JSON responses) for the
 * bit.com / Matrixport Stock API. Zero npm dependencies; requires Node.js >= 18.
 *
 *   node server.js              start server
 *   node server.js --selftest   call balance/positions once to verify API keys & signature
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BitStockClient, BitApiError } = require('./bitclient');

// ---------------- config ----------------
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

const CFG = {
  host: env.HOST || '127.0.0.1',
  port: num(env.PORT, 8790),
  mcpPath: env.MCP_PATH || '/mcp',
  authToken: env.MCP_AUTH_TOKEN || '',
  tradingEnabled: bool(env.TRADING_ENABLED, false),
  allowMarketOrders: bool(env.ALLOW_MARKET_ORDERS, false),
  allowOutsideRth: bool(env.ALLOW_OUTSIDE_RTH, true),
  maxOrderQty: num(env.MAX_ORDER_QTY, 1000),
  maxOrderNotional: num(env.MAX_ORDER_NOTIONAL_USD, 10000),
  symbolAllowlist: (env.SYMBOL_ALLOWLIST || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  defaultRegion: (env.DEFAULT_REGION || 'US').toUpperCase(),
  logDir: env.LOG_DIR || path.join(__dirname, 'logs'),
};

if (!CFG.authToken || CFG.authToken.length < 24) {
  console.error('FATAL: MCP_AUTH_TOKEN must be set (>= 24 chars). Generate one: openssl rand -hex 32');
  process.exit(1);
}

const client = new BitStockClient({
  baseUrl: env.BIT_BASE_URL,
  accessKey: env.BIT_ACCESS_KEY,
  secretKey: env.BIT_SECRET_KEY,
  authMode: env.BIT_AUTH_MODE || 'v2',
  timeoutMs: num(env.BIT_TIMEOUT_MS, 10000),
});

fs.mkdirSync(CFG.logDir, { recursive: true });
function audit(event) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  fs.appendFile(path.join(CFG.logDir, 'audit.log'), line, () => {});
}

// ---------------- helpers ----------------
const QTY_RE = /^[1-9]\d*$/;
const PRICE_RE = /^\d+(\.\d+)?$/;

function normSymbol(s) {
  if (!s || typeof s !== 'string') throw new Error('symbol is required, e.g. AAPL.US');
  let sym = s.trim().toUpperCase();
  if (!/\.(US|HK|SG|SH|SZ)$/.test(sym)) sym = `${sym}.${CFG.defaultRegion}`;
  if (!/^[A-Z0-9.\-]+$/.test(sym)) throw new Error(`invalid symbol: ${s}`);
  return sym;
}

function assertTrading() {
  if (!CFG.tradingEnabled) {
    throw new Error('Trading is disabled on this MCP server (read-only mode). Set TRADING_ENABLED=true in .env to allow orders.');
  }
}

function assertQtyPrice({ qty, price, orderType }) {
  qty = String(qty ?? '').trim();
  if (!QTY_RE.test(qty)) throw new Error('qty must be a positive integer string, e.g. "100"');
  if (Number(qty) > CFG.maxOrderQty) throw new Error(`qty ${qty} exceeds MAX_ORDER_QTY=${CFG.maxOrderQty}`);
  if (orderType === 'LO') {
    price = String(price ?? '').trim();
    if (!PRICE_RE.test(price) || Number(price) <= 0) throw new Error('price is required for limit orders and must be a positive decimal string, e.g. "150.50"');
    const notional = Number(qty) * Number(price);
    if (notional > CFG.maxOrderNotional) {
      throw new Error(`order notional ${notional.toFixed(2)} exceeds MAX_ORDER_NOTIONAL_USD=${CFG.maxOrderNotional}`);
    }
  }
  return { qty, price };
}

function tsToIso(v) {
  const n = Number(v);
  return v && !isNaN(n) && n > 0 ? new Date(n * 1000).toISOString() : undefined;
}
function decorateOrder(o) {
  if (!o || typeof o !== 'object') return o;
  return { ...o, submitted_at_iso: tsToIso(o.submitted_at), updated_at_iso: tsToIso(o.updated_at) };
}
function toUnix(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (/^\d+$/.test(String(v))) {
    const n = Number(v);
    return String(n > 1e12 ? Math.floor(n / 1000) : n);
  }
  const t = Date.parse(v);
  if (isNaN(t)) throw new Error(`invalid time: ${v} (use unix seconds or ISO date)`);
  return String(Math.floor(t / 1000));
}

// ---------------- tools ----------------
const ORDER_TYPES = ['LO', 'MO'];
const TIF = ['Day', 'GTC', 'GTD'];
const RTH = ['RTH_ONLY', 'ANY_TIME', 'OVERNIGHT'];

const TOOLS = [
  {
    name: 'get_balance',
    description: 'Get stock account cash balance (USD): total_cash, total_available_cash, total_withdraw_cash.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Get balance', readOnlyHint: true },
    handler: async () => client.balance(),
  },
  {
    name: 'get_positions',
    description: 'Get current stock positions: symbol, market, total_qty, available_qty (sellable), average_cost_price, last_done, pre_close. Unrealized P&L is computed for convenience.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Get positions', readOnlyHint: true },
    handler: async () => {
      const d = await client.positions();
      const positions = (d && d.positions ? d.positions : []).map((p) => {
        const q = Number(p.total_qty), last = Number(p.last_done), cost = Number(p.average_cost_price);
        const ok = [q, last, cost].every((x) => !isNaN(x));
        return {
          ...p,
          market_value: ok ? (q * last).toFixed(2) : undefined,
          unrealized_pnl: ok ? ((last - cost) * q).toFixed(2) : undefined,
          unrealized_pnl_pct: ok && cost > 0 ? (((last - cost) / cost) * 100).toFixed(2) + '%' : undefined,
        };
      });
      return { positions };
    },
  },
  {
    name: 'list_open_orders',
    description: 'List all active (non-terminal) orders for the current trading day.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List open orders', readOnlyHint: true },
    handler: async () => {
      const d = await client.openOrders();
      return Array.isArray(d) ? d.map(decorateOrder) : d;
    },
  },
  {
    name: 'get_orders',
    description: 'Query historical orders. At least one filter is required. start_at/end_at accept unix seconds or ISO dates (e.g. 2026-11-01). If order_id is given, other filters are ignored. Returns up to 1000 records.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'e.g. AAPL.US (".US" appended if region omitted)' },
        side: { type: 'string', enum: ['Buy', 'Sell'] },
        start_at: { type: 'string', description: 'unix seconds or ISO date' },
        end_at: { type: 'string', description: 'unix seconds or ISO date' },
        order_id: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Get orders', readOnlyHint: true },
    handler: async (a) => {
      const p = {
        symbol: a.symbol ? normSymbol(a.symbol) : undefined,
        side: a.side,
        start_at: toUnix(a.start_at),
        end_at: toUnix(a.end_at),
        order_id: a.order_id,
      };
      if (!Object.values(p).some((v) => v !== undefined && v !== '')) {
        throw new Error('provide at least one of symbol, side, start_at, end_at, order_id');
      }
      const d = await client.getOrders(p);
      return Array.isArray(d) ? d.map(decorateOrder) : d;
    },
  },
  {
    name: 'get_order_detail',
    description: 'Get a single order by order_id, including fee breakdown (charge_detail).',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' } },
      required: ['order_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Get order detail', readOnlyHint: true },
    handler: async (a) => decorateOrder(await client.orderDetail({ order_id: String(a.order_id) })),
  },
  {
    name: 'place_order',
    description:
      'Place a REAL stock order on the bit.com stock account. Always confirm symbol, side, qty, type and price with the user before calling. ' +
      'Defaults: order_type=LO (limit, price required), time_in_force=Day, outside_rth=RTH_ONLY. ' +
      'Set dry_run=true to validate without sending. Server-side risk limits (max qty / max notional / market-order switch / symbol allowlist) apply.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'ticker.region, e.g. AAPL.US' },
        side: { type: 'string', enum: ['Buy', 'Sell'] },
        qty: { type: 'string', description: 'positive integer, e.g. "10"' },
        order_type: { type: 'string', enum: ORDER_TYPES, default: 'LO', description: 'LO=limit, MO=market' },
        price: { type: 'string', description: 'required for LO, e.g. "150.50"' },
        time_in_force: { type: 'string', enum: TIF, default: 'Day' },
        expire_date: { type: 'string', description: 'YYYY-MM-DD, required when time_in_force=GTD' },
        outside_rth: { type: 'string', enum: RTH, default: 'RTH_ONLY' },
        remark: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
      required: ['symbol', 'side', 'qty'],
      additionalProperties: false,
    },
    annotations: { title: 'Place order', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (a) => {
      const symbol = normSymbol(a.symbol);
      const side = /^buy$/i.test(a.side) ? 'Buy' : /^sell$/i.test(a.side) ? 'Sell' : null;
      if (!side) throw new Error('side must be Buy or Sell');
      const order_type = (a.order_type || 'LO').toUpperCase();
      if (!ORDER_TYPES.includes(order_type)) throw new Error('order_type must be LO or MO');
      if (order_type === 'MO' && !CFG.allowMarketOrders) throw new Error('Market orders are disabled (ALLOW_MARKET_ORDERS=false). Use a limit order.');
      const tifIn = a.time_in_force || 'Day';
      const time_in_force = TIF.find((t) => t.toLowerCase() === String(tifIn).toLowerCase());
      if (!time_in_force) throw new Error('time_in_force must be Day, GTC or GTD');
      if (time_in_force === 'GTD' && !/^\d{4}-\d{2}-\d{2}$/.test(a.expire_date || '')) throw new Error('expire_date (YYYY-MM-DD) is required for GTD');
      const outside_rth = (a.outside_rth || 'RTH_ONLY').toUpperCase();
      if (!RTH.includes(outside_rth)) throw new Error('outside_rth must be RTH_ONLY, ANY_TIME or OVERNIGHT');
      if (outside_rth !== 'RTH_ONLY' && !CFG.allowOutsideRth) throw new Error('Extended-hours orders are disabled (ALLOW_OUTSIDE_RTH=false).');
      if (CFG.symbolAllowlist.length && !CFG.symbolAllowlist.includes(symbol)) throw new Error(`${symbol} is not in SYMBOL_ALLOWLIST`);
      const { qty, price } = assertQtyPrice({ qty: a.qty, price: a.price, orderType: order_type });

      const req = {
        symbol, side, qty, order_type,
        price: order_type === 'LO' ? price : undefined,
        time_in_force,
        expire_date: time_in_force === 'GTD' ? a.expire_date : undefined,
        outside_rth,
        remark: a.remark ? String(a.remark).slice(0, 64) : 'driven-mcp',
      };
      if (a.dry_run) return { dry_run: true, would_send: req, trading_enabled: CFG.tradingEnabled };
      assertTrading();
      audit({ action: 'place_order', request: req });
      try {
        const d = await client.placeOrder(req);
        audit({ action: 'place_order.ok', request: req, response: d });
        return { submitted: true, request: req, ...d };
      } catch (e) {
        audit({ action: 'place_order.error', request: req, error: e.message });
        throw e;
      }
    },
  },
  {
    name: 'edit_order',
    description: 'Modify qty and price of an existing open order (both required). Confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        qty: { type: 'string', description: 'new total qty, positive integer' },
        price: { type: 'string', description: 'new price' },
      },
      required: ['order_id', 'qty', 'price'],
      additionalProperties: false,
    },
    annotations: { title: 'Edit order', readOnlyHint: false, destructiveHint: true },
    handler: async (a) => {
      assertTrading();
      const { qty, price } = assertQtyPrice({ qty: a.qty, price: a.price, orderType: 'LO' });
      const req = { order_id: String(a.order_id), qty, price };
      audit({ action: 'edit_order', request: req });
      const d = await client.editOrder(req);
      audit({ action: 'edit_order.ok', request: req });
      return { edited: true, request: req, response: d };
    },
  },
  {
    name: 'cancel_order',
    description: 'Cancel an existing open order by order_id.',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' } },
      required: ['order_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Cancel order', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (a) => {
      assertTrading();
      const req = { order_id: String(a.order_id) };
      audit({ action: 'cancel_order', request: req });
      const d = await client.cancelOrder(req);
      audit({ action: 'cancel_order.ok', request: req });
      return { cancelled: true, request: req, response: d };
    },
  },
];
const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ---------------- MCP JSON-RPC ----------------
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'bit-stock-mcp', title: 'bit.com Stock Trading', version: '1.0.0' };

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, data } });

  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') {
    return isNotification ? null : err(-32600, 'Invalid Request');
  }
  if (isNotification) return null; // notifications/initialized, notifications/cancelled ...

  switch (method) {
    case 'initialize': {
      const req = params && params.protocolVersion;
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(req) ? req : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Tools for a bit.com (Matrixport) US stock brokerage account. Symbols use ticker.region (AAPL.US). ' +
          'place_order/edit_order/cancel_order act on a REAL account: always restate the exact order and get explicit user confirmation first. ' +
          (CFG.tradingEnabled ? 'Trading is ENABLED.' : 'Trading is DISABLED (read-only).'),
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
      });
    case 'tools/call': {
      const name = params && params.name;
      const tool = TOOL_MAP[name];
      if (!tool) return err(-32602, `Unknown tool: ${name}`);
      try {
        const data = await tool.handler((params && params.arguments) || {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(data ?? {}, null, 2) }], isError: false });
      } catch (e) {
        const detail = e instanceof BitApiError ? { http: e.httpStatus, code: e.code, raw: e.raw } : undefined;
        return ok({
          content: [{ type: 'text', text: `Error: ${e.message}${detail ? '\n' + JSON.stringify(detail) : ''}` }],
          isError: true,
        });
      }
    }
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

// ---------------- HTTP ----------------
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authorized(req, url) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m && safeEq(m[1].trim(), CFG.authToken)) return true;
  if (req.headers['x-api-key'] && safeEq(req.headers['x-api-key'], CFG.authToken)) return true;
  // token embedded in path: /mcp/<token>  (for clients that only accept a URL)
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && safeEq(parts[parts.length - 1], CFG.authToken)) return true;
  if (url.searchParams.get('token') && safeEq(url.searchParams.get('token'), CFG.authToken)) return true;
  return false;
}

function send(res, status, obj, extraHeaders = {}) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/health') return send(res, 200, { ok: true, server: SERVER_INFO, trading_enabled: CFG.tradingEnabled });

  const base = CFG.mcpPath.replace(/\/+$/, '');
  if (!(p === base || p.startsWith(base + '/'))) return send(res, 404, { error: 'not found' });

  if (!authorized(req, url)) {
    return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="bit-stock-mcp"' });
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    // stateless server: no server-initiated SSE stream, no sessions
    return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 1e6) req.destroy();
  });
  req.on('end', async () => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    try {
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(handleRpc))).filter(Boolean);
        return out.length ? send(res, 200, out) : send(res, 202);
      }
      const out = await handleRpc(msg);
      return out ? send(res, 200, out) : send(res, 202);
    } catch (e) {
      return send(res, 500, { jsonrpc: '2.0', id: msg && msg.id, error: { code: -32603, message: e.message } });
    }
  });
});

// ---------------- entry ----------------
if (process.argv.includes('--selftest')) {
  (async () => {
    try {
      console.log('balance  =>', JSON.stringify(await client.balance()));
      console.log('positions=>', JSON.stringify(await client.positions()));
      console.log('open_orders=>', JSON.stringify(await client.openOrders()));
      console.log('SELFTEST OK');
      process.exit(0);
    } catch (e) {
      console.error('SELFTEST FAILED:', e.message, e.raw ? JSON.stringify(e.raw) : '');
      process.exit(2);
    }
  })();
} else {
  server.listen(CFG.port, CFG.host, () => {
    console.log(`bit-stock-mcp listening on http://${CFG.host}:${CFG.port}${CFG.mcpPath}  trading=${CFG.tradingEnabled}`);
  });
}
