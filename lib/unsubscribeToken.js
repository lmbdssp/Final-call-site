import crypto from 'crypto';

// Dedicated secret, separate from CRON_SECRET. Falls back to CRON_SECRET
// only if UNSUBSCRIBE_SECRET hasn't been set yet in Vercel — add that
// env var to complete the separation. Note: once UNSUBSCRIBE_SECRET is
// set, any unsubscribe link already sent under the old CRON_SECRET-signed
// token will stop verifying. Low-impact — these are daily-refreshed
// links, not long-lived credentials.
const SECRET = process.env.UNSUBSCRIBE_SECRET || process.env.CRON_SECRET;

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
