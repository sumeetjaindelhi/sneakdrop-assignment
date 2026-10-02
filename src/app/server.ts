import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { APP_PORT, APP_PUBLIC_URL, HOLD_SECONDS, MONGO_URL, NAME_RE, PAYMENTS_API_KEY, PRICE_CENTS, WEBHOOK_SECRET } from './config.ts';
import { attachCheckout, buy, currentHold, getStatus, initDb, joinLine, markPaid, snapshot, statusOf, sweep } from './drop.ts';
import { checkoutStatus, createCheckout, refund, verifySignature } from './provider.ts';

if (!WEBHOOK_SECRET) throw new Error('WEBHOOK_SECRET is required');
if (!PAYMENTS_API_KEY) throw new Error('PAYMENTS_API_KEY is required');

const app = express();

app.get('/', (_req, res) => res.sendFile(join(import.meta.dirname, 'page.html')));

app.use('/api', (req, res, next) => {
  // The event stream can't send headers, so it names the user in the query string instead.
  const name = req.get('x-user') ?? req.query.user;
  // Anyone may watch the stock, but every action is taken under a name.
  if (name === undefined ? req.method === 'POST' : typeof name !== 'string' || !NAME_RE.test(name)) {
    res.status(401).json({ error: 'name_required' });
    return;
  }
  res.locals.user = name;
  next();
});

const withSettings = (status: ReturnType<typeof statusOf>) =>
  ({ ...status, holdSeconds: HOLD_SECONDS, price: PRICE_CENTS, now: Date.now() });

app.get('/api/status', async (_req, res) => {
  res.json(withSettings(await getStatus(res.locals.user)));
});

const pages = new Set<{ user?: string; last: string; res: Response }>();

app.get('/api/events', (req, res) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.flushHeaders();
  const page = { user: res.locals.user, last: '', res };
  pages.add(page);
  req.on('close', () => pages.delete(page));
});

async function broadcast() {
  const current = await snapshot();
  for (const page of pages) {
    const status = statusOf(current, page.user);
    const key = JSON.stringify(status);
    if (key === page.last) continue;
    page.last = key;
    page.res.write(`data: ${JSON.stringify(withSettings(status))}\n\n`);
  }
}

// A failed read is retried on the next tick, so the pages just wait a moment longer.
setInterval(() => { if (pages.size) broadcast().catch(() => {}); }, 250);

app.post('/api/buy', async (_req, res) => {
  const result = await buy(res.locals.user);
  if (result === 'held') res.json({ result });
  else res.status(409).json({ error: result });
});

app.post('/api/line', async (_req, res) => {
  const result = await joinLine(res.locals.user);
  if (result === 'joined') res.json({ result });
  else res.status(409).json({ error: result });
});

app.post('/api/checkout', async (_req, res) => {
  const hold = await currentHold(res.locals.user);
  if (hold && hold.expiresAt > new Date()) {
    // The hold id is the provider's reference: repeat clicks get the same checkout, and its webhook names the hold.
    const { id, url } = await createCheckout({
      reference: hold.holdId, amount: PRICE_CENTS, expiresAt: hold.expiresAt, returnUrl: APP_PUBLIC_URL,
    });
    if (await attachCheckout(hold.holdId, id)) {
      res.json({ url });
      return;
    }
  }
  res.status(409).json({ error: 'no_hold' });
});

// The signature covers the exact bytes the provider sent, so the body stays raw until it has been checked.
app.post('/webhooks/payments', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !verifySignature(req.body, req.get('x-signature'), WEBHOOK_SECRET)) {
    res.status(401).json({ error: 'bad_signature' });
    return;
  }
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    res.status(400).json({ error: 'bad_json' });
    return;
  }
  if (event?.type !== 'payment.succeeded') {
    res.json({ result: 'ignored' });
    return;
  }
  const { reference, checkoutId } = event.data ?? {};
  if (typeof reference !== 'string' || typeof checkoutId !== 'string') {
    res.status(400).json({ error: 'bad_event' });
    return;
  }
  const result = await markPaid(reference);
  // The hold was released before this payment landed, so the payer can't get that pair and is paid back.
  if (result === 'hold_gone') await refund(checkoutId);
  console.log(`webhook event=${event.id} hold=${reference} result=${result}`);
  res.json({ result });
});

app.use((err: { status?: number }, req: Request, res: Response, _next: NextFunction) => {
  if (err.status && err.status < 500) {
    res.status(err.status).json({ error: 'bad_request' });
    return;
  }
  console.error(`request failed method=${req.method} path=${req.path}`, err);
  res.status(500).json({ error: 'internal' });
});

async function sweepLoop() {
  try {
    await sweep(checkoutStatus);
  } catch (err) {
    console.error('sweep failed', err);
  }
  // Rescheduled after each pass, so passes never overlap however slow the provider is.
  setTimeout(sweepLoop, 1000);
}

await mongoose.connect(MONGO_URL);
await initDb();
sweepLoop();
app.listen(APP_PORT, (err) => {
  if (err) throw err;
  console.log(`app listening port=${APP_PORT}`);
});
