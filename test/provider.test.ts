import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifySignature } from '../src/app/provider.ts';

const secret = 'webhook-secret';
const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', data: { reference: 'hold-1' } }));
const sign = (data: Buffer, key: string) => `sha256=${createHmac('sha256', key).update(data).digest('hex')}`;

test('a signature made with the secret over the exact body is accepted', () => {
  assert.equal(verifySignature(body, sign(body, secret), secret), true);
});

test('a signature for a changed body or made with another secret is rejected', () => {
  const tampered = Buffer.from(body.toString().replace('hold-1', 'hold-2'));

  assert.equal(verifySignature(tampered, sign(body, secret), secret), false);
  assert.equal(verifySignature(body, sign(body, 'other-secret'), secret), false);
});

test('a missing or malformed signature header is rejected', () => {
  const hex = sign(body, secret).slice('sha256='.length);

  for (const header of [undefined, '', 'sha256=', hex, `sha512=${hex}`, `sha256=${hex.slice(2)}`, `sha256=${hex}00`]) {
    assert.equal(verifySignature(body, header, secret), false, `header ${header}`);
  }
});
