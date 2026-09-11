import { createClient } from '@supabase/supabase-js';
import { fetchWithRetry } from '../lib/fetchWithRetry.js';
import { sendAlert } from '../lib/alert.js';

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
  Soccer: [
  'soccer_epl',
  'soccer_uefa_champs_league',
  'soccer_uefa_europa_league',
  'soccer_uefa_europa_conference_league',
  'soccer_spain_la_liga',
  'soccer_italy_serie_a',
  'soccer_france_ligue_one',
  'soccer_usa_mls',
],

  NCAAF: 'americanfootball_ncaaf',
  NCAAB: 'basketball_ncaab',
};
const COMPETITION_LABELS = {
  soccer_epl: 'Premier League',
  soccer_uefa_champs_league: 'Champions League',
  soccer_uefa_europa_league: 'Europa League',
  soccer_uefa_europa_conference_league: 'Conference League',
  soccer_spain_la_liga: 'La Liga',
  soccer_italy_serie_a: 'Serie A',
  soccer_france_ligue_one: 'Ligue 1',
  soccer_usa_mls: 'MLS',
};


// One player-prop market per sport — keeps the extra API cost to one
// market per game instead of pulling every available prop type.
const PROP_MARKETS = {
  NFL: { market: 'player_anytime_td', label: 'Anytime TD' },
  NCAAF: { market: 'player_anytime_td', label: 'Anytime TD' },
  NBA: { market: 'player_points', label: 'Points' },
  NCAAB: { market: 'player_points', label: 'Points' },
  NHL: { market: 'player_goal_scorer_anytime', label: 'Anytime Goal' },
};

function formatProp(outcome, label) {
  if (outcome.description) {
    return outcome.point != null
      ? `${outcome.description} ${outcome.name} ${outcome.point} ${label}`
      : `${outcome.description} ${label}`;
  }
  return `${outcome.name} ${label}`;
}

// Scans every bookmaker in the response (not just the first) for one that
// has actually posted this market — coverage varies book to book, so
// pinning to index 0 was silently dropping props/lines that other books had.
function findMarket(bookmakers, key) {
  for (const book of bookmakers || []) {
    const market = book.markets?.find(m => m.key === key);
    if (market?.outcomes?.length) return market;
  }
  return null;
}

async function getBestProp(sportKey, eventId, sportLabel) {
  const propConfig = PROP_MARKETS[sportLabel];
  if (!propConfig) return null;

  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=${propConfig.market}&oddsFormat=american`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null; // prop market may not be posted yet for this game

  const data = await res.json();
  const market = findMarket(data.bookmakers, propConfig.market);
  if (!market) return null;

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
  const regions = sportLabel === 'Soccer' ? 'us,uk' : 'us';
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=${regions}&markets=h2h,spreads,totals&oddsFormat=american`;
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    console.error(`Odds fetch failed for ${sportLabel}: ${res.status}`);
    return [];
  }
  const games = await res.json();
  const picks = [];

  for (const game of games) {
    if (!game.bookmakers?.length) continue;
    const h2h = findMarket(game.bookmakers, 'h2h');
    const spreadsMkt = findMarket(game.bookmakers, 'spreads');
    const totalsMkt = findMarket(game.bookmakers, 'totals');
    // Skip only if NO market at all is posted — a game with just a
    // Spread or Total (common for lopsided FBS-vs-FCS-style mismatches
    // where books skip posting a Moneyline) should still show up.
    if (!h2h && !spreadsMkt && !totalsMkt) continue;

    // --- Moneyline candidate (only if a h2h market was posted) ---
    let mlConfidence = 0, mlPickStr = null, mlOdds = null, mlTeam = null;
    if (h2h) {
      const homeOutcome = h2h.outcomes.find(o => o.name === game.home_team);
      const awayOutcome = h2h.outcomes.find(o => o.name === game.away_team);
      if (homeOutcome && awayOutcome) {
        const homeProb = americanToProb(homeOutcome.price);
        const awayProb = americanToProb(awayOutcome.price);
        mlTeam = homeProb >= awayProb ? game.home_team : game.away_team;
        mlOdds = homeProb >= awayProb ? homeOutcome.price : awayOutcome.price;
        mlConfidence = Math.round(Math.max(homeProb, awayProb) * 100);
        mlPickStr = `${mlTeam} ML`;
      }
    }

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
    // Cap how lopsided a pick can be before it's featured: straight game
    // cards stay objective (max -200), while the parlay bundle can use a
    // heavier favorite (max -500) as a safe anchor leg.
    const MAX_STRAIGHT_ODDS = -200;
    const MAX_PARLAY_ODDS = -500;
    const candidates = [
      { type: 'Moneyline', confidence: mlConfidence, summary: mlPickStr, odds: mlOdds, team: mlTeam, point: null, direction: null },
      { type: 'Spread', confidence: spreadConfidence, summary: spreadPickStr, odds: spreadOdds, team: spreadTeam, point: spreadPoint, direction: null },
      { type: 'Total', confidence: totalConfidence, summary: totalPickStr, odds: totalOdds, team: null, point: totalPoint, direction: totalDirection },
    ].filter(c => c.summary);
    if (candidates.length === 0) continue; // no usable market at all — nothing to show for this game

    const straightCandidates = candidates.filter(c => c.odds == null || c.odds > MAX_STRAIGHT_ODDS);
    const best = (straightCandidates.length ? straightCandidates : candidates)
      .reduce((a, b) => (b.confidence > a.confidence ? b : a));

    const parlayCandidates = candidates.filter(c => c.odds == null || c.odds > MAX_PARLAY_ODDS);
    const parlayBest = (parlayCandidates.length ? parlayCandidates : candidates)
      .reduce((a, b) => (b.confidence > a.confidence ? b : a));

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
      game_date: new Date(new Date(game.commence_time).toLocaleString('en-US', { timeZone: 'America/New_York' })).toISOString().slice(0, 10),

      commence_time: game.commence_time,
      sport: sportLabel,
      league: sportLabel === 'Soccer' ? (COMPETITION_LABELS[sportKey] || null) : null,

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
      parlay_pick_type: parlayBest.type,
      parlay_pick_team: parlayBest.team,
      parlay_pick_point: parlayBest.point,
      parlay_pick_direction: parlayBest.direction,
      parlay_pick_summary: `${parlayBest.summary} (${parlayBest.odds > 0 ? '+' : ''}${parlayBest.odds})`,
      parlay_odds: parlayBest.odds,
      parlay_confidence: parlayBest.confidence,
      is_parlay_pick: false,
    });
  }
  return picks;
}

export default async function handler(req, res) {
  try {
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!ODDS_API_KEY) {
      return res.status(500).json({ error: 'ODDS_API_KEY is not set' });
    }

    let allPicks = [];
    for (const [label, keys] of Object.entries(SPORT_KEYS)) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        const picks = await fetchSportOdds(label, key);
        allPicks = allPicks.concat(picks);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const todaysPicks = allPicks.filter(p => p.game_date === today);
    todaysPicks.sort((a, b) => (b.parlay_confidence || 0) - (a.parlay_confidence || 0));
    todaysPicks.slice(0, 3).forEach(p => { p.is_parlay_pick = true; });

    if (allPicks.length === 0) {
      await sendAlert('fetch-picks returned zero games', 'Check Odds API quota/keys.');
      return res.status(200).json({ inserted: 0, note: 'No games returned — check quota/sport keys.' });
    }

    const { error } = await supabase.from('daily_picks').upsert(allPicks, {
      onConflict: 'sport,away_team,home_team,commence_time',
    });
    if (error) {
      console.error(error);
      return res.status(500).json({ error: 'Insert failed', detail: error.message });
    }

    res.status(200).json({ inserted: allPicks.length, parlayPicks: todaysPicks.slice(0, 3).length });
  } catch (err) {
    console.error(err);
    await sendAlert('fetch-picks cron failed', err.message || String(err));
    return res.status(500).json({ error: 'Internal error' });
  }
}
