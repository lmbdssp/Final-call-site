import { createClient } from '@supabase/supabase-js';
import { fetchWithRetry } from '../lib/fetchWithRetry.js';
import { sendAlert } from '../lib/alert.js';

// Fully isolated from grade-picks.js and daily_picks/pick_candidates.
// This file NEVER reads from or writes to the customer-facing Track
// Record — it only reads/writes shadow_candidates. Makes its own
// independent Odds API scores calls rather than sharing any data or
// code path with the production grading job.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ODDS_API_KEY = process.env.ODDS_API_KEY;

const SPORT_KEYS = {
  NFL: 'americanfootball_nfl',
  NBA: 'basketball_nba',
  MLB: 'baseball_mlb',
  NHL: 'icehockey_nhl',
  Soccer: [
    'soccer_epl', 'soccer_uefa_champs_league', 'soccer_uefa_europa_league',
    'soccer_uefa_europa_conference_league', 'soccer_spain_la_liga',
    'soccer_italy_serie_a', 'soccer_france_ligue_one', 'soccer_germany_bundesliga',
    'soccer_usa_mls',
  ],
  NCAAF: 'americanfootball_ncaaf',
  NCAAB: 'basketball_ncaab',
};

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

    // Give games a few hours after kickoff before expecting a final score.
    const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const { data: pending } = await supabase
      .from('shadow_candidates')
      .select('id, sport, away_team, home_team, commence_time, market_type, selection, point')
      .is('result', null)
      .lt('commence_time', cutoff);

    if (!pending || pending.length === 0) {
      return res.status(200).json({ graded: 0, note: 'Nothing pending' });
    }

    const bySport = {};
    for (const row of pending) (bySport[row.sport] ||= []).push(row);

    let gradedCount = 0;
    for (const [label, rows] of Object.entries(bySport)) {
      const keys = SPORT_KEYS[label];
      if (!keys) continue;
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        const url = `https://api.the-odds-api.com/v4/sports/${key}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3`;
        const res2 = await fetchWithRetry(url);
        if (!res2.ok) continue;
        const games = await res2.json();
        for (const game of games) {
          if (!game.completed || !game.scores) continue;
          const homeScore = Number(game.scores.find(s => s.name === game.home_team)?.score);
          const awayScore = Number(game.scores.find(s => s.name === game.away_team)?.score);
          if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) continue;

          const matches = rows.filter(r => r.away_team === game.away_team && r.home_team === game.home_team);
          for (const row of matches) {
            const result = gradeShadowPick(row.market_type, row.selection, row.point, game.home_team, homeScore, awayScore);
            await supabase.from('shadow_candidates').update({
              result,
              actual_home_score: homeScore,
              actual_away_score: awayScore,
              graded_at: new Date().toISOString(),
            }).eq('id', row.id);
            gradedCount++;
          }
        }
      }
    }
    res.status(200).json({ graded: gradedCount });
  } catch (err) {
    console.error(err);
    await sendAlert('grade-shadow cron failed', err.message || String(err));
    res.status(500).json({ error: 'Internal error' });
  }
}
