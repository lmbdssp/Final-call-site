import { createClient } from '@supabase/supabase-js';
import { sendAlert } from '../lib/alert.js';

// Isolated from the customer Track Record's LOGIC — never writes to
// daily_picks/pick_candidates, and never reads pick-level fields
// (confidence, correct, best_pick_type, odds, algorithm output). Reads
// ONLY the literal completed-game score already fetched and stored by
// grade-picks.js, to avoid a duplicate Odds API call. This is a
// one-way, read-only borrow of a raw sports fact, not a dependency on
// anything the Track Record computes or displays.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function gradeShadowPick(marketType, selection, point, homeTeam, actualHome, actualAway) {
  const isDraw = actualHome === actualAway;
  const homeWon = actualHome > actualAway;
  const actualTotal = actualHome + actualAway;
  const homeMargin = actualHome - actualAway;
  if (marketType === 'Total') {
    if (actualTotal === Number(point)) return 'push';
    const hit = selection === 'Over' ? actualTotal > point : actualTotal < point;
    return hit ? 'win' : 'loss';
  } else if (marketType === 'Spread') {
    const teamMargin = selection === homeTeam ? homeMargin : -homeMargin;
    const margin = teamMargin + Number(point);
    if (margin === 0) return 'push';
    return margin > 0 ? 'win' : 'loss';
  } else {
    if (selection === 'Draw') return isDraw ? 'win' : 'loss';
    if (isDraw) return 'loss';
    const pickedHome = selection === homeTeam;
    return (pickedHome ? homeWon : !homeWon) ? 'win' : 'loss';
  }
}

export default async function handler(req, res) {
  try {
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data: pending } = await supabase
      .from('shadow_candidates')
      .select('id, sport, away_team, home_team, commence_time, market_type, selection, point')
      .is('result', null);

    if (!pending || pending.length === 0) {
      return res.status(200).json({ graded: 0, note: 'Nothing pending' });
    }

    // Read-only reuse of scores grade-picks.js already fetched — zero
    // new Odds API calls. Only the literal score is read.
    const { data: completedGames } = await supabase
      .from('daily_picks')
      .select('sport, away_team, home_team, commence_time, actual_home_score, actual_away_score')
      .eq('graded', true)
      .not('actual_home_score', 'is', null);

    const scoreMap = new Map();
    for (const g of completedGames || []) {
      const key = `${g.sport}|${g.away_team}|${g.home_team}|${new Date(g.commence_time).getTime()}`;
      scoreMap.set(key, { home: Number(g.actual_home_score), away: Number(g.actual_away_score) });
    }

    let gradedCount = 0;
    let skippedNoScore = 0;
    for (const row of pending) {
      const key = `${row.sport}|${row.away_team}|${row.home_team}|${new Date(row.commence_time).getTime()}`;
      const score = scoreMap.get(key);
      if (!score) { skippedNoScore++; continue; }
      const result = gradeShadowPick(row.market_type, row.selection, row.point, row.home_team, score.home, score.away);
      await supabase.from('shadow_candidates').update({
        result,
        actual_home_score: score.home,
        actual_away_score: score.away,
        graded_at: new Date().toISOString(),
      }).eq('id', row.id);
      gradedCount++;
    }

    res.status(200).json({ graded: gradedCount, skippedNoScore, pending: pending.length });
  } catch (err) {
    console.error(err);
    await sendAlert('grade-shadow cron failed', err.message || String(err));
    res.status(500).json({ error: 'Internal error' });
  }
}
