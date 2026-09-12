import { createClient } from '@supabase/supabase-js';
import { fetchWithRetry } from '../lib/fetchWithRetry.js';
import { sendAlert } from '../lib/alert.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ODDS_API_KEY = process.env.ODDS_API_KEY;

const SPORT_KEYS = {
  NFL: 'americanfootball_nfl',
  NBA: 'basketball_nba',
  MLB: 'baseball_mlb',
  NHL: 'icehockey_nhl',
  Soccer: [
  'soccer_epl',
  'soccer_uefa_champs_league',
  'soccer_uefa_europa_league',
  'soccer_uefa_europa_conference_league',
  'soccer_spain_la_liga',
  'soccer_italy_serie_a',
  'soccer_france_ligue_one',
  'soccer_germany_bundesliga',
  'soccer_usa_mls',
],

  NCAAF: 'americanfootball_ncaaf',
  NCAAB: 'basketball_ncaab',
};

async function fetchScores(sportKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3`;
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    console.error(`Scores fetch failed for ${sportKey}: ${res.status}`);
    return [];
  }
  return res.json();
}

export default async function handler(req, res) {
  try {
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!ODDS_API_KEY) {
      return res.status(500).json({ error: 'ODDS_API_KEY is not set' });
    }

    let gradedCount = 0;

    for (const [label, keys] of Object.entries(SPORT_KEYS)) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        const games = await fetchScores(key);

        for (const game of games) {
          if (!game.completed || !game.scores) continue;
          const homeScoreObj = game.scores.find(s => s.name === game.home_team);
          const awayScoreObj = game.scores.find(s => s.name === game.away_team);
          if (!homeScoreObj || !awayScoreObj) continue;

          const actualHome = Number(homeScoreObj.score);
          const actualAway = Number(awayScoreObj.score);
          const gameDate = new Date(new Date(game.commence_time).toLocaleString('en-US', { timeZone: 'America/New_York' })).toISOString().slice(0, 10);

          const { data: rows } = await supabase
            .from('daily_picks')
            .select('id,best_pick_type,best_pick_team,best_pick_point,best_pick_direction,parlay_pick_type,parlay_pick_team,parlay_pick_point,parlay_pick_direction')
            .eq('sport', label)
            .eq('game_date', gameDate)
            .eq('home_team', game.home_team)
            .eq('away_team', game.away_team)
            .eq('graded', false);

          if (!rows || rows.length === 0) continue;

          const homeWon = actualHome > actualAway;
          const actualTotal = actualHome + actualAway;
          const homeMargin = actualHome - actualAway; // positive if home won, negative if away won

          function gradePick(type, team, point, direction) {
            if (type === 'Total') {
              return direction === 'Over' ? actualTotal > point : actualTotal < point;
            } else if (type === 'Spread') {
              const teamMargin = team === game.home_team ? homeMargin : -homeMargin;
              return teamMargin + Number(point) > 0;
            } else {
              // Moneyline (or any legacy row without a type — treat as moneyline)
              const pickedHome = team === game.home_team;
              return pickedHome ? homeWon : !homeWon;
            }
          }

          for (const row of rows) {
            const correct = gradePick(row.best_pick_type, row.best_pick_team, row.best_pick_point, row.best_pick_direction);
            // Parlay legs can differ from the straight pick (parlay allows
            // heavier favorites, up to -500 vs -200), so grade separately.
            const parlay_correct = row.parlay_pick_type
              ? gradePick(row.parlay_pick_type, row.parlay_pick_team, row.parlay_pick_point, row.parlay_pick_direction)
              : null;

            await supabase.from('daily_picks').update({
              actual_home_score: actualHome,
              actual_away_score: actualAway,
              graded: true,
              correct,
              parlay_correct,
            }).eq('id', row.id);

            gradedCount++;
          }
        }
      }
    }

    const { data: stuck } = await supabase
      .from('daily_picks')
      .select('id,sport,away_team,home_team,commence_time')
      .eq('graded', false)
      .lt('commence_time', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    if (stuck && stuck.length > 0) {
      await sendAlert(
        'Games stuck ungraded',
        stuck.map(g => `${g.sport}: ${g.away_team} @ ${g.home_team} (${g.commence_time})`).join('\n')
      );
    }

    res.status(200).json({ graded: gradedCount });
  } catch (err) {
    console.error(err);
    await sendAlert('grade-picks cron failed', err.message || String(err));
    return res.status(500).json({ error: 'Internal error' });
  }
}
