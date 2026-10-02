import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { HOLD_SECONDS, MONGO_URL, STOCK } from '../src/app/config.ts';
import { attachCheckout, buy, currentHold, getStatus, initDb, joinLine, markPaid, sweep } from '../src/app/drop.ts';
import { Counter, LineEntry, Pair } from '../src/app/models.ts';

before(() => mongoose.connect(MONGO_URL, { dbName: 'sneakdrop_test' }));
after(() => mongoose.disconnect());

beforeEach(async () => {
  await Promise.all([Pair.deleteMany({}), LineEntry.deleteMany({}), Counter.deleteMany({})]);
  await initDb();
});

const uniqueKeys = (indexes: { key: object; unique?: boolean }[]) =>
  indexes.filter((i) => i.unique).map((i) => Object.keys(i.key).join()).sort();

const tally = (results: string[]) => {
  const counts: Record<string, number> = {};
  for (const result of results) counts[result] = (counts[result] ?? 0) + 1;
  return counts;
};

const buyAndPay = async (userId: string) => {
  assert.equal(await buy(userId), 'held');
  const hold = await currentHold(userId);
  assert.ok(hold);
  assert.equal(await markPaid(hold.holdId), 'sold');
};

const expire = (userId: string) =>
  Pair.updateOne({ userId, status: 'held' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

test('initDb builds the indexes on an empty database and is safe to repeat', async () => {
  await mongoose.connection.dropDatabase();
  await initDb();
  await buyAndPay('alice');
  await initDb();

  assert.equal(await Pair.countDocuments(), STOCK);
  assert.equal(await Pair.countDocuments({ status: 'sold' }), 1);
  assert.deepEqual(uniqueKeys(await Pair.collection.indexes()), ['slot', 'userId']);
  assert.deepEqual(uniqueKeys(await LineEntry.collection.indexes()), ['seq', 'userId']);
});

test('initDb refuses a database that holds more pairs than STOCK', async () => {
  await Pair.create({ _id: STOCK + 1, status: 'available' });

  await assert.rejects(initDb(), /docker compose down -v/);
});

test('500 simultaneous buyers get exactly STOCK holds', async () => {
  const results = await Promise.all(Array.from({ length: 500 }, (_, i) => buy(`user-${i}`)));

  assert.deepEqual(tally(results), { held: STOCK, none_left: 500 - STOCK });
  assert.equal(await Pair.countDocuments({ status: 'held' }), STOCK);
});

test('one user clicking Buy 50 times at once gets one hold', async () => {
  const results = await Promise.all(Array.from({ length: 50 }, () => buy('alice')));

  assert.deepEqual(tally(results), { held: 1, already_holding: 49 });
  assert.equal(await Pair.countDocuments({ status: 'held' }), 1);
});

test('a user can buy two pairs and no more', async () => {
  await buyAndPay('alice');
  await buyAndPay('alice');

  assert.equal(await buy('alice'), 'limit_reached');
});

test('Buy racing the payment of a second pair never gives a third', async () => {
  // Five users, five chances for a Buy that counts one sold pair and writes after the second is paid.
  for (const userId of ['ann', 'bob', 'carol', 'dave', 'erin']) {
    await buyAndPay(userId);
    await Promise.all(Array.from({ length: 50 }, async () => {
      if ((await buy(userId)) !== 'held') return;
      const hold = await currentHold(userId);
      assert.ok(hold);
      await markPaid(hold.holdId);
    }));

    const mine = await Pair.find({ userId }, 'status').lean();
    assert.deepEqual(tally(mine.map((p) => p.status)), { sold: 2 });
  }
});

test('Buy is refused while someone waits in line', async () => {
  await LineEntry.create({ userId: 'bob', seq: 1, joinedAt: new Date() });

  assert.equal(await buy('alice'), 'none_left');
});

test('Buy holds a pair for HOLD_SECONDS and currentHold returns it', async () => {
  await buyAndPay('alice');
  assert.equal(await currentHold('alice'), null);

  const start = Date.now();
  await buy('alice');
  const hold = await currentHold('alice');

  assert.ok(hold);
  assert.equal(typeof hold.holdId, 'string');
  assert.equal(hold.checkoutId, undefined);
  assert.ok(hold.expiresAt.getTime() >= start + HOLD_SECONDS * 1000);
  assert.ok(hold.expiresAt.getTime() <= Date.now() + HOLD_SECONDS * 1000);

  assert.equal(await attachCheckout(hold.holdId, 'chk_1'), true);
  assert.equal((await currentHold('alice'))?.checkoutId, 'chk_1');
});

test('getStatus counts pairs, and pairs that are only held do not make it sold out', async () => {
  await buyAndPay('carol');
  await Promise.all(Array.from({ length: STOCK - 1 }, (_, i) => buy(`user-${i}`)));

  assert.deepEqual(await getStatus(), { total: STOCK, left: 0, held: STOCK - 1, sold: 1, soldOut: false, user: null });
});

test('getStatus shows the user what they bought and when their hold ends', async () => {
  await buyAndPay('alice');
  await buy('alice');
  const hold = await currentHold('alice');
  assert.ok(hold);

  assert.deepEqual((await getStatus('alice')).user, {
    name: 'alice', bought: 1, hold: { expiresAt: hold.expiresAt, paying: false }, linePosition: null,
  });

  assert.equal(await attachCheckout(hold.holdId, 'chk_1'), true);
  assert.equal((await getStatus('alice')).user?.hold?.paying, true);
});

test('getStatus gives waiting users their place in line', async () => {
  const joinedAt = new Date();
  await LineEntry.create([
    { userId: 'bob', seq: 4, joinedAt },
    { userId: 'carol', seq: 7, joinedAt },
    { userId: 'dave', seq: 9, joinedAt },
  ]);

  assert.equal((await getStatus('bob')).user?.linePosition, 1);
  assert.equal((await getStatus('dave')).user?.linePosition, 3);
  assert.equal((await getStatus('erin')).user?.linePosition, null);
});

test('getStatus shows no place in line while holding a pair or once sold out', async () => {
  await Promise.all(Array.from({ length: STOCK - 1 }, (_, i) => buyAndPay(`buyer-${i}`)));
  await buy('alice');
  const hold = await currentHold('alice');
  assert.ok(hold);
  await LineEntry.create({ userId: 'alice', seq: 1, joinedAt: new Date() });
  assert.equal((await getStatus('alice')).user?.linePosition, null);

  await markPaid(hold.holdId);
  const status = await getStatus('alice');
  assert.equal(status.soldOut, true);
  assert.equal(status.user?.linePosition, null);
});

test('attachCheckout refuses a hold that has expired', async () => {
  await buy('alice');
  const hold = await currentHold('alice');
  assert.ok(hold);
  await expire('alice');

  assert.equal(await attachCheckout(hold.holdId, 'chk_1'), false);
  assert.equal((await currentHold('alice'))?.checkoutId, undefined);
});

test('a payment sells the held pair once and a repeat is a duplicate', async () => {
  await buy('alice');
  const hold = await currentHold('alice');
  assert.ok(hold);

  assert.equal(await markPaid(hold.holdId), 'sold');
  assert.equal(await markPaid(hold.holdId), 'duplicate');
  assert.equal(await currentHold('alice'), null);
  assert.equal((await getStatus('alice')).user?.bought, 1);
});

test('a payment for a hold that ran out and was released is hold_gone', async () => {
  await buy('alice');
  const hold = await currentHold('alice');
  assert.ok(hold);
  await expire('alice');
  await sweep(async () => null);

  assert.equal(await markPaid(hold.holdId), 'hold_gone');
  assert.equal((await getStatus()).sold, 0);
});

test('joinLine sends people to Buy while pairs are left and queues them once none are', async () => {
  assert.equal(await joinLine('bob'), 'pairs_left');
  await Promise.all(Array.from({ length: STOCK }, (_, i) => buy(`user-${i}`)));

  assert.equal(await joinLine('user-0'), 'already_holding');
  assert.equal(await joinLine('bob'), 'joined');
  assert.equal(await joinLine('bob'), 'already_in_line');
  assert.equal(await joinLine('carol'), 'joined');
  assert.equal((await getStatus('carol')).user?.linePosition, 2);
});

test('joinLine refuses someone who already bought two pairs', async () => {
  await buyAndPay('alice');
  await buyAndPay('alice');

  assert.equal(await joinLine('alice'), 'limit_reached');
});

test('selling the last pair turns joinLine away, and the next sweep closes the line', async () => {
  await Promise.all(Array.from({ length: STOCK - 1 }, (_, i) => buyAndPay(`buyer-${i}`)));
  await buy('alice');
  const hold = await currentHold('alice');
  assert.ok(hold);
  assert.equal(await joinLine('bob'), 'joined');

  await markPaid(hold.holdId);
  assert.equal(await joinLine('carol'), 'sold_out');
  await sweep(async () => null);
  assert.equal(await LineEntry.countDocuments(), 0);
});

test('a pair that is free while people wait goes to the line, and newcomers queue behind them', async () => {
  // Bob got in line just as a hold ran out with nobody waiting, so a pair is free while he waits.
  await LineEntry.create({ userId: 'bob', seq: 0, joinedAt: new Date() });
  assert.equal(await buy('carol'), 'none_left');
  assert.equal(await joinLine('carol'), 'joined');
  assert.equal((await getStatus('carol')).user?.linePosition, 2);

  await sweep(async () => null);
  assert.ok(await currentHold('bob'));
  assert.ok(await currentHold('carol'));
  assert.equal(await LineEntry.countDocuments(), 0);
});

test('expired holds go back to stock when nobody waits, and their holders can buy again', async () => {
  await buy('bob');
  await buy('alice');
  await expire('bob');
  await expire('alice');

  await sweep(async () => null);
  assert.equal(await currentHold('alice'), null);
  assert.equal((await getStatus()).left, STOCK);
  // Bob's pair is free too, so alice's new hold can land on another pair, which only works if her slot was cleared.
  assert.equal(await buy('alice'), 'held');
});

test('an expired hold goes to the first person in line with a fresh hold', async () => {
  await Promise.all(Array.from({ length: STOCK }, (_, i) => buy(`user-${i}`)));
  assert.equal(await joinLine('bob'), 'joined');
  assert.equal(await joinLine('carol'), 'joined');
  const old = await currentHold('user-0');
  assert.ok(old);
  await expire('user-0');

  const start = Date.now();
  await sweep(async () => null);
  const hold = await currentHold('bob');
  assert.ok(hold);
  assert.notEqual(hold.holdId, old.holdId);
  assert.ok(hold.expiresAt.getTime() >= start + HOLD_SECONDS * 1000);
  assert.equal(await currentHold('user-0'), null);
  assert.equal(await LineEntry.exists({ userId: 'bob' }), null);
  assert.equal((await getStatus('carol')).user?.linePosition, 1);
});

test('the line skips people who hold a pair, bought one since joining, or already have two', async () => {
  await buyAndPay('ann');
  await buyAndPay('ann');
  await buyAndPay('bob');
  await buy('dave');
  await Promise.all(Array.from({ length: STOCK - 4 }, (_, i) => buy(`user-${i}`)));
  // Entries a crash or a race can leave behind, ahead of erin who is still waiting for her pair.
  await LineEntry.create([
    { userId: 'ann', seq: 1, joinedAt: new Date() },
    { userId: 'bob', seq: 2, joinedAt: new Date(Date.now() - 60_000) },
    { userId: 'dave', seq: 3, joinedAt: new Date() },
    { userId: 'erin', seq: 4, joinedAt: new Date() },
  ]);
  await expire('user-0');

  await sweep(async () => null);
  assert.ok(await currentHold('erin'));
  assert.equal(await LineEntry.countDocuments(), 0);
  assert.equal(await Pair.countDocuments({ userId: 'ann' }), 2);
  assert.equal(await Pair.countDocuments({ userId: 'bob' }), 1);
  assert.equal(await Pair.countDocuments({ userId: 'dave' }), 1);
});

test('at expiry a hold that started paying follows what the provider says', async () => {
  const answers: Record<string, 'open' | 'paid' | 'expired' | 'refunded' | null> = {
    paid: 'paid', open: 'open', expired: 'expired', refunded: 'refunded', unknown: null,
  };
  for (const userId of Object.keys(answers)) {
    await buy(userId);
    const hold = await currentHold(userId);
    assert.ok(hold);
    assert.equal(await attachCheckout(hold.holdId, userId), true);
  }
  await Promise.all(Array.from({ length: STOCK - 5 }, (_, i) => buy(`user-${i}`)));
  assert.equal(await joinLine('bob'), 'joined');
  for (const userId of Object.keys(answers)) await expire(userId);

  await sweep(async (checkoutId) => answers[checkoutId]);
  assert.equal((await getStatus('paid')).user?.bought, 1);
  assert.ok(await currentHold('open'));
  for (const userId of ['expired', 'refunded', 'unknown']) assert.equal(await currentHold(userId), null);
  const hold = await currentHold('bob');
  assert.ok(hold);
  assert.equal(hold.checkoutId, undefined);
  assert.equal((await getStatus()).left, 2);
});

test('while the provider is down, a hold that started paying waits and the others still expire', async () => {
  await buy('alice');
  const hold = await currentHold('alice');
  assert.ok(hold);
  assert.equal(await attachCheckout(hold.holdId, 'chk_1'), true);
  await buy('bob');
  await expire('alice');
  await expire('bob');

  await sweep(async () => {
    throw new Error('provider down');
  });
  assert.ok(await currentHold('alice'));
  assert.equal(await currentHold('bob'), null);
  assert.equal((await getStatus()).left, STOCK - 1);
});

test('a sweep that loses the pair to another hand-over keeps the next person waiting', async () => {
  await Promise.all(Array.from({ length: STOCK }, (_, i) => buy(`user-${i}`)));
  const hold = await currentHold('user-0');
  assert.ok(hold);
  assert.equal(await attachCheckout(hold.holdId, 'chk_1'), true);
  await joinLine('bob');
  await joinLine('carol');
  await expire('user-0');

  // While this sweep waits for the provider, another one hands the pair to bob.
  await sweep(async () => {
    await sweep(async () => 'expired');
    return 'expired';
  });
  assert.ok(await currentHold('bob'));
  assert.equal((await getStatus('carol')).user?.linePosition, 1);
});
