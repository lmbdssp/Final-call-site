import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ODDS_API_KEY = process.env.ODDS_API_KEY;

const SPORT_KEYS = {
  NFL: 'americanfootball_nfl',
  NBA: 'basketball_nba',
  MLB: 'baseball_mlb',
  NHL: 'icehockey_nhl',
  Soccer: 'soccer_epl',
  NCAAF: 'americanfootball_ncaaf',
  NCAAB: 'basketball_ncaab',
};

async function fetchScores(sportKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=2`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Scores fetch failed for ${sportKey}: ${res.status}`);
    return [];
  }
  return res.json();
}

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!ODDS_API_KEY) {
    return res.status(500).json({ error: 'ODDS_API_KEY is not set' });
  }

  let gradedCount = 0;

  for (const [label, key] of Object.entries(SPORT_KEYS)) {
    const games = await fetchScores(key);

    for (const game of games) {
      if (!game.completed || !game.scores) continue;
      const homeScoreObj = game.scores.find(s => s.name === game.home_team);
      const awayScoreObj = game.scores.find(s => s.name === game.away_team);
      if (!homeScoreObj || !awayScoreObj) continue;

      const actualHome = Number(homeScoreObj.score);
      const actualAway = Number(awayScoreObj.score);
      const gameDate = game.commence_time.slice(0, 10);

      const { data: rows } = await supabase
        .from('daily_picks')
        .select('id,best_pick_type,best_pick_team,best_pick_point,best_pick_direction')
        .eq('sport', label)
        .eq('game_date', gameDate)
        .eq('home_team', game.home_team)
        .eq('away_team', game.away_team)
        .eq('graded', false);

      if (!rows || rows.length === 0) continue;

      const homeWon = actualHome > actualAway;
      const actualTotal = actualHome + actualAway;
      const homeMargin = actualHome - actualAway; // positive if home won, negative if away won

      for (const row of rows) {
        let correct;
        if (row.best_pick_type === 'Total') {
          correct = row.best_pick_direction === 'Over'
            ? actualTotal > row.best_pick_point
            : actualTotal < row.best_pick_point;
        } else if (row.best_pick_type === 'Spread') {
          const teamMargin = row.best_pick_team === game.home_team ? homeMargin : -homeMargin;
          correct = teamMargin + Number(row.best_pick_point) > 0;
        } else {
          // Moneyline (or any legacy row without a type — treat as moneyline)
          const pickedHome = row.best_pick_team === game.home_team;
          correct = pickedHome ? homeWon : !homeWon;
        }

        await supabase.from('daily_picks').update({
          actual_home_score: actualHome,
          actual_away_score: actualAway,
          graded: true,
          correct,
        }).eq('id', row.id);

        gradedCount++;
      }
    }
  }

  res.status(200).json({ graded: gradedCount });
}
