'use strict';
const express = require('express');
const app = express();
app.use(express.json());
const delay = Number(process.env.DELAY_MS || 0);
const failRate = Number(process.env.FAIL_RATE || 0);
const dropRate = Number(process.env.DROP_RATE || 0);
if (!Number.isFinite(delay) || delay < 0 || ![failRate, dropRate].every(x => x >= 0 && x <= 1)) throw Error('Invalid fault configuration');
const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const keys = new Map();
const references = new Map();
const debitCounts = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.get('/stats', (req, res) => res.json(stats));
app.post('/charges', async (req, res) => {
  stats.requests++;
  const { reference, amount } = req.body || {};
  const key = req.get('Idempotency-Key');
  if (!key || typeof reference !== 'string' || !reference || !Number.isSafeInteger(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid reference, amount or Idempotency-Key' });
  // Tra cứu trước lỗi giả lập: một giao dịch đã commit phải có thể trả lại kết quả.
  const old = keys.get(key);
  if (old) {
    if (old.reference !== reference || old.amount !== amount) return res.status(409).json({ error: 'Idempotency-Key reused with different payload' });
    return res.status(201).json(old);
  }
  if (amount > 20_000_000) return res.status(402).json({ error: 'Bank limit is 20000000 VND' });
  if (delay) await sleep(delay);
  // Kiểm tra lại sau await để hai yêu cầu đồng thời không cùng commit.
  const committed = keys.get(key);
  if (committed) {
    if (committed.reference !== reference || committed.amount !== amount) return res.status(409).json({ error: 'Idempotency-Key reused with different payload' });
    return res.status(201).json(committed);
  }
  if (Math.random() < failRate) return res.status(500).json({ error: 'Temporary bank failure before charge' });
  if (references.has(reference)) return res.status(409).json({ error: 'Reference already charged with another key' });
  // Đoạn kiểm tra + ghi Map đồng bộ, không có await ở giữa.
  const previousDebits = debitCounts.get(reference) || 0;
  if (previousDebits > 0) stats.duplicates++;
  debitCounts.set(reference, previousDebits + 1);
  const charge = { chargeId: `C${++stats.charges}`, reference, amount };
  references.set(reference, charge);
  keys.set(key, charge);
  if (Math.random() < dropRate) return req.socket.destroy();
  res.status(201).json(charge);
});
app.use((err, req, res, next) => res.status(400).json({ error: 'Invalid JSON' }));
const server = app.listen(Number(process.env.PORT || 4002), () => console.log('BANK_READY'));
server.keepAliveTimeout = 5000;
// Node mới có thêm buffer; đặt 0 để bài lab thực sự đóng sau 5 giây.
if ('keepAliveTimeoutBuffer' in server) server.keepAliveTimeoutBuffer = 0;
server.on('connection', socket => {
  stats.connections++;
  console.log(`[bank] TCP new #${stats.connections} from ${socket.remoteAddress}:${socket.remotePort}`);
});
