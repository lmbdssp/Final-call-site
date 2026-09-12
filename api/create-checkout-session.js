import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, plan } = req.body || {};
  if (!email || !plan) return res.status(400).json({ error: 'Missing email or plan' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const { data: allowed } = await supabase.rpc('check_rate_limit', { p_key: `checkout:${ip}`, p_max_count: 5, p_window_seconds: 60 });
  if (allowed === false) {
    return res.status(429).json({ error: 'Too many requests — please try again in a minute.' });
  }

  const priceId = plan === 'weekly'
    ? process.env.STRIPE_PRICE_WEEKLY
    : process.env.STRIPE_PRICE_MONTHLY;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${req.headers.origin}/?checkout=success`,
      cancel_url: `${req.headers.origin}/?checkout=cancel`,
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start checkout' });
  }
}
