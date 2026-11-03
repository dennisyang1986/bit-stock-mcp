'use strict';
/**
 * Minimal client for the bit.com / Matrixport Stock REST API.
 * Docs: https://www.bit.com/docs/en-us/stock.html
 *
 * Auth V2 (default, current Matrixport scheme):
 *   headers: X-MatrixPort-Access-Key, X-Signature, X-Timestamp, X-Auth-Version: v2
 *   prehash = timestamp + METHOD + api_path + '&' + (query string for GET | raw JSON body for POST)
 *   signature = hex(hmac_sha256(prehash, secret_key))
 *
 * Auth V1 (legacy fallback, BIT_AUTH_MODE=v1):
 *   timestamp(int ms) + signature are added to the params;
 *   str_to_sign = api_path + '&' + sorted 'k=v' joined by '&'
 */
const crypto = require('crypto');

class BitApiError extends Error {
  constructor(message, { httpStatus, code, raw } = {}) {
    super(message);
    this.name = 'BitApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.raw = raw;
  }
}

class BitStockClient {
  constructor({ baseUrl, accessKey, secretKey, authMode = 'v2', timeoutMs = 10000 }) {
    if (!accessKey || !secretKey) throw new Error('BIT_ACCESS_KEY / BIT_SECRET_KEY are required');
    this.baseUrl = (baseUrl || 'https://mapi.matrixport.com').replace(/\/+$/, '');
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.authMode = String(authMode).toLowerCase();
    this.timeoutMs = timeoutMs;
  }

  _hmac(msg) {
    return crypto.createHmac('sha256', this.secretKey).update(msg, 'utf8').digest('hex');
  }

  static _clean(params) {
    const out = {};
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      out[k] = String(v);
    }
    return out;
  }

  static _v1Encode(obj) {
    return Object.keys(obj).sort().map((k) => `${k}=${obj[k]}`).join('&');
  }

  async request(method, path, params = {}) {
    method = method.toUpperCase();
    const clean = BitStockClient._clean(params);
    const ts = Date.now();
    const headers = {
      Accept: 'application/json',
      'X-MatrixPort-Access-Key': this.accessKey,
      'x-request-id': crypto.randomUUID(),
    };
    let url = this.baseUrl + path;
    let body;

    if (this.authMode === 'v1') {
      const p = { ...clean, timestamp: ts };
      p.signature = this._hmac(path + '&' + BitStockClient._v1Encode(p));
      if (method === 'GET') {
        url += '?' + new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])).toString();
      } else {
        body = JSON.stringify(p);
        headers['Content-Type'] = 'application/json';
      }
    } else {
      let payload;
      if (method === 'GET') {
        payload = new URLSearchParams(clean).toString();
        if (payload) url += '?' + payload;
      } else {
        payload = JSON.stringify(clean);
        body = payload;
        headers['Content-Type'] = 'application/json';
      }
      headers['X-Timestamp'] = String(ts);
      headers['X-Auth-Version'] = 'v2';
      headers['X-Signature'] = this._hmac(`${ts}${method}${path}&${payload}`);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res;
    let text;
    try {
      res = await fetch(url, { method, headers, body, signal: ac.signal });
      text = await res.text();
    } catch (e) {
      throw new BitApiError(`Network error calling ${method} ${path}: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BitApiError(`Non-JSON response (HTTP ${res.status}) from ${path}: ${text.slice(0, 300)}`, {
        httpStatus: res.status,
        raw: text,
      });
    }
    if (!res.ok || (json && json.code !== undefined && Number(json.code) !== 0)) {
      throw new BitApiError(`bit API error HTTP ${res.status} code=${json.code} message=${json.message}`, {
        httpStatus: res.status,
        code: json.code,
        raw: json,
      });
    }
    return json.data;
  }

  // ---- Stock endpoints ----
  placeOrder(p) { return this.request('POST', '/stock/v1/place_order', p); }
  editOrder(p) { return this.request('POST', '/stock/v1/edit_order', p); }
  cancelOrder(p) { return this.request('POST', '/stock/v1/cancel_order', p); }
  getOrders(p) { return this.request('GET', '/stock/v1/orders', p); }
  openOrders() { return this.request('GET', '/stock/v1/open_orders'); }
  balance() { return this.request('GET', '/stock/v1/balance'); }
  positions() { return this.request('GET', '/stock/v1/positions'); }
  orderDetail(p) { return this.request('GET', '/stock/v1/order_detail', p); }
}

module.exports = { BitStockClient, BitApiError };
