import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MAX_GAMES_PER_SPORT = { NCAAF: 5, Soccer: 8 };

function easternDateStr(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Identity/subscription comes ONLY from a verified Supabase session
// token — never trusted from the client, never influenced by any
// request parameter. This is the server-side boundary replacing the
// old client-side isSubscribed variable.
async function getIsSubscribed(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return false;
  const { data: userData } = await supabase.auth.getUser(token);
  const email = userData?.user?.email;
  if (!email) return false;
  const { data: sub } = await supabase.from('subscriptions').select('status').eq('user_email', email).maybeSingle();
  return !!(sub && sub.status === 'active');
}

export default async function handler(req, res) {
  const type = req.query.type || 'picks';

  // Public — no pick data at all, just which sports have games today.
  if (type === 'sports') {
    const todayStr = easternDateStr();
    const { data, error } = await supabase.from('daily_picks').select('sport').eq('game_date', todayStr);
    if (error) { console.error(error); return res.status(500).json({ error: 'Could not load sports' }); }
    return res.status(200).json({ sports: [...new Set((data || []).map(r => r.sport))] });
  }

  // Public — historical Track Record. The date cutoff below already
  // prevents this from ever exposing an ungraded/today's game.
  if (type === 'results') {
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'Missing date' });
    const todayStr = easternDateStr();
    if (date >= todayStr) return res.status(400).json({ error: 'Results are available for past days only' });
    const { data, error } = await supabase
      .from('daily_picks')
      .select('sport,away_team,home_team,predicted_away_score,predicted_home_score,actual_away_score,actual_home_score,graded,correct,prop_pick')
      .eq('game_date', date)
      .order('created_at', { ascending: true });
    if (error) { console.error(error); return res.status(500).json({ error: 'Could not load results' }); }
    return res.status(200).json({ results: data || [] });
  }

  // Pro-gated — zero pick data reaches a non-subscriber under any condition.
  if (type === 'parlay') {
    const isSubscribed = await getIsSubscribed(req);
    if (!isSubscribed) return res.status(200).json({ locked: true, picks: [] });
    const todayStr = easternDateStr();
    const { data, error } = await supabase
      .from('daily_picks')
      .select('sport,away_team,home_team,parlay_pick_summary,parlay_odds,parlay_confidence')
      .eq('game_date', todayStr)
      .eq('is_parlay_pick', true)
      .order('parlay_confidence', { ascending: false })
      .limit(3);
    if (error) { console.error(error); return res.status(500).json({ error: 'Could not load parlay' }); }
    return res.status(200).json({ locked: false, picks: data || [] });
  }

  // type === 'picks' — the main paywall boundary.
  const sport = req.query.sport;
  if (!sport) return res.status(400).json({ error: 'Missing sport' });
  const isSubscribed = await getIsSubscribed(req);

  const todayStr = easternDateStr();
  const { data, error } = await supabase
    .from('daily_picks')
    .select('sport,league,away_team,home_team,commence_time,ml_pick,ml_odds,spread_pick,spread_odds,total_pick,total_odds,best_pick_type,prop_pick,confidence,value_edge,best_book')
    .eq('game_date', todayStr)
    .eq('sport', sport)
    .order('commence_time', { ascending: true });

  if (error) { console.error(error); return res.status(500).json({ error: 'Could not load games' }); }
  if (!data || data.length === 0) return res.status(200).json({ games: [], trimmed: false, totalBeforeTrim: 0, isSubscribed });

  // Same trim rule as before — ranking uses server-held value_edge
  // internally; that field is still stripped from the response below
  // for any game the caller isn't entitled to see.
  const cap = MAX_GAMES_PER_SPORT[sport];
  let rows = data;
  let trimmed = false;
  const totalBeforeTrim = data.length;
  if (cap && data.length > cap) {
    const anyEdge = data.some(g => g.value_edge != null);
    const rank = g => anyEdge ? (g.value_edge ?? -999) : (g.confidence || 0);
    rows = [...data].sort((a, b) => rank(b) - rank(a)).slice(0, cap).sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    trimmed = true;
  }

  const hasProps = sport !== 'Soccer' && sport !== 'MLB' && sport !== 'NCAAF';

  // The actual field-level paywall. `i === 0` (deterministic, server-
  // computed, no client-supplied offset/sort/index exists anywhere in
  // this handler) is the one free pick per sport. Every other game gets
  // ONLY the public metadata fields — recommendation fields are not
  // included in the object at all, not nulled, not present.
  const games = rows.map((g, i) => {
    const freeGame = i === 0;
    const fullAccess = isSubscribed || freeGame;
    const base = {
      sport: g.sport, league: g.league, away_team: g.away_team, home_team: g.home_team,
      commence_time: g.commence_time,
      locked: !fullAccess,
    };
    if (fullAccess) {
      base.ml_pick = g.ml_pick; base.ml_odds = g.ml_odds;
      base.spread_pick = g.spread_pick; base.spread_odds = g.spread_odds;
      base.total_pick = g.total_pick; base.total_odds = g.total_odds;
      base.best_pick_type = g.best_pick_type;
      base.confidence = g.confidence;
      base.value_edge = g.value_edge;
      base.best_book = g.best_book;
    }
    // Props have no free exception — gated on isSubscribed alone, not fullAccess.
    if (hasProps) {
      base.has_props = true;
      if (isSubscribed) base.prop_pick = g.prop_pick;
    }
    return base;
  });

  res.status(200).json({ games, trimmed, totalBeforeTrim, cap: cap || null, isSubscribed });
}
