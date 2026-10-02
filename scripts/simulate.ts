import { setTimeout as sleep } from 'node:timers/promises';

const APP_URL = process.env.APP_PUBLIC_URL ?? 'http://localhost:3000';
const PAYMENTS_URL = process.env.PAYMENTS_URL ?? process.env.PAYMENTS_PUBLIC_URL ?? 'http://localhost:4000';
const BUYERS = Number(process.env.BUYERS ?? 2000);
const PAY_DELAY_MS = Number(process.env.PAY_DELAY_MS ?? 0);
if (!Number.isInteger(BUYERS) || BUYERS < 1) throw new Error('BUYERS must be a positive integer');
if (!Number.isFinite(PAY_DELAY_MS) || PAY_DELAY_MS < 0) throw new Error('PAY_DELAY_MS must be a number of 0 or more');

const post = (path: string, user: string) => fetch(APP_URL + path, { method: 'POST', headers: { 'x-user': user } });

let paid = 0;

async function pay(user: string) {
  await sleep(PAY_DELAY_MS);
  const res = await post('/api/checkout', user);
  if (!res.ok) return;
  const { url } = (await res.json()) as { url: string };
  // Only the path is kept: the URL names the provider's public host, which the app container can't reach.
  const payment = await fetch(`${PAYMENTS_URL}${new URL(url).pathname}/pay`, { method: 'POST', redirect: 'manual' });
  if (payment.status === 303) paid++;
}

async function buyer(user: string) {
  const result: string = await post('/api/buy', user)
    .then((res) => res.json() as Promise<Record<string, string>>)
    .then((body) => body.result ?? body.error)
    // A connection that fails in the rush is reported with the other answers instead of ending the run.
    .catch((err) => err.cause?.code ?? err.name);
  if (result === 'held') await pay(user);
  return result;
}

// Sent all at once, the requests overflow the 128 connections macOS lets wait to be accepted and get
// reset. 100 in flight is five times the stock and as many queries as the app's MongoDB driver runs at once.
const results: string[] = [];
let next = 0;
await Promise.all(Array.from({ length: 100 }, async () => {
  while (next < BUYERS) results.push(await buyer(`user-${next++}`));
}));
const counts: Record<string, number> = {};
for (const result of results) counts[result] = (counts[result] ?? 0) + 1;
const { held = 0, none_left = 0, ...other } = counts;
console.log(`buyers=${BUYERS} held=${held} none_left=${none_left} other=${JSON.stringify(other)}`);

const deadline = Date.now() + 60_000;
let status;
do {
  await sleep(500);
  status = (await (await fetch(`${APP_URL}/api/status`)).json()) as { sold: number; total: number };
} while (status.sold !== paid && Date.now() < deadline);
console.log(`paid=${paid} sold=${status.sold} total=${status.total}`);
process.exitCode = status.sold === paid && held <= status.total ? 0 : 1;
