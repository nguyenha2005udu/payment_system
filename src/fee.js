'use strict';
const express = require('express');
const { randomUUID } = require('node:crypto');
const { charge } = require('./bank-client');
const app = express();
app.use(express.json());
const students = new Map([[1, { debt: 50_000_000, reserved: 0 }], [2, { debt: 0, reserved: 0 }], [3, { debt: 3_200_000, reserved: 0 }]]);
const payments = new Map();
const instance = randomUUID(); // P1 có thể lặp sau restart, khóa ngân hàng thì không.
let sequence = 0;
app.get('/students/:id/fees', (req, res) => {
  const student = students.get(Number(req.params.id));
  if (!student) return res.status(404).json({ error: 'Student not found' });
  res.json({ studentId: Number(req.params.id), debt: student.debt, reserved: student.reserved, available: student.debt - student.reserved });
});
app.post('/students/:id/payments', async (req, res, next) => {
  const paymentId = `P${++sequence}`;
  const student = students.get(Number(req.params.id));
  const { amount } = req.body || {};
  const fail = (code, error) => res.status(code).json({ error, paymentId, status: 'FAILED' });
  if (!student) return fail(404, 'Student not found');
  if (!Number.isSafeInteger(amount) || amount <= 0) return fail(400, 'Amount must be a positive integer in VND');
  if (amount > student.debt - student.reserved) return fail(400, 'Amount exceeds available debt');
  // Giữ chỗ đồng bộ trước await: chống vượt công nợ khi có nhiều lệnh đồng thời.
  student.reserved += amount;
  const payment = { paymentId, reference: `${instance}:${paymentId}`, amount, status: 'PENDING' };
  payments.set(paymentId, payment);
  try {
    const result = await charge(payment);
    payment.status = result.status;
    if (result.status === 'PAID') {
      student.debt -= amount;
      student.reserved -= amount;
    } else if (result.status === 'FAILED') student.reserved -= amount;
    // PENDING giữ reservation vì ngân hàng có thể đã trừ tiền.
    const { code, ...body } = result;
    res.status(code).json({ ...body, paymentId, amount });
  } catch (err) {
    payment.status = 'PENDING';
    res.status(504).json({ error: 'Unexpected bank outcome', paymentId, status: 'PENDING' });
  }
});
app.use((err, req, res, next) => res.status(400).json({ error: 'Invalid JSON', paymentId: `P${++sequence}`, status: 'FAILED' }));
app.listen(Number(process.env.PORT || 4001), () => console.log('FEE_READY'));
