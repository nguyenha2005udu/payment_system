'use strict';
// Chạy khi hai service đang hoạt động: npm run bench -- 200 10 1000
const { performance } = require('node:perf_hooks');
const [n = 200, concurrency = 10, amount = 1000] = process.argv.slice(2).map(Number);
if (![n, concurrency, amount].every(x => Number.isSafeInteger(x) && x > 0)) throw Error('Arguments must be positive integers');
(async () => {
  const stats = () => fetch('http://localhost:4002/stats').then(r => r.json());
  const before = await stats(); let next = 0; const results = []; const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next++ < n) {
      const t = performance.now();
      const response = await fetch('http://localhost:4001/students/1/payments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) });
      results.push({ http: response.status, ...await response.json(), ms: +(performance.now() - t).toFixed(2) });
    }
  }));
  const after = await stats();
  console.log(JSON.stringify({ n, concurrency, amount, totalMs: +(performance.now() - started).toFixed(2), paid: results.filter(r => r.status === 'PAID').length, pending: results.filter(r => r.status === 'PENDING').length, connectionsDelta: after.connections - before.connections, before, after, results }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
