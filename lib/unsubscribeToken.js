import crypto from 'crypto';

const SECRET = process.env.CRON_SECRET;

export function makeUnsubscribeToken(email) {
  return crypto.createHmac('sha256', SECRET).update(email.toLowerCase()).digest('hex');
}

export function verifyUnsubscribeToken(email, token) {
  if (!email || !token) return false;
  const expected = makeUnsubscribeToken(email);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
