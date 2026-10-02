function positiveInt(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export const APP_PORT = positiveInt('APP_PORT', 3000);
export const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL ?? 'http://localhost:3000';
export const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/sneakdrop';
// Where the app calls the provider; under compose that is its container, not the public address.
export const PAYMENTS_URL = process.env.PAYMENTS_URL ?? process.env.PAYMENTS_PUBLIC_URL ?? 'http://localhost:4000';
export const STOCK = positiveInt('STOCK', 20);
export const HOLD_SECONDS = positiveInt('HOLD_SECONDS', 300);
export const PRICE_CENTS = positiveInt('PRICE_CENTS', 15000);
// Required, but checked when the server starts rather than here, so the tests can import this file.
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';
export const PAYMENTS_API_KEY = process.env.PAYMENTS_API_KEY ?? '';

export const MAX_PER_USER = 2;
export const NAME_RE = /^[a-z0-9_-]{1,32}$/;
