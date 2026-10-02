import { Schema, model } from 'mongoose';

const pairSchema = new Schema({
  _id: Number,
  status: { type: String, enum: ['available', 'held', 'sold'], required: true },
  userId: String,
  slot: String,
  holdId: String,
  expiresAt: Date,
  checkoutId: String,
  soldAt: Date,
}, { versionKey: false });
// One hold per user, enforced by the database so that simultaneous Buys can't both win.
pairSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'held' } });
// A held or sold pair takes slot `${userId}#1` or `#2`, which caps each user at two pairs under races too.
pairSchema.index({ slot: 1 }, { unique: true, partialFilterExpression: { slot: { $exists: true } } });

export const Pair = model('Pair', pairSchema);

export const LineEntry = model('LineEntry', new Schema({
  userId: { type: String, required: true, unique: true },
  seq: { type: Number, required: true, unique: true },
  joinedAt: { type: Date, required: true },
}, { versionKey: false }), 'line');

export const Counter = model('Counter', new Schema({ _id: String, seq: Number }, { versionKey: false }));
