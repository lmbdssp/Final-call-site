import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function planFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_MONTHLY) return 'monthly';
  if (priceId === process.env.STRIPE_PRICE_ANNUAL) return 'annual';
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await readRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userEmail = session.customer_details?.email || session.customer_email;
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const priceId = subscription.items.data[0].price.id;
      const plan = planFromPriceId(priceId);

      await supabase.from('subscriptions').upsert({
        user_email: userEmail,
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        status: subscription.status,
        plan,
        current_period_end: new Date(subscription.items.data[0].current_period_end * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_email' });

    } else if (event.type === 'customer.subscription.updated') {
      const subscription = event.data.object;
      const priceId = subscription.items.data[0].price.id;
      const plan = planFromPriceId(priceId);

      await supabase.from('subscriptions')
        .update({
          status: subscription.status,
          plan,
          current_period_end: new Date(subscription.items.data[0].current_period_end * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('stripe_customer_id', subscription.customer);

    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;

      await supabase.from('subscriptions')
        .update({
          status: 'canceled',
          updated_at: new Date().toISOString(),
        })
        .eq('stripe_customer_id', subscription.customer);
    }
  } catch (err) {
    console.error(`Error processing Stripe webhook (${event.type}):`, err);
  }

  return res.status(200).json({ received: true });
}
