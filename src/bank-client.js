'use strict';
const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');
const baseline = process.env.MODE === 'baseline';
const url = new URL('/charges', process.env.BANK_URL || 'http://localhost:4002');
if (!['http:', 'https:'].includes(url.protocol)) throw Error('BANK_URL must use http(s)');
const transport = url.protocol === 'https:' ? https : http;
const agent = new transport.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 10, scheduling: 'lifo' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function attempt(payment, budget) {
  return new Promise((resolve, reject) => {
    let connected = false;
    let settled = false;
    const body = JSON.stringify({ reference: payment.reference, amount: payment.amount });
    const req = transport.request(url, {
      method: 'POST', agent: baseline ? false : agent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Idempotency-Key': payment.reference }
    });
    // Timer bao gồm cả thời gian xếp hàng lấy socket; setTimeout của socket không đủ.
    const timer = setTimeout(() => req.destroy(Object.assign(Error('Bank deadline exceeded'), { code: 'DEADLINE' })), budget);
    function finish(err, value) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (err) {
        err.certain = !connected && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(err.code);
        reject(err);
      } else resolve(value);
    }
    req.on('socket', socket => {
      if (!socket.connecting) connected = true;
      else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => { connected = true; });
    });
    req.on('error', err => finish(err));
    req.on('response', res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('error', err => finish(err));
      res.on('aborted', () => finish(Error('Bank response aborted')));
      res.on('end', () => {
        try { finish(null, { code: res.statusCode, body: JSON.parse(raw) }); }
        catch { finish(Error('Invalid bank response')); }
      });
    });
    req.end(body);
  });
}
async function charge(payment) {
  const end = performance.now() + (baseline ? 6500 : 4000);
  let uncertain = false;
  // 6 lần tổng cộng, retry cùng reference + key, không tạo lệnh mới.
  for (let n = 0; n < (baseline ? 1 : 6); n++) {
    const remaining = end - performance.now();
    if (remaining <= 0) break;
    try {
      const result = await attempt(payment, remaining);
      if (result.code === 201 && typeof result.body.chargeId === 'string' && result.body.reference === payment.reference && result.body.amount === payment.amount) return { code: 201, status: 'PAID', chargeId: result.body.chargeId };
      if (result.code >= 400 && result.code < 500) {
        // Nếu lần trước mơ hồ thì một từ chối sau đó không chứng minh chưa trừ tiền.
        if (uncertain) break;
        return { code: result.code, status: 'FAILED', error: result.body.error || 'Bank rejected payment' };
      }
      // Theo hợp đồng ngân hàng lab: 500 xảy ra trước khi trừ tiền.
      if (result.code !== 500) uncertain = true;
    } catch (err) {
      if (err.certain && !uncertain) return { code: 503, status: 'FAILED', error: 'Cannot connect to bank' };
      uncertain = true;
    }
    const pause = Math.min(50 * 2 ** n, 400);
    if (performance.now() + pause >= end) break;
    await sleep(pause);
  }
  return uncertain
    ? { code: 504, status: 'PENDING', error: 'Bank outcome unknown; do not create a replacement payment' }
    : { code: 503, status: 'FAILED', error: 'Bank unavailable; retries exhausted before charge' };
}
module.exports = { charge };
