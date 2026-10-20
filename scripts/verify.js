'use strict';
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const children = new Set();
const rows = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
async function start(name, env = {}) {
  const child = spawn(process.execPath, [`src/${name}.js`], { cwd: root, env: { ...process.env, PORT: name === 'bank' ? '4002' : '4001', BANK_URL: 'http://localhost:4002', MODE: 'fixed', DELAY_MS: '0', DROP_RATE: '0', FAIL_RATE: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`${name} startup timeout`)), 5000);
    child.stdout.on('data', b => { if (b.toString().includes('_READY')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', b => process.stderr.write(b));
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); reject(Error(`${name} exited ${code}; close existing services on ports 4001/4002`)); });
  });
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill(); await exited; children.delete(child);
}
async function request(route, body, port = 4001, headers = {}) {
  const t = performance.now();
  const response = await fetch(`http://localhost:${port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  return { code: response.status, ...data, ms: +(performance.now() - t).toFixed(2) };
}
const pay = (amount = 1000, id = 1) => request(`/students/${id}/payments`, { amount });
const stats = () => request('/stats', undefined, 4002);
async function batch(n, concurrency) {
  const result = []; let index = 0;
  const t = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (index++ < n) result.push(await pay());
  }));
  return { paid: result.filter(x => x.status === 'PAID').length, pending: result.filter(x => x.status === 'PENDING').length, failed: result.filter(x => x.status === 'FAILED').length, maxMs: Math.max(...result.map(x => x.ms)), totalMs: +(performance.now() - t).toFixed(2), result };
}
function record(scenario, mode, data) { const row = { scenario, mode, ...data }; rows.push(row); console.log(JSON.stringify(row)); }
async function run(mode) {
  let fee, bank;
  try {
    fee = await start('fee', { MODE: mode });
    const down = await pay(); const read = await request('/students/1/fees');
    assert.equal(down.code, 503); assert.ok(down.ms < 1500); assert.equal(read.code, 200);
    bank = await start('bank'); const recovered = await pay(); assert.equal(recovered.code, 201);
    record('1 bank down then recovery', mode, { downCode: down.code, downMs: down.ms, readMs: read.ms, recoveredCode: recovered.code });
    await stop(bank); await stop(fee);
    fee = await start('fee', { MODE: mode, BANK_URL: 'http://localhost:4999' });
    const wrongPort = await pay(); assert.equal(wrongPort.code, 503); assert.ok(wrongPort.ms < 1500);
    record('1 BANK_URL port 4999', mode, { code: wrongPort.code, ms: wrongPort.ms }); await stop(fee);

    bank = await start('bank', { DELAY_MS: '5000' }); fee = await start('fee', { MODE: mode });
    const slow = await pay(); const pendingBatch = batch(20, 20); await wait(100);
    const fastRead = await request('/students/1/fees'); const concurrent = await pendingBatch;
    if (mode === 'fixed') { assert.equal(slow.code, 504); assert.equal(slow.status, 'PENDING'); assert.ok(slow.ms <= 4500); assert.equal(concurrent.pending, 20); assert.ok(concurrent.maxMs <= 4500); assert.ok(fastRead.ms < 300); }
    record('2 slow bank', mode, { code: slow.code, status: slow.status, ms: slow.ms, concurrentPaid: concurrent.paid, concurrentPending: concurrent.pending, concurrentMaxMs: concurrent.maxMs, readMs: fastRead.ms });
    await stop(bank); await stop(fee);

    bank = await start('bank'); fee = await start('fee', { MODE: mode });
    const before = await stats(); const load = await batch(200, 10); const after = await stats();
    const connections = after.connections - before.connections;
    await wait(6000); const idle = await batch(5, 1);
    assert.equal(load.paid, 200); assert.equal(idle.paid, 5);
    if (mode === 'fixed') assert.ok(connections <= 20);
    record('3 keep alive', mode, { paid: load.paid, totalMs: load.totalMs, connectionsDelta: connections, afterIdlePaid: idle.paid });
    await stop(bank); await stop(fee);

    for (const kind of ['DROP_RATE', 'FAIL_RATE']) {
      bank = await start('bank', { [kind]: '0.3' }); fee = await start('fee', { MODE: mode });
      const load = await batch(60, 1); const counters = await stats(); const debt = await request('/students/1/fees');
      assert.equal(counters.duplicates, 0); assert.equal(debt.debt, 50_000_000 - load.paid * 1000);
      if (mode === 'fixed') { assert.ok(load.paid >= 54); assert.ok(load.maxMs <= 4500); assert.ok(load.result.filter(x => x.status === 'PENDING').every(x => x.code === 504)); }
      record(`4 ${kind}`, mode, { paid: load.paid, pending: load.pending, failed: load.failed, charges: counters.charges, requests: counters.requests, duplicates: counters.duplicates, debt: debt.debt, maxMs: load.maxMs });
      await stop(bank); await stop(fee);
    }
    bank = await start('bank'); fee = await start('fee', { MODE: mode });
    const rejected = await pay(25_000_000); const count = await stats();
    assert.equal(rejected.code, 402); assert.equal(count.requests, 1);
    record('4 bank rejection', mode, { code: rejected.code, status: rejected.status, bankRequests: count.requests });
    // Kiểm tra hợp đồng, idempotency và giữ chỗ khi đồng thời.
    assert.equal((await pay(1, 2)).code, 400);
    for (const amount of [0, -1, 0.1, '1000', null]) assert.equal((await pay(amount)).code, 400);
    assert.equal((await pay(1, 999)).code, 404);
    const payload = { reference: 'direct-check', amount: 1000 };
    const a = await request('/charges', payload, 4002, { 'Idempotency-Key': 'direct-key' });
    const b = await request('/charges', payload, 4002, { 'Idempotency-Key': 'direct-key' });
    assert.equal(a.chargeId, b.chargeId);
    assert.equal((await request('/charges', { ...payload, amount: 2000 }, 4002, { 'Idempotency-Key': 'direct-key' })).code, 409);
    const race = await Promise.all([pay(2_000_000, 3), pay(2_000_000, 3)]);
    assert.deepEqual(race.map(x => x.code).sort(), [201, 400]);
    record('extra validation and reservation', mode, { passed: true });
  } finally { await stop(bank); await stop(fee); }
}
(async () => {
  const started = new Date().toISOString();
  try {
    for (const mode of ['baseline', 'fixed']) await run(mode);
    fs.mkdirSync(path.join(root, 'results'), { recursive: true });
    fs.writeFileSync(path.join(root, 'results/verification.json'), JSON.stringify({ started, node: process.version, platform: process.platform, faultSampling: 'Math.random, independent per request; results vary between runs', passed: true, rows }, null, 2));
    console.log('PASS: all assertions; results/verification.json');
  } catch (err) { console.error(err); process.exitCode = 1; }
  finally { for (const child of children) child.kill(); }
})();
