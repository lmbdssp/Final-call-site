import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const alertEmail = process.env.ALERT_EMAIL;
  if (!apiKey || !alertEmail) {
    return res.status(500).json({ error: 'RESEND_API_KEY or ALERT_EMAIL is not set' });
  }

  try {
    // subscriptions: small, irreplaceable, and the reason this job exists.
    const { data: subscriptions, error: subErr } = await supabase
      .from('subscriptions')
      .select('*');
    if (subErr) throw subErr;

    // daily_picks: only the graded results archive. Ungraded rows are
    // re-fetchable from The Odds API, so backing them up is wasted space.
    const { data: gradedPicks, error: pickErr } = await supabase
      .from('daily_picks')
      .select('game_date, sport, league, away_team, home_team, commence_time, best_pick_type, pick_summary, odds, confidence, actual_away_score, actual_home_score, correct')
      .eq('graded', true)
      .order('game_date', { ascending: false });
    if (pickErr) throw pickErr;

    const stamp = new Date().toISOString().slice(0, 10);
    const snapshot = {
      generated_at: new Date().toISOString(),
      counts: {
        subscriptions: subscriptions.length,
        graded_picks: gradedPicks.length,
      },
      subscriptions,
      graded_picks: gradedPicks,
    };

    const json = JSON.stringify(snapshot, null, 2);
    const base64 = Buffer.from(json, 'utf-8').toString('base64');

    const activeCount = subscriptions.filter(s => s.status === 'active').length;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Final Call Backups <alerts@finalcallpro.com>',
        to: alertEmail,
        subject: `[Final Call] Weekly backup — ${stamp}`,
        text: [
          `Weekly database snapshot for ${stamp}.`,
          ``,
          `Subscriptions: ${subscriptions.length} (${activeCount} active)`,
          `Graded picks: ${gradedPicks.length}`,
          ``,
          `The attached JSON covers the window past Supabase's 7-day backup retention.`,
          `Keep these emails. To restore, see RECOVERY.md section 6.`,
        ].join('\n'),
        attachments: [
          { filename: `final-call-backup-${stamp}.json`, content: base64 },
        ],
      }),
    });

    if (!emailRes.ok) {
      const body = await emailRes.text();
      throw new Error(`Resend returned ${emailRes.status}: ${body}`);
    }

    return res.status(200).json({
      ok: true,
      subscriptions: subscriptions.length,
      graded_picks: gradedPicks.length,
    });
  } catch (err) {
    console.error('Weekly backup failed:', err);
    // Best-effort failure notice — a silent backup failure is the worst outcome.
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Final Call Alerts <alerts@finalcallpro.com>',
          to: alertEmail,
          subject: '[Final Call] Weekly backup FAILED',
          text: `The weekly database backup did not complete.\n\n${err.message || String(err)}`,
        }),
      });
    } catch (_) { /* nothing more we can do */ }

    return res.status(500).json({ error: 'Backup failed' });
  }
}
