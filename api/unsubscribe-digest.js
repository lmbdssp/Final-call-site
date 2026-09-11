import { createClient } from '@supabase/supabase-js';
import { verifyUnsubscribeToken } from './lib/unsubscribeToken.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  const { email, token } = req.query;
  res.setHeader('Content-Type', 'text/html');

  if (!email || !verifyUnsubscribeToken(String(email), String(token))) {
    return res.status(400).send('<html><body style="font-family:sans-serif;background:#0A0A0A;color:#fff;text-align:center;padding:60px;"><h2>Invalid or expired unsubscribe link.</h2></body></html>');
  }

  await supabase.from('subscriptions').update({ digest_opt_out: true }).eq('user_email', String(email).toLowerCase());

  res.status(200).send('<html><body style="font-family:sans-serif;background:#0A0A0A;color:#fff;text-align:center;padding:60px;"><h2>You\'ve been unsubscribed from the daily picks email.</h2><p>Your Final Call Pro subscription is unaffected — this only stops the daily email digest.</p></body></html>');
}
