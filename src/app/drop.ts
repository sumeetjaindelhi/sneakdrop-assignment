import { randomUUID } from 'node:crypto';
import { HOLD_SECONDS, MAX_PER_USER, STOCK } from './config.ts';
import { Counter, LineEntry, Pair } from './models.ts';

const isDuplicate = (err: unknown) => (err as { code?: unknown }).code === 11000;

const newHold = (userId: string, sold: number) => ({
  status: 'held',
  userId,
  slot: `${userId}#${sold + 1}`,
  holdId: randomUUID(),
  expiresAt: new Date(Date.now() + HOLD_SECONDS * 1000),
});

export async function initDb() {
  // Mongoose's automatic index build is not awaited, and the sale rules rely on these unique indexes.
  await Pair.createIndexes();
  await LineEntry.createIndexes();
  await Pair.bulkWrite(Array.from({ length: STOCK }, (_, i) => ({
    updateOne: { filter: { _id: i + 1 }, update: { $setOnInsert: { status: 'available' } }, upsert: true },
  })));
  const count = await Pair.countDocuments();
  if (count !== STOCK) {
    throw new Error(`found ${count} pairs but STOCK=${STOCK}; to change STOCK, start over with docker compose down -v`);
  }
}

export async function buy(userId: string) {
  const mine = await Pair.find({ userId }, 'status').lean();
  if (mine.some((p) => p.status === 'held')) return 'already_holding';
  const sold = mine.filter((p) => p.status === 'sold').length;
  if (sold >= MAX_PER_USER) return 'limit_reached';
  // Pairs freed by an expiry belong to the people already waiting.
  if (await LineEntry.exists({})) return 'none_left';
  try {
    const pair = await Pair.findOneAndUpdate(
      { status: 'available' },
      { $set: newHold(userId, sold) },
      { returnDocument: 'after' },
    );
    return pair ? 'held' : 'none_left';
  } catch (err) {
    // Another request for this user won the race for the hold or for the slot.
    if (!isDuplicate(err)) throw err;
    return (await Pair.exists({ userId, status: 'held' })) ? 'already_holding' : 'limit_reached';
  }
}

export async function joinLine(userId: string) {
  const pairs = await Pair.find({}, 'status userId').lean();
  const mine = pairs.filter((p) => p.userId === userId);
  if (mine.some((p) => p.status === 'held')) return 'already_holding';
  if (mine.filter((p) => p.status === 'sold').length >= MAX_PER_USER) return 'limit_reached';
  if (pairs.every((p) => p.status === 'sold')) return 'sold_out';
  // Buy is refused while anyone waits, so a free pair only sends people to Buy when the line is empty.
  if (pairs.some((p) => p.status === 'available') && !(await LineEntry.exists({}))) return 'pairs_left';
  const { seq } = await Counter.findOneAndUpdate(
    { _id: 'line' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).orFail().lean<{ seq: number }>();
  try {
    await LineEntry.create({ userId, seq, joinedAt: new Date() });
    return 'joined';
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    return 'already_in_line';
  }
}

export async function currentHold(userId: string) {
  return Pair.findOne({ userId, status: 'held' }, 'holdId expiresAt checkoutId -_id')
    .lean<{ holdId: string; expiresAt: Date; checkoutId?: string }>();
}

export async function attachCheckout(holdId: string, checkoutId: string) {
  const { matchedCount } = await Pair.updateOne(
    { holdId, status: 'held', expiresAt: { $gt: new Date() } },
    { $set: { checkoutId } },
  );
  return matchedCount === 1;
}

export async function markPaid(holdId: string) {
  const pair = await Pair.findOneAndUpdate({ holdId, status: 'held' }, {
    $set: { status: 'sold', soldAt: new Date() },
    $unset: { expiresAt: '' },
  });
  if (pair) return 'sold';
  return (await Pair.exists({ holdId, status: 'sold' })) ? 'duplicate' : 'hold_gone';
}

async function handOver(filter: {
  _id: number | null;
  status: 'available' | 'held';
  holdId?: string | null;
  checkoutId?: string | null;
}) {
  while (true) {
    const head = await LineEntry.findOne().sort({ seq: 1 }).lean();
    if (!head) {
      await Pair.updateOne(filter, {
        $set: { status: 'available' },
        $unset: { userId: '', slot: '', holdId: '', expiresAt: '', checkoutId: '' },
      });
      return;
    }
    const theirs = await Pair.find({ userId: head.userId }, 'status soldAt').lean();
    const sold = theirs.filter((p) => p.status === 'sold').length;
    // A head who holds a pair or bought one after joining was already served; a crash left the entry behind.
    const served = theirs.some((p) => p.status === 'held' || (p.soldAt && p.soldAt > head.joinedAt));
    if (served || sold >= MAX_PER_USER) {
      await LineEntry.deleteOne({ _id: head._id });
      continue;
    }
    try {
      const { matchedCount } = await Pair.updateOne(filter, {
        $set: newHold(head.userId, sold),
        $unset: { checkoutId: '' },
      });
      // The pair was sold, checked out or handed over since the sweep looked at it; the head keeps their place.
      if (matchedCount === 0) return;
      await LineEntry.deleteOne({ _id: head._id });
      console.log(`handed over pair=${filter._id} user=${head.userId}`);
      return;
    } catch (err) {
      // The head got a hold or filled that slot in the meantime, so they no longer need their place.
      if (!isDuplicate(err)) throw err;
      await LineEntry.deleteOne({ _id: head._id });
    }
  }
}

export async function sweep(
  checkoutStatus: (checkoutId: string) => Promise<'open' | 'paid' | 'expired' | 'refunded' | null>,
) {
  const pairs = await Pair.find({}, 'status holdId expiresAt checkoutId').lean();
  if (pairs.every((p) => p.status === 'sold')) {
    await LineEntry.deleteMany({});
    return;
  }
  const now = new Date();
  const expired = pairs.filter((p) => p.status === 'held' && p.expiresAt && p.expiresAt <= now);
  for (const p of expired.filter((p) => !p.checkoutId)) {
    await handOver({ _id: p._id, status: 'held', holdId: p.holdId, checkoutId: null });
  }
  if (await LineEntry.exists({})) {
    for (const p of pairs.filter((p) => p.status === 'available')) {
      await handOver({ _id: p._id, status: 'available' });
    }
  }
  // Asked last, so a slow or unreachable provider never delays the holds that never started paying.
  const paying = expired.filter((p) => p.checkoutId);
  const answers = await Promise.allSettled(paying.map((p) => checkoutStatus(p.checkoutId!)));
  for (const [i, p] of paying.entries()) {
    const answer = answers[i];
    if (answer.status === 'rejected') {
      console.error(`checkout status failed checkout=${p.checkoutId} error=${answer.reason}`);
    } else if (answer.value === 'paid') {
      const result = await markPaid(p.holdId!);
      console.log(`expired hold paid checkout=${p.checkoutId} hold=${p.holdId} result=${result}`);
    } else if (['expired', 'refunded', null].includes(answer.value)) {
      // An open checkout can still be paid, so only these answers free the pair.
      await handOver({ _id: p._id, status: 'held', holdId: p.holdId, checkoutId: p.checkoutId });
    }
  }
}

// One read serves every open page, so watching the sale costs the database the same for ten viewers or ten thousand.
export async function snapshot() {
  const [pairs, line] = await Promise.all([
    Pair.find({}, 'status userId expiresAt checkoutId').lean(),
    LineEntry.find({}, 'userId').sort({ seq: 1 }).lean(),
  ]);
  return { pairs, positions: new Map(line.map((entry, i) => [entry.userId, i + 1])) };
}

export function statusOf({ pairs, positions }: Awaited<ReturnType<typeof snapshot>>, userId?: string) {
  const held = pairs.filter((p) => p.status === 'held');
  const sold = pairs.filter((p) => p.status === 'sold');
  const soldOut = sold.length === pairs.length;
  const counts = {
    total: pairs.length,
    left: pairs.length - held.length - sold.length,
    held: held.length,
    sold: sold.length,
    soldOut,
  };
  if (!userId) return { ...counts, user: null };

  const hold = held.find((p) => p.userId === userId);
  return {
    ...counts,
    user: {
      name: userId,
      bought: sold.filter((p) => p.userId === userId).length,
      hold: hold?.expiresAt ? { expiresAt: hold.expiresAt, paying: Boolean(hold.checkoutId) } : null,
      linePosition: hold || soldOut ? null : positions.get(userId) ?? null,
    },
  };
}

export async function getStatus(userId?: string) {
  return statusOf(await snapshot(), userId);
}
