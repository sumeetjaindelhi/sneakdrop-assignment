import { createHmac, timingSafeEqual } from 'node:crypto';
import { PAYMENTS_API_KEY, PAYMENTS_URL } from './config.ts';

function request(method: string, path: string, body?: object) {
  return fetch(PAYMENTS_URL + path, {
    method,
    headers: { authorization: `Bearer ${PAYMENTS_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
}

export async function createCheckout(checkout: {
  reference: string;
  amount: number;
  expiresAt: Date;
  returnUrl: string;
}) {
  const res = await request('POST', '/checkouts', checkout);
  if (!res.ok) throw new Error(`payments answered ${res.status} to create checkout`);
  return (await res.json()) as { id: string; url: string };
}

export async function checkoutStatus(id: string) {
  const res = await request('GET', `/checkouts/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`payments answered ${res.status} to checkout status`);
  return ((await res.json()) as { status: 'open' | 'paid' | 'expired' | 'refunded' }).status;
}

export async function refund(id: string) {
  const res = await request('POST', `/checkouts/${encodeURIComponent(id)}/refund`);
  if (!res.ok) throw new Error(`payments answered ${res.status} to refund checkout=${id}`);
}

export function verifySignature(rawBody: Buffer, header: string | undefined, secret: string) {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
