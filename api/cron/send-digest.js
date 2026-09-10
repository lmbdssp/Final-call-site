import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function easternDateStr(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY is not set' });

  const today = easternDateStr();
  const { data: picks } = await supabase
    .from('daily_picks')
    .select('sport,away_team,home_team,pick_summary,confidence')
    .eq('game_date', today)
    .order('confidence', { ascending: false })
    .limit(5);

  if (!picks || picks.length === 0) return res.status(200).json({ sent: 0, note: 'No picks for today yet' });

  const { data: subs } = await supabase.from('subscriptions').select('user_email').eq('status', 'active');
  if (!subs || subs.length === 0) return res.status(200).json({ sent: 0, note: 'No active subscribers' });

  const pickListHtml = picks.map(p =>
    `<li>${p.away_team} @ ${p.home_team} — <b>${p.pick_summary}</b>${p.confidence != null ? ` (${p.confidence}%)` : ''}</li>`
  ).join('');

  let sent = 0;
  for (const sub of subs) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Final Call <picks@finalcallpro.com>',
          to: sub.user_email,
          subject: `Today's Final Calls — ${today}`,
          html: `<h2>Today's Top Picks</h2><ul>${pickListHtml}</ul><p><a href="https://finalcallpro.com/">See all games</a></p>`,
        }),
      });
      sent++;
    } catch (err) {
      console.error(`Failed to send digest to ${sub.user_email}:`, err);
    }
  }
  res.status(200).json({ sent });
}
