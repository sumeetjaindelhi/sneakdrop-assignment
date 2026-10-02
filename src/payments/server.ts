import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import mongoose, { Schema, model } from 'mongoose';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function nonNegative(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number of 0 or more`);
  return value;
}

const PORT = nonNegative('PAYMENTS_PORT', 4000);
const MONGO_URL = process.env.PAYMENTS_MONGO_URL ?? 'mongodb://127.0.0.1:27017/payments';
const PUBLIC_URL = process.env.PAYMENTS_PUBLIC_URL ?? 'http://localhost:4000';
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? `${process.env.APP_PUBLIC_URL ?? 'http://localhost:3000'}/webhooks/payments`;
const WEBHOOK_SECRET = required('WEBHOOK_SECRET');
const AUTHORIZATION = Buffer.from(`Bearer ${required('PAYMENTS_API_KEY')}`);
const WEBHOOK_MAX_DELAY_MS = nonNegative('WEBHOOK_MAX_DELAY_MS', 3000);
const WEBHOOK_DUPLICATE_RATE = nonNegative('WEBHOOK_DUPLICATE_RATE', 0.3);

const Checkout = model('Checkout', new Schema({
  _id: String,
  reference: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  expiresAt: { type: Date, required: true },
  returnUrl: { type: String, required: true },
  status: { type: String, enum: ['open', 'paid', 'refunded'], required: true },
  paidAt: Date,
}, { versionKey: false }));

function statusOf(checkout: { status: string; expiresAt: Date }) {
  return checkout.status === 'open' && Date.now() >= checkout.expiresAt.getTime() ? 'expired' : checkout.status;
}

const notPayable: Record<string, string> = {
  expired: 'This checkout has expired.',
  paid: 'This checkout is already paid.',
  refunded: 'This checkout was paid and then refunded.',
};

async function deliver(id: string, body: string, signature: string) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const delay = attempt === 1 ? Math.round(Math.random() * WEBHOOK_MAX_DELAY_MS) : 1000 * 2 ** (attempt - 2);
    await sleep(delay);
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': signature },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch((err) => ({ ok: false, status: err.cause?.code ?? err.name }));
    console.log(`webhook event=${id} attempt=${attempt} delay=${delay}ms status=${res.status}`);
    if (res.ok) return;
  }
  console.log(`webhook event=${id} gave up`);
}

const app = express();

app.use('/checkouts', (req, res, next) => {
  const given = Buffer.from(req.get('authorization') ?? '');
  if (given.length !== AUTHORIZATION.length || !timingSafeEqual(given, AUTHORIZATION)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}, express.json());

app.post('/checkouts', async (req, res) => {
  const { reference, amount, expiresAt, returnUrl } = req.body ?? {};
  const expires = new Date(expiresAt);
  // The reference is printed on the checkout page, so it is limited to characters that are safe in HTML.
  if (typeof reference !== 'string' || !/^[\w-]{1,64}$/.test(reference) || !Number.isSafeInteger(amount)
    || amount < 1 || Number.isNaN(expires.getTime()) || typeof returnUrl !== 'string') {
    res.status(400).json({ error: 'invalid_checkout' });
    return;
  }
  // A repeated or retried create gets the same checkout back, never a second one that could also be paid.
  const checkout = await Checkout.findOneAndUpdate(
    { reference },
    { $setOnInsert: { _id: randomUUID(), amount, expiresAt: expires, returnUrl, status: 'open' } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  res.json({ id: checkout._id, url: `${PUBLIC_URL}/checkout/${checkout._id}` });
});

app.get('/checkouts/:id', async (req, res) => {
  const checkout = await Checkout.findById(req.params.id).lean();
  if (!checkout) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ id: checkout._id, reference: checkout.reference, status: statusOf(checkout) });
});

app.post('/checkouts/:id/refund', async (req, res) => {
  const { id } = req.params;
  const { matchedCount } = await Checkout.updateOne({ _id: id, status: 'paid' }, { $set: { status: 'refunded' } });
  if (matchedCount === 0 && !(await Checkout.exists({ _id: id, status: 'refunded' }))) {
    res.status(409).json({ error: 'not_paid' });
    return;
  }
  if (matchedCount === 1) console.log(`refunded checkout=${id}`);
  res.json({ id, status: 'refunded' });
});

app.get('/checkout/:id', async (req, res) => {
  const checkout = await Checkout.findById(req.params.id).lean();
  if (!checkout) {
    res.status(404).send('Checkout not found.');
    return;
  }
  const status = statusOf(checkout);
  const open = status === 'open';
  res.send(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Checkout</title>
<style>
  body { margin: 0; background: #e9eae6; color: #000; font: 16px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif; }
  main { max-width: 34rem; margin: 0 auto; padding: 2.5rem 1.25rem; }
  h1 { margin: 0 0 1.5rem; font-size: 1.125rem; font-weight: 600; color: #5f615c; }
  .amount { margin: 0; font-size: clamp(3rem, 14vw, 5rem); font-weight: 800; letter-spacing: -.04em; line-height: 1; font-variant-numeric: tabular-nums; }
  p { margin: .75rem 0; }
  small { color: #5f615c; }
  button { font: inherit; font-weight: 600; background: #000; color: #fff; border: 2px solid #000; padding: .8rem 1.25rem; cursor: pointer; margin-top: 1rem; }
  button:hover { background: #1d35e8; border-color: #1d35e8; }
  button:focus-visible { outline: 3px solid #1d35e8; outline-offset: 2px; }
</style>
<main>
  <h1>Fake payment provider</h1>
  <p class="amount">$${(checkout.amount / 100).toFixed(2)}</p>
  <p>One pair of sneakers<br><small>Reference ${checkout.reference}</small></p>
  ${open
    ? `<p>This checkout closes in <span id="left"></span> seconds.</p>
  <form method="post" action="/checkout/${checkout._id}/pay"><button>Pay $${(checkout.amount / 100).toFixed(2)}</button></form>
  <script>
    const ends = ${checkout.expiresAt.getTime()} - Date.now() + performance.now();
    const left = document.getElementById('left');
    setInterval(() => { left.textContent = Math.max(0, Math.ceil((ends - performance.now()) / 1000)); }, 200);
  </script>`
    : `<p>${notPayable[status]}</p>`}
</main>
`);
});

app.post('/checkout/:id/pay', async (req, res) => {
  const now = new Date();
  // The shop gives an expired hold to someone else, so from that moment on the checkout can't be paid.
  const checkout = await Checkout.findOneAndUpdate(
    { _id: req.params.id, status: 'open', expiresAt: { $gt: now } },
    { $set: { status: 'paid', paidAt: now } },
    { returnDocument: 'after' },
  ).lean();
  if (!checkout) {
    res.status(409).send('This checkout can no longer be paid.');
    return;
  }
  const id = `evt_${randomUUID()}`;
  const body = JSON.stringify({
    id,
    type: 'payment.succeeded',
    data: { checkoutId: checkout._id, reference: checkout.reference, amount: checkout.amount, paidAt: now },
  });
  const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
  // Unreliable on purpose, like a real provider: each delivery is late by a random amount, which also
  // reorders them, and some events go out twice.
  const duplicate = Math.random() < WEBHOOK_DUPLICATE_RATE;
  deliver(id, body, signature);
  if (duplicate) deliver(id, body, signature);
  console.log(`paid checkout=${checkout._id} event=${id} duplicate=${duplicate}`);
  res.redirect(303, checkout.returnUrl);
});

await mongoose.connect(MONGO_URL);
// Mongoose's automatic index build is not awaited, and one checkout per reference relies on the unique index.
await Checkout.createIndexes();
app.listen(PORT, (err) => {
  if (err) throw err;
  console.log(`payments listening port=${PORT}`);
});
