import { createClient } from '@supabase/supabase-js';

// Picks a single, reliable source for the daily feed: The Odds API.
// It returns real fixtures, real bookmaker lines, AND final scores
// (used by grade-picks.js) from one account/key — simpler and cheaper
// than juggling a separate scores provider.
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

// One player-prop market per sport — keeps the extra API cost to one
// market per game instead of pulling every available prop type.
const PROP_MARKETS = {
  NFL: { market: 'player_anytime_td', label: 'Anytime TD' },
  NCAAF: { market: 'player_anytime_td', label: 'Anytime TD' },
  NBA: { market: 'player_points', label: 'Points' },
  NCAAB: { market: 'player_points', label: 'Points' },
  MLB: { market: 'batter_home_runs', label: 'Anytime HR' },
  NHL: { market: 'player_goal_scorer_anytime', label: 'Anytime Goal' },
  Soccer: { market: 'player_shots_on_target', label: 'Shots on Target' },
};

function formatProp(outcome, label) {
  if (outcome.point != null) {
    return `${outcome.description} ${outcome.name} ${outcome.point} ${label}`;
  }
  return `${outcome.name} ${label}`;
}

async function getBestProp(sportKey, eventId, sportLabel) {
  const propConfig = PROP_MARKETS[sportLabel];
  if (!propConfig) return null;

  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=${propConfig.market}&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) return null; // prop market may not be posted yet for this game

  const data = await res.json();
  const book = data.bookmakers?.[0];
  const market = book?.markets?.find(m => m.key === propConfig.market);
  if (!market || !market.outcomes?.length) return null;

  let best = null;
  for (const outcome of market.outcomes) {
    const prob = americanToProb(outcome.price);
    if (!best || prob > best.prob) best = { outcome, prob };
  }
  return best ? formatProp(best.outcome, propConfig.label) : null;
}

function americanToProb(odds) {
  return odds < 0 ? (-odds) / ((-odds) + 100) : 100 / (odds + 100);
}

async function fetchSportOdds(sportLabel, sportKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Odds fetch failed for ${sportLabel}: ${res.status}`);
    return [];
  }
  const games = await res.json();
  const picks = [];

  for (const game of games) {
    const book = game.bookmakers?.[0];
    if (!book) continue;
    const h2h = book.markets.find(m => m.key === 'h2h');
    const spreadsMkt = book.markets.find(m => m.key === 'spreads');
    const totalsMkt = book.markets.find(m => m.key === 'totals');
    if (!h2h) continue;

    const homeOutcome = h2h.outcomes.find(o => o.name === game.home_team);
    const awayOutcome = h2h.outcomes.find(o => o.name === game.away_team);
    if (!homeOutcome || !awayOutcome) continue;

    // --- Moneyline candidate ---
    const homeProb = americanToProb(homeOutcome.price);
    const awayProb = americanToProb(awayOutcome.price);
    const mlTeam = homeProb >= awayProb ? game.home_team : game.away_team;
    const mlOdds = homeProb >= awayProb ? homeOutcome.price : awayOutcome.price;
    const mlConfidence = Math.round(Math.max(homeProb, awayProb) * 100);
    const mlPickStr = `${mlTeam} ML`;

    // --- Spread candidate (which side the market leans, via juice) ---
    let spreadConfidence = 0, spreadPickStr = null, spreadOdds = null, spreadTeam = null, spreadPoint = null;
    if (spreadsMkt) {
      const homeSpread = spreadsMkt.outcomes.find(o => o.name === game.home_team);
      const awaySpread = spreadsMkt.outcomes.find(o => o.name === game.away_team);
      if (homeSpread && awaySpread) {
        const homeSpreadProb = americanToProb(homeSpread.price);
        const awaySpreadProb = americanToProb(awaySpread.price);
        const pick = homeSpreadProb >= awaySpreadProb ? homeSpread : awaySpread;
        spreadTeam = pick.name;
        spreadPoint = pick.point;
        spreadOdds = pick.price;
        spreadConfidence = Math.round(Math.max(homeSpreadProb, awaySpreadProb) * 100);
        spreadPickStr = `${spreadTeam} ${spreadPoint > 0 ? '+' : ''}${spreadPoint}`;
      }
    }

    // --- Total candidate (over vs under, via juice) ---
    let totalConfidence = 0, totalPickStr = null, totalOdds = null, totalDirection = null, totalPoint = null;
    if (totalsMkt) {
      const over = totalsMkt.outcomes.find(o => o.name === 'Over');
      const under = totalsMkt.outcomes.find(o => o.name === 'Under');
      if (over && under) {
        const overProb = americanToProb(over.price);
        const underProb = americanToProb(under.price);
        const pick = overProb >= underProb ? over : under;
        totalDirection = pick.name;
        totalPoint = pick.point;
        totalOdds = pick.price;
        totalConfidence = Math.round(Math.max(overProb, underProb) * 100);
        totalPickStr = `${totalDirection} ${totalPoint}`;
      }
    }

    // --- Best pick across all three markets, by confidence ---
    const candidates = [
      { type: 'Moneyline', confidence: mlConfidence, summary: mlPickStr, odds: mlOdds, team: mlTeam, point: null, direction: null },
      { type: 'Spread', confidence: spreadConfidence, summary: spreadPickStr, odds: spreadOdds, team: spreadTeam, point: spreadPoint, direction: null },
      { type: 'Total', confidence: totalConfidence, summary: totalPickStr, odds: totalOdds, team: null, point: totalPoint, direction: totalDirection },
    ].filter(c => c.summary);
    const best = candidates.reduce((a, b) => (b.confidence > a.confidence ? b : a));

    let predictedHome = null, predictedAway = null;
    if (spreadsMkt && totalsMkt) {
      const homeSpreadPt = spreadsMkt.outcomes.find(o => o.name === game.home_team)?.point;
      const totalPt = totalsMkt.outcomes?.[0]?.point;
      if (homeSpreadPt != null && totalPt != null) {
        predictedHome = Math.round(((totalPt - homeSpreadPt) / 2) * 10) / 10;
        predictedAway = Math.round((totalPt - predictedHome) * 10) / 10;
      }
    }

    // Extra API call per game — this is the cost tradeoff for real player props.
    const propPick = await getBestProp(sportKey, game.id, sportLabel);

    picks.push({
      game_date: game.commence_time.slice(0, 10),
      commence_time: game.commence_time,
      sport: sportLabel,
      away_team: game.away_team,
      home_team: game.home_team,
      predicted_away_score: predictedAway,
      predicted_home_score: predictedHome,
      ml_pick: mlPickStr,
      ml_odds: mlOdds,
      spread_pick: spreadPickStr,
      spread_odds: spreadOdds,
      total_pick: totalPickStr,
      total_odds: totalOdds,
      best_pick_type: best.type,
      best_pick_team: best.team,
      best_pick_point: best.point,
      best_pick_direction: best.direction,
      pick_summary: `${best.summary} (${best.odds > 0 ? '+' : ''}${best.odds})`,
      odds: best.odds,
      prop_pick: propPick,
      confidence: best.confidence,
      is_parlay_pick: false,
    });
  }
  return picks;
}

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!ODDS_API_KEY) {
    return res.status(500).json({ error: 'ODDS_API_KEY is not set' });
  }

  let allPicks = [];
  for (const [label, key] of Object.entries(SPORT_KEYS)) {
    const picks = await fetchSportOdds(label, key);
    allPicks = allPicks.concat(picks);
  }

  const today = new Date().toISOString().slice(0, 10);
  const todaysPicks = allPicks.filter(p => p.game_date === today);
  todaysPicks.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  todaysPicks.slice(0, 3).forEach(p => { p.is_parlay_pick = true; });

  if (allPicks.length === 0) {
    return res.status(200).json({ inserted: 0, note: 'No games returned — check quota/sport keys.' });
  }

  const { error } = await supabase.from('daily_picks').insert(allPicks);
  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'Insert failed', detail: error.message });
  }

  res.status(200).json({ inserted: allPicks.length, parlayPicks: todaysPicks.slice(0, 3).length });
}
