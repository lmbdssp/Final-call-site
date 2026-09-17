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
  'soccer_germany_bundesliga',
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
  soccer_germany_bundesliga: 'Bundesliga',
  soccer_usa_mls: 'MLS',
};


// One player-prop market per sport — keeps the extra API cost to one
// market per game instead of pulling every available prop type.
const PROP_MARKETS = {
  NFL: { market: 'player_anytime_td', label: 'Anytime TD' },
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

// Confirmed classifications from The Odds API's actual book list (see
// audit findings, Sept 2026). Anything not explicitly listed here is
// 'unknown' and — same as exchanges — excluded from consensus/best-price/
// scoring, per explicit instruction not to silently trust unknown sources.
// Their raw data is still preserved in market_snapshots, just not used.
const EXCHANGE_BOOKS = new Set(['Betfair', 'Smarkets', 'Matchbook']);
const KNOWN_SPORTSBOOKS = new Set([
  'DraftKings','Bovada','BetMGM','BetRivers','BetUS','BetOnline.ag','LowVig.ag',
  'FanDuel','Caesars','Fanatics','MyBookie.ag','William Hill','LeoVegas','Grosvenor',
  'Casumo','Virgin Bet','LiveScore Bet','Betfred (UK)','Coral','Ladbrokes','Sky Bet',
  '888sport','BoyleSports','Betway','Paddy Power','Unibet (UK)','Betano (UK)',
  'Bet Victor','Betfair Sportsbook',
]);
function classifySource(bookName) {
  if (EXCHANGE_BOOKS.has(bookName)) return 'exchange';
  if (KNOWN_SPORTSBOOKS.has(bookName)) return 'sportsbook';
  return 'unknown';
}

// Every bookmaker that posted this market, not just the first one.
// Tags each entry with source_type so downstream code can decide who
// participates in consensus/best-price vs. who's just being recorded.
function collectMarkets(bookmakers, key) {
  const out = [];
  for (const book of bookmakers || []) {
    const market = book.markets?.find(m => m.key === key);
    if (market?.outcomes?.length) {
      const bookName = book.title || book.key;
      out.push({ book: bookName, outcomes: market.outcomes, lastUpdate: book.last_update || market.last_update || null, sourceType: classifySource(bookName) });
    }
  }
  return out;
}

// Raw per-book quotes for one game, across all three markets — this is
// the input data a consensus/pick was built from. Preserved so a past
// Final Call can eventually be reproduced exactly, not just re-described.
function buildSnapshotRows(game, sportLabel, h2hEntries, spreadEntries, totalEntries) {
  const rows = [];
  const push = (entries, marketType) => {
    for (const e of entries) {
      for (const o of e.outcomes) {
        rows.push({
          sport: sportLabel,
          away_team: game.away_team,
          home_team: game.home_team,
          commence_time: game.commence_time,
          market_type: marketType,
          book: e.book,
          selection: o.name,
          point: o.point ?? null,
          american_odds: o.price,
          book_last_update: e.lastUpdate,
          source_type: e.sourceType,
        });
      }
    }
  };
  // Unfiltered — every book gets recorded, exchange/unknown included.
  // This is the audit trail; filtering happens downstream, not here.
  push(h2hEntries, 'h2h');
  push(spreadEntries, 'spreads');
  push(totalEntries, 'totals');
  return rows;
}

// Strip the bookmaker's margin: raw implied probabilities on a two-way
// market sum to more than 100% (a -110/-110 spread sums to ~104.8%).
// Normalizing to 1 gives the book's actual opinion.
function devigPair(priceA, priceB) {
  const a = americanToProb(priceA);
  const b = americanToProb(priceB);
  const sum = a + b;
  if (!sum) return null;
  return { a: a / sum, b: b / sum };
}

// Group entries by their actual line, so Over 8 and Over 8.5 are never
// averaged together — they're genuinely different propositions.
function groupByPoint(entries, sideName) {
  const groups = new Map();
  for (const e of entries) {
    const o = e.outcomes.find(x => x.name === sideName);
    if (o?.point == null) continue;
    if (!groups.has(o.point)) groups.set(o.point, []);
    groups.get(o.point).push(e);
  }
  return groups;
}

// Testing threshold — a line needs at least this many sportsbooks quoting
// both sides before its consensus is trusted enough to be a candidate.
const MIN_BOOKS_PER_LINE = 2;

// Evaluate EVERY distinct line independently (Over 8, Over 8.5, Over 9...)
// instead of collapsing to whichever line happens to be most common. The
// most-quoted line isn't necessarily the one with the best value — this
// was previously discarding 12-29% of book coverage for no good reason.
function bestLineCandidate(entries, sideName, matchA, matchB, nameA, nameB, evaluatedAt) {
  const groups = groupByPoint(entries, sideName);
  let best = null, bestOther = null;
  for (const [, lineEntries] of groups) {
    const c = consensusTwoWay(lineEntries, matchA, matchB);
    if (!c || c.books < MIN_BOOKS_PER_LINE) continue;
    const s = buildSide(c, c.probA >= c.probB, nameA, nameB, evaluatedAt);
    const score = s.confidence + (s.value != null ? s.value * 100 : 0);
    if (!best || score > best.score) {
      best = { ...s, score };
      // The other side of this same line — not eliminated, just not the
      // one used for the live pick. Analysis-only.
      bestOther = buildSide(c, !(c.probA >= c.probB), nameA, nameB, evaluatedAt);
    }
  }
  return best ? { primary: best, other: bestOther } : null;
}

// Sample standard deviation of per-book fair probabilities — how much the
// contributing books actually agree. Undefined (null) with fewer than 2
// books; you can't measure agreement from a single source.
function stdDev(arr) {
  if (arr.length < 2) return null;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function oldestOf(dates) { return dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null; }
function newestOf(dates) { return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null; }

// De-vig each book, average into a consensus, and track which book is
// offering the best price on each side. Higher American odds are always
// better for the bettor, so a plain numeric max works here. Also tracks
// each contributing quote's own timestamp, so freshness can be evaluated
// per candidate later — this function still only computes probabilities
// and prices; it does not decide freshness pass/fail.
function consensusTwoWay(entries, matchA, matchB) {
  const probsA = [], probsB = [];
  const quoteTimes = [];
  let bestA = null, bestB = null;
  for (const entry of entries) {
    const oa = entry.outcomes.find(matchA);
    const ob = entry.outcomes.find(matchB);
    if (!oa || !ob) continue;
    const dv = devigPair(oa.price, ob.price);
    if (!dv) continue;
    probsA.push(dv.a);
    probsB.push(dv.b);
    if (entry.lastUpdate) quoteTimes.push(new Date(entry.lastUpdate));
    if (!bestA || oa.price > bestA.price) bestA = { price: oa.price, book: entry.book, point: oa.point, lastUpdate: entry.lastUpdate };
    if (!bestB || ob.price > bestB.price) bestB = { price: ob.price, book: entry.book, point: ob.point, lastUpdate: entry.lastUpdate };
  }
  if (!probsA.length) return null;
  const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  return {
    probA: avg(probsA), probB: avg(probsB), bestA, bestB, books: probsA.length,
    stdDevA: stdDev(probsA), stdDevB: stdDev(probsB),
    oldestQuoteAt: oldestOf(quoteTimes), newestQuoteAt: newestOf(quoteTimes),
  };
}

// Shadow research infrastructure — records the broadest reasonable
// universe of candidates (negative/zero/positive edge alike) so future
// thresholds can be tested against real outcomes without survivorship
// bias. Completely separate from daily_picks/pick_candidates: does not
// read from or influence the live selection in any way.
const SHADOW_ALGORITHM_VERSION = 'consensus-v1.1';

function computeExperimentalScores(edgeFraction, stdDevValue, books) {
  if (stdDevValue == null || !stdDevValue || !books) return { scoreA: null, scoreB: null, scoreC: null };
  return {
    scoreA: edgeFraction / (stdDevValue / Math.sqrt(books)),
    scoreB: edgeFraction / stdDevValue,
    scoreC: edgeFraction / (stdDevValue / Math.sqrt(Math.min(books, 5))),
  };
}

function toShadowRow(side, marketType, game, sportLabel, evaluatedAt) {
  const { scoreA, scoreB, scoreC } = computeExperimentalScores(side.value, side.consensusStdDev, side.books);
  return {
    evaluated_at: evaluatedAt.toISOString(),
    algorithm_version: SHADOW_ALGORITHM_VERSION,
    sport: sportLabel,
    away_team: game.away_team,
    home_team: game.home_team,
    commence_time: game.commence_time,
    market_type: marketType,
    selection: side.name,
    point: side.point,
    consensus_probability: side.probability ?? null,
    books_counted: side.books,
    consensus_std_dev: side.consensusStdDev,
    best_odds: side.price,
    best_book: side.book,
    best_implied_probability: side.price != null ? americanToProb(side.price) : null,
    raw_value_edge_pp: side.value != null ? Math.round(side.value * 1000) / 10 : null,
    oldest_quote_age_seconds: side.oldestAgeSec,
    sync_window_seconds: side.syncWindowSec,
    best_price_age_seconds: side.bestPriceAgeSec,
    gate_freshness_pass: side.gateFreshnessPass,
    freshness_fail_reason: side.freshnessFailReason,
    score_a: scoreA, score_b: scoreB, score_c: scoreC,
    // Reference only — never used to decide whether this row gets stored.
    meets_edge_075: side.value != null ? side.value * 100 >= 0.75 : null,
    meets_books_4: side.books != null ? side.books >= 4 : null,
    meets_dispersion_005: side.consensusStdDev != null ? side.consensusStdDev <= 0.05 : null,
    meets_confidence_25: side.confidence != null ? side.confidence >= 25 : null,
  };
}

// Testing thresholds only — hypotheses to validate against real graded
// results, not claims that these specific numbers are correct.
const GATE_MIN_EDGE_PP = 2.0;
const GATE_MIN_BOOKS = 4;
const GATE_MAX_STD_DEV = 0.03; // 3 probability points

// Freshness thresholds — same status as the gates above: configurable
// placeholders for the diagnostic, not a chosen production cutoff. Stored
// as gate_freshness_pass/freshness_fail_reason for every candidate, but
// NOT currently used to filter live selection (see selectionScore below,
// which is unchanged) or to activate NO CALL.
const FRESHNESS_MAX_QUOTE_AGE_SECONDS = 900;   // 15 min
const FRESHNESS_MAX_SYNC_WINDOW_SECONDS = 600; // 10 min

// Core math for one side of a market, given its own probability and its
// own best price. Used for whichever side is "favored" AND for the side
// that isn't — raw probability never excludes a side before this runs.
// evaluatedAt/oldestQuoteAt/newestQuoteAt come from the consensus this
// side was built from, so freshness reflects the actual quotes used —
// not a guess or a separate lookup.
function makeSide(trueProb, best, name, books, consensusStdDev, oldestQuoteAt, newestQuoteAt, evaluatedAt) {
  const value = trueProb - americanToProb(best.price);
  const valueEdgePp = Math.round(value * 1000) / 10;
  const gateEdgePass = valueEdgePp >= GATE_MIN_EDGE_PP;
  const gateBooksPass = books >= GATE_MIN_BOOKS;
  const gateAgreementPass = consensusStdDev != null && consensusStdDev <= GATE_MAX_STD_DEV;
  const bestPriceQuoteAt = best.lastUpdate || null;
  const oldestAgeSec = oldestQuoteAt ? Math.round((evaluatedAt - oldestQuoteAt) / 1000) : null;
  const syncWindowSec = (oldestQuoteAt && newestQuoteAt) ? Math.round((newestQuoteAt - oldestQuoteAt) / 1000) : null;
  const bestPriceAgeSec = bestPriceQuoteAt ? Math.round((evaluatedAt - new Date(bestPriceQuoteAt)) / 1000) : null;
  let freshnessFailReason = null;
  if (oldestAgeSec == null || syncWindowSec == null || bestPriceAgeSec == null) {
    freshnessFailReason = 'missing_freshness_metadata';
  } else if (oldestAgeSec > FRESHNESS_MAX_QUOTE_AGE_SECONDS) {
    freshnessFailReason = 'quote_too_old';
  } else if (syncWindowSec > FRESHNESS_MAX_SYNC_WINDOW_SECONDS) {
    freshnessFailReason = 'quotes_not_synchronized';
  } else if (bestPriceAgeSec > FRESHNESS_MAX_QUOTE_AGE_SECONDS) {
    freshnessFailReason = 'best_price_stale';
  }
  const gateFreshnessPass = freshnessFailReason === null;
  return {
    name, price: best.price, point: best.point, book: best.book,
    confidence: Math.round(trueProb * 100),
    probability: trueProb, // full-precision fraction, for shadow storage — not rounded like confidence
    value, books, consensusStdDev,
    gateEdgePass, gateBooksPass, gateAgreementPass,
    oldestQuoteAt, newestQuoteAt, bestPriceQuoteAt,
    oldestAgeSec, syncWindowSec, bestPriceAgeSec,
    gateFreshnessPass, freshnessFailReason,
    // Freshness now included for completeness, but this field is still
    // metadata only — nothing downstream filters on it yet.
    gatePass: gateEdgePass && gateBooksPass && gateAgreementPass && gateFreshnessPass,
  };
}

// Given a consensus result, build the candidate for whichever side the
// market favors, priced at the best book available. Live selection still
// uses this — production behavior is unchanged by this fix.
function buildSide(c, favorA, nameA, nameB, evaluatedAt) {
  const useA = favorA;
  const best = useA ? c.bestA : c.bestB;
  const trueProb = useA ? c.probA : c.probB;
  const stdDevSide = useA ? c.stdDevA : c.stdDevB;
  return makeSide(trueProb, best, useA ? nameA : nameB, c.books, stdDevSide, c.oldestQuoteAt, c.newestQuoteAt, evaluatedAt);
}

// Both sides of a two-way market as fully independent candidates. Neither
// side is eliminated by raw win probability before its own Value Edge is
// computed — this is what the favorite-only bug audit (Sept 2026) found
// missing. Analysis-only: does not feed the live selection.
function bothSides(c, nameA, nameB, evaluatedAt) {
  return [
    makeSide(c.probA, c.bestA, nameA, c.books, c.stdDevA, c.oldestQuoteAt, c.newestQuoteAt, evaluatedAt),
    makeSide(c.probB, c.bestB, nameB, c.books, c.stdDevB, c.oldestQuoteAt, c.newestQuoteAt, evaluatedAt),
  ];
}

// All three soccer moneyline outcomes as independent candidates, using
// the corrected 3-way de-vig. Analysis-only, same as bothSides.
function threeWaySidesAll(c, homeTeam, awayTeam, evaluatedAt) {
  return [
    makeSide(c.probA, c.bestA, homeTeam, c.books, c.stdDevA, c.oldestQuoteAt, c.newestQuoteAt, evaluatedAt),
    makeSide(c.probDraw, c.bestDraw, 'Draw', c.books, c.stdDevDraw, c.oldestQuoteAt, c.newestQuoteAt, evaluatedAt),
    makeSide(c.probB, c.bestB, awayTeam, c.books, c.stdDevB, c.oldestQuoteAt, c.newestQuoteAt, evaluatedAt),
  ];
}

// Take whichever side is better priced relative to consensus — this can be
// the underdog. Previously this always took the favored side, which is why
// the site almost never showed a plus-money pick.
function bestValueSide(c, nameA, nameB) {
  const sideA = buildSide(c, true, nameA, nameB);
  const sideB = buildSide(c, false, nameA, nameB);
  return sideA.value >= sideB.value ? sideA : sideB;
}

// De-vig a genuine 3-way market (Home/Draw/Away) correctly. Dividing only
// by Home+Away (as a 2-way de-vig would) silently drops the Draw's
// probability mass — typically 20-30pp in soccer — which systematically
// inflates both Home and Away's "fair" probability. This was confirmed
// against real production data (Málaga @ Getafe, Sept 2026): the 2-way
// math reported 64.3% for a side whose correct 3-way probability was 44.8%.
function devigThreeWay(priceHome, priceDraw, priceAway) {
  const rawHome = americanToProb(priceHome);
  const rawDraw = americanToProb(priceDraw);
  const rawAway = americanToProb(priceAway);
  const sum = rawHome + rawDraw + rawAway;
  if (!sum) return null;
  return { home: rawHome / sum, draw: rawDraw / sum, away: rawAway / sum };
}

// Soccer moneylines are a 3-way market. This returns the same shape as
// consensusTwoWay (probA/probB/bestA/bestB/books/stdDevA/stdDevB) so it
// plugs directly into the existing buildSide/bestValueSide logic — Draw
// itself is still not a pickable outcome, only Home/Away compete, but
// their probabilities now correctly account for Draw's share instead of
// ignoring it.
function consensusThreeWay(entries, homeTeam, awayTeam) {
  const homeProbs = [], awayProbs = [], drawProbs = [];
  const quoteTimes = [];
  let bestHome = null, bestAway = null, bestDraw = null;
  for (const entry of entries) {
    const oh = entry.outcomes.find(o => o.name === homeTeam);
    const od = entry.outcomes.find(o => o.name === 'Draw');
    const oa = entry.outcomes.find(o => o.name === awayTeam);
    if (!oh || !od || !oa) continue; // need all three to properly de-vig
    const dv = devigThreeWay(oh.price, od.price, oa.price);
    if (!dv) continue;
    homeProbs.push(dv.home);
    awayProbs.push(dv.away);
    drawProbs.push(dv.draw);
    if (entry.lastUpdate) quoteTimes.push(new Date(entry.lastUpdate));
    if (!bestHome || oh.price > bestHome.price) bestHome = { price: oh.price, book: entry.book, point: null, lastUpdate: entry.lastUpdate };
    if (!bestAway || oa.price > bestAway.price) bestAway = { price: oa.price, book: entry.book, point: null, lastUpdate: entry.lastUpdate };
    if (!bestDraw || od.price > bestDraw.price) bestDraw = { price: od.price, book: entry.book, point: null, lastUpdate: entry.lastUpdate };
  }
  if (!homeProbs.length) return null;
  const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  return {
    probA: avg(homeProbs), probB: avg(awayProbs), probDraw: avg(drawProbs),
    bestA: bestHome, bestB: bestAway, bestDraw,
    books: homeProbs.length,
    stdDevA: stdDev(homeProbs), stdDevB: stdDev(awayProbs), stdDevDraw: stdDev(drawProbs),
    oldestQuoteAt: oldestOf(quoteTimes), newestQuoteAt: newestOf(quoteTimes),
  };
}

async function fetchSportOdds(sportLabel, sportKey, snapshotRows, evaluatedAt, shadowRows) {
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
    // Never re-pick a game that is already underway. A later refresh run
    // would otherwise overwrite a locked-in pick using live in-game odds.
    if (new Date(game.commence_time) <= new Date()) continue;
    const h2hEntries = collectMarkets(game.bookmakers, 'h2h');
    const spreadEntriesAll = collectMarkets(game.bookmakers, 'spreads');
    const totalEntriesAll = collectMarkets(game.bookmakers, 'totals');
    // Exchanges (and anything unclassified) are recorded above via
    // buildSnapshotRows, but never participate in consensus, best-price,
    // books_counted, or Value Edge — their pricing structure isn't
    // comparable to a bookmaker's line (see audit, Sept 2026).
    const h2hSb = h2hEntries.filter(e => e.sourceType === 'sportsbook');
    const spreadEntriesAllSb = spreadEntriesAll.filter(e => e.sourceType === 'sportsbook');
    const totalEntriesAllSb = totalEntriesAll.filter(e => e.sourceType === 'sportsbook');
    const h2h = findMarket(game.bookmakers, 'h2h');
    const spreadsMkt = findMarket(game.bookmakers, 'spreads');
    const totalsMkt = findMarket(game.bookmakers, 'totals');
    // Skip only if NO market at all is posted — a game with just a
    // Spread or Total (common for lopsided FBS-vs-FCS-style mismatches
    // where books skip posting a Moneyline) should still show up.
    if (!h2h && !spreadsMkt && !totalsMkt) continue;

    if (snapshotRows) {
      snapshotRows.push(...buildSnapshotRows(game, sportLabel, h2hEntries, spreadEntriesAll, totalEntriesAll));
    }

    // --- Moneyline candidate (de-vigged consensus across books) ---
    let mlConfidence = 0, mlPickStr = null, mlOdds = null, mlTeam = null;
    let mlValue = null, mlBook = null, mlBooks = null, mlGates = null;
    let mlOtherSides = []; // every side not used for the live pick — analysis only
    let mlPrimarySide = null; // the full object for the selected side — needed for shadow storage
    if (h2hSb.length) {
      // Soccer's moneyline is a real 3-way market (Home/Draw/Away) — a
      // plain 2-way de-vig ignores Draw entirely and inflates both sides.
      const c = sportLabel === 'Soccer'
        ? consensusThreeWay(h2hSb, game.home_team, game.away_team)
        : consensusTwoWay(h2hSb, o => o.name === game.home_team, o => o.name === game.away_team);
      if (c) {
        const s = buildSide(c, c.probA >= c.probB, game.home_team, game.away_team, evaluatedAt);
        mlPrimarySide = s;
        mlTeam = s.name; mlOdds = s.price; mlConfidence = s.confidence;
        mlValue = s.value; mlBook = s.book; mlBooks = s.books;
        mlGates = { stdDev: s.consensusStdDev, edgePass: s.gateEdgePass, booksPass: s.gateBooksPass, agreementPass: s.gateAgreementPass, pass: s.gatePass,
          oldestQuoteAt: s.oldestQuoteAt, newestQuoteAt: s.newestQuoteAt, bestPriceQuoteAt: s.bestPriceQuoteAt,
          oldestAgeSec: s.oldestAgeSec, syncWindowSec: s.syncWindowSec, bestPriceAgeSec: s.bestPriceAgeSec,
          freshnessPass: s.gateFreshnessPass, freshnessFailReason: s.freshnessFailReason };
        mlPickStr = `${mlTeam} ML`;

        const allSides = sportLabel === 'Soccer'
          ? threeWaySidesAll(c, game.home_team, game.away_team, evaluatedAt)
          : bothSides(c, game.home_team, game.away_team, evaluatedAt);
        mlOtherSides = allSides.filter(side => side.name !== s.name);
      }
    }

    // --- Spread candidate ---
    let spreadConfidence = 0, spreadPickStr = null, spreadOdds = null, spreadTeam = null, spreadPoint = null;
    let spreadValue = null, spreadBook = null, spreadBooks = null, spreadGates = null;
    let spreadOtherSide = null; // the other side of the same line — analysis only
    let spreadPrimarySide = null;
    if (spreadEntriesAllSb.length) {
      const result = bestLineCandidate(spreadEntriesAllSb, game.home_team, o => o.name === game.home_team, o => o.name === game.away_team, game.home_team, game.away_team, evaluatedAt);
      const s = result?.primary;
      if (s) {
        spreadPrimarySide = s;
        spreadTeam = s.name; spreadOdds = s.price; spreadPoint = s.point;
        spreadConfidence = s.confidence; spreadValue = s.value; spreadBook = s.book; spreadBooks = s.books;
        spreadGates = { stdDev: s.consensusStdDev, edgePass: s.gateEdgePass, booksPass: s.gateBooksPass, agreementPass: s.gateAgreementPass, pass: s.gatePass,
          oldestQuoteAt: s.oldestQuoteAt, newestQuoteAt: s.newestQuoteAt, bestPriceQuoteAt: s.bestPriceQuoteAt,
          oldestAgeSec: s.oldestAgeSec, syncWindowSec: s.syncWindowSec, bestPriceAgeSec: s.bestPriceAgeSec,
          freshnessPass: s.gateFreshnessPass, freshnessFailReason: s.freshnessFailReason };
        spreadPickStr = `${spreadTeam} ${spreadPoint > 0 ? '+' : ''}${spreadPoint}`;
        spreadOtherSide = result.other;
      }
    }

    // --- Total candidate ---
    let totalConfidence = 0, totalPickStr = null, totalOdds = null, totalDirection = null, totalPoint = null;
    let totalValue = null, totalBook = null, totalBooks = null, totalGates = null;
    let totalOtherSide = null; // the other side of the same line — analysis only, mirrors spreadOtherSide
    let totalPrimarySide = null;
    if (totalEntriesAllSb.length) {
      const totalResult = bestLineCandidate(totalEntriesAllSb, 'Over', o => o.name === 'Over', o => o.name === 'Under', 'Over', 'Under', evaluatedAt);
      if (totalResult) {
        const s = totalResult.primary;
        totalPrimarySide = s;
        totalDirection = s.name; totalOdds = s.price; totalPoint = s.point;
        totalConfidence = s.confidence; totalValue = s.value; totalBook = s.book; totalBooks = s.books;
        totalGates = { stdDev: s.consensusStdDev, edgePass: s.gateEdgePass, booksPass: s.gateBooksPass, agreementPass: s.gateAgreementPass, pass: s.gatePass,
          oldestQuoteAt: s.oldestQuoteAt, newestQuoteAt: s.newestQuoteAt, bestPriceQuoteAt: s.bestPriceQuoteAt,
          oldestAgeSec: s.oldestAgeSec, syncWindowSec: s.syncWindowSec, bestPriceAgeSec: s.bestPriceAgeSec,
          freshnessPass: s.gateFreshnessPass, freshnessFailReason: s.freshnessFailReason };
        totalPickStr = `${totalDirection} ${totalPoint}`;
        totalOtherSide = totalResult.other;
      }
    }

    // --- Best pick across all three markets, by confidence ---
    // Cap how lopsided a pick can be before it's featured: straight game
    // cards stay objective (max -200), while the parlay bundle can use a
    // heavier favorite (max -500) as a safe anchor leg.
    const MAX_STRAIGHT_ODDS = -200;
    const MAX_PARLAY_ODDS = -500;
    // A moneyline favorite has to clear a much higher bar to be worth taking:
    // -180 needs a 64% hit rate just to break even, while a -110 spread needs
    // 52.4%. So when a Spread or Total is within a few points of the Moneyline's
    // confidence, prefer it — same opinion, better price. Applied to the straight
    // card only; the parlay still picks on raw confidence, since there the goal
    // is genuinely maximizing the odds all three legs land.
    const ML_PRICE_PENALTY = 5;
    const candidates = [
      { type: 'Moneyline', confidence: mlConfidence, summary: mlPickStr, odds: mlOdds, team: mlTeam, point: null, direction: null, value: mlValue, book: mlBook, books: mlBooks, gates: mlGates },
      { type: 'Spread', confidence: spreadConfidence, summary: spreadPickStr, odds: spreadOdds, team: spreadTeam, point: spreadPoint, direction: null, value: spreadValue, book: spreadBook, books: spreadBooks, gates: spreadGates },
      { type: 'Total', confidence: totalConfidence, summary: totalPickStr, odds: totalOdds, team: null, point: totalPoint, direction: totalDirection, value: totalValue, book: totalBook, books: totalBooks, gates: totalGates },
    ].filter(c => c.summary);
    if (candidates.length === 0) continue; // no usable market at all — nothing to show for this game

    const straightCandidates = candidates.filter(c => c.odds == null || c.odds > MAX_STRAIGHT_ODDS);
    // Confidence alone always favors favorites (higher win probability by
    // definition). Adding value edge as a same-scale bonus lets a genuinely
    // mispriced underdog compete instead of being buried automatically —
    // typical edges run 1-5 points, so this nudges close calls rather than
    // overriding confidence outright.
    const EDGE_WEIGHT = 100;
    const selectionScore = c => c.confidence + (c.value != null ? c.value * EDGE_WEIGHT : 0)
      - (c.type === 'Moneyline' ? ML_PRICE_PENALTY : 0);
    const best = (straightCandidates.length ? straightCandidates : candidates)
      .reduce((a, b) => (selectionScore(b) > selectionScore(a) ? b : a));

    // Preserve every candidate considered, not just the winner — otherwise
    // "why did Total beat Moneyline" can never be answered after the fact,
    // even with market_snapshots. Purely additive: does not affect `best`.
    const candidateRecords = candidates.map(c => ({
      market_type: c.type,
      selected: c === best,
      confidence: c.confidence,
      value_edge: c.value != null ? Math.round(c.value * 1000) / 10 : null,
      odds: c.odds,
      team: c.team,
      point: c.point,
      direction: c.direction,
      book: c.book,
      books_counted: c.books,
      summary: c.summary,
      selection_score: Math.round(selectionScore(c) * 100) / 100,
      consensus_std_dev: c.gates?.stdDev != null ? Math.round(c.gates.stdDev * 10000) / 10000 : null,
      gate_edge_pass: c.gates?.edgePass ?? null,
      gate_books_pass: c.gates?.booksPass ?? null,
      gate_agreement_pass: c.gates?.agreementPass ?? null,
      gate_pass: c.gates?.pass ?? null,
      oldest_quote_at: c.gates?.oldestQuoteAt ?? null,
      newest_quote_at: c.gates?.newestQuoteAt ?? null,
      best_price_quote_at: c.gates?.bestPriceQuoteAt ?? null,
      oldest_quote_age_seconds: c.gates?.oldestAgeSec ?? null,
      sync_window_seconds: c.gates?.syncWindowSec ?? null,
      best_price_age_seconds: c.gates?.bestPriceAgeSec ?? null,
      freshness_max_age_seconds: FRESHNESS_MAX_QUOTE_AGE_SECONDS,
      freshness_max_sync_seconds: FRESHNESS_MAX_SYNC_WINDOW_SECONDS,
      gate_freshness_pass: c.gates?.freshnessPass ?? null,
      freshness_fail_reason: c.gates?.freshnessFailReason ?? null,
    }));

    // The side(s) NOT used for the live pick — favorite-only bug audit
    // (Sept 2026) found these were never even computed before. Recorded
    // for analysis; selected is always false and selection_score is null
    // since these never competed in the cross-market scoring above.
    const otherSideRecords = [];
    for (const side of mlOtherSides) {
      otherSideRecords.push({
        market_type: 'Moneyline', selected: false,
        confidence: side.confidence,
        value_edge: side.value != null ? Math.round(side.value * 1000) / 10 : null,
        odds: side.price, team: side.name, point: side.point, direction: null, book: side.book,
        books_counted: side.books,
        summary: side.name === 'Draw' ? 'Draw' : `${side.name} ML`,
        selection_score: null,
        consensus_std_dev: side.consensusStdDev != null ? Math.round(side.consensusStdDev * 10000) / 10000 : null,
        gate_edge_pass: side.gateEdgePass, gate_books_pass: side.gateBooksPass,
        gate_agreement_pass: side.gateAgreementPass, gate_pass: side.gatePass,
        oldest_quote_at: side.oldestQuoteAt, newest_quote_at: side.newestQuoteAt, best_price_quote_at: side.bestPriceQuoteAt,
        oldest_quote_age_seconds: side.oldestAgeSec, sync_window_seconds: side.syncWindowSec, best_price_age_seconds: side.bestPriceAgeSec,
        freshness_max_age_seconds: FRESHNESS_MAX_QUOTE_AGE_SECONDS, freshness_max_sync_seconds: FRESHNESS_MAX_SYNC_WINDOW_SECONDS,
        gate_freshness_pass: side.gateFreshnessPass, freshness_fail_reason: side.freshnessFailReason,
      });
    }
    if (spreadOtherSide) {
      const side = spreadOtherSide;
      otherSideRecords.push({
        market_type: 'Spread', selected: false,
        confidence: side.confidence,
        value_edge: side.value != null ? Math.round(side.value * 1000) / 10 : null,
        odds: side.price, team: side.name, point: side.point, direction: null, book: side.book,
        books_counted: side.books,
        summary: `${side.name} ${side.point > 0 ? '+' : ''}${side.point}`,
        selection_score: null,
        consensus_std_dev: side.consensusStdDev != null ? Math.round(side.consensusStdDev * 10000) / 10000 : null,
        gate_edge_pass: side.gateEdgePass, gate_books_pass: side.gateBooksPass,
        gate_agreement_pass: side.gateAgreementPass, gate_pass: side.gatePass,
        oldest_quote_at: side.oldestQuoteAt, newest_quote_at: side.newestQuoteAt, best_price_quote_at: side.bestPriceQuoteAt,
        oldest_quote_age_seconds: side.oldestAgeSec, sync_window_seconds: side.syncWindowSec, best_price_age_seconds: side.bestPriceAgeSec,
        freshness_max_age_seconds: FRESHNESS_MAX_QUOTE_AGE_SECONDS, freshness_max_sync_seconds: FRESHNESS_MAX_SYNC_WINDOW_SECONDS,
        gate_freshness_pass: side.gateFreshnessPass, freshness_fail_reason: side.freshnessFailReason,
      });
    }
    if (totalOtherSide) {
      const side = totalOtherSide;
      otherSideRecords.push({
        market_type: 'Total', selected: false,
        confidence: side.confidence,
        value_edge: side.value != null ? Math.round(side.value * 1000) / 10 : null,
        odds: side.price, team: null, point: side.point, direction: side.name, book: side.book,
        books_counted: side.books,
        summary: `${side.name} ${side.point}`,
        selection_score: null,
        consensus_std_dev: side.consensusStdDev != null ? Math.round(side.consensusStdDev * 10000) / 10000 : null,
        gate_edge_pass: side.gateEdgePass, gate_books_pass: side.gateBooksPass,
        gate_agreement_pass: side.gateAgreementPass, gate_pass: side.gatePass,
        oldest_quote_at: side.oldestQuoteAt, newest_quote_at: side.newestQuoteAt, best_price_quote_at: side.bestPriceQuoteAt,
        oldest_quote_age_seconds: side.oldestAgeSec, sync_window_seconds: side.syncWindowSec, best_price_age_seconds: side.bestPriceAgeSec,
        freshness_max_age_seconds: FRESHNESS_MAX_QUOTE_AGE_SECONDS, freshness_max_sync_seconds: FRESHNESS_MAX_SYNC_WINDOW_SECONDS,
        gate_freshness_pass: side.gateFreshnessPass, freshness_fail_reason: side.freshnessFailReason,
      });
    }
    candidateRecords.push(...otherSideRecords);

    // Shadow research capture — the broadest reasonable universe of
    // pregame candidates, unfiltered by edge/confidence/any threshold.
    // This is separate storage, computed from the same already-built
    // objects above; it does not affect `best`, `candidateRecords`, or
    // anything written to daily_picks/pick_candidates.
    if (shadowRows) {
      if (mlPrimarySide) shadowRows.push(toShadowRow(mlPrimarySide, 'Moneyline', game, sportLabel, evaluatedAt));
      for (const side of mlOtherSides) shadowRows.push(toShadowRow(side, 'Moneyline', game, sportLabel, evaluatedAt));
      if (spreadPrimarySide) shadowRows.push(toShadowRow(spreadPrimarySide, 'Spread', game, sportLabel, evaluatedAt));
      if (spreadOtherSide) shadowRows.push(toShadowRow(spreadOtherSide, 'Spread', game, sportLabel, evaluatedAt));
      if (totalPrimarySide) shadowRows.push(toShadowRow(totalPrimarySide, 'Total', game, sportLabel, evaluatedAt));
      if (totalOtherSide) shadowRows.push(toShadowRow(totalOtherSide, 'Total', game, sportLabel, evaluatedAt));
    }

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

    // One API call per game, so only spend it where props actually exist:
    // books don't post player props days or weeks out, and the feed returns
    // the entire upcoming schedule (hundreds of games).
    const hoursUntilStart = (new Date(game.commence_time) - new Date()) / 3600000;
    const propPick = hoursUntilStart <= 48
      ? await getBestProp(sportKey, game.id, sportLabel)
      : null;

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
      value_edge: best.value != null ? Math.round(best.value * 1000) / 10 : null,
      best_book: best.book,
      books_counted: best.books,
      parlay_pick_type: parlayBest.type,
      parlay_pick_team: parlayBest.team,
      parlay_pick_point: parlayBest.point,
      parlay_pick_direction: parlayBest.direction,
      parlay_pick_summary: `${parlayBest.summary} (${parlayBest.odds > 0 ? '+' : ''}${parlayBest.odds})`,
      parlay_odds: parlayBest.odds,
      parlay_confidence: parlayBest.confidence,
      is_parlay_pick: false,
      updated_at: new Date().toISOString(),
      // Bumped to mark the favorite-only candidate-generation fix (Sept
      // 2026) — both sides of ML/Spread are now recorded, not just the
      // favored one. Rows tagged consensus-v1 predate this and should be
      // treated as legacy when calibrating Best Call v1 thresholds.
      algorithm_version: 'consensus-v1.1',
      _candidateRecords: candidateRecords, // transient — stripped before the daily_picks upsert
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
    const snapshotRows = [];
    const shadowRows = [];
    // One evaluation timestamp for the whole run, so every candidate's
    // quote-age is measured against the same moment rather than drifting
    // second-to-second across a multi-sport fetch.
    const evaluatedAt = new Date();
    for (const [label, keys] of Object.entries(SPORT_KEYS)) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        const picks = await fetchSportOdds(label, key, snapshotRows, evaluatedAt, shadowRows);
        allPicks = allPicks.concat(picks);
      }
    }

    // game_date is computed in Eastern, so "today" must be too.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // The parlay is locked at the first run of the day. Later refresh runs
    // carry that selection forward rather than reshuffling it — some of the
    // morning's legs may already be underway, and swapping them would
    // invalidate a bundle the customer has already seen (and possibly bet).
    const { data: existingParlay } = await supabase
      .from('daily_picks')
      .select('sport,away_team,home_team')
      .eq('game_date', today)
      .eq('is_parlay_pick', true);

    if (existingParlay && existingParlay.length) {
      const locked = new Set(existingParlay.map(p => `${p.sport}|${p.away_team}|${p.home_team}`));
      allPicks.forEach(p => {
        if (locked.has(`${p.sport}|${p.away_team}|${p.home_team}`)) p.is_parlay_pick = true;
      });
    } else {
      const todaysPicks = allPicks.filter(p => p.game_date === today);
      todaysPicks.sort((a, b) => (b.parlay_confidence || 0) - (a.parlay_confidence || 0));
      todaysPicks.slice(0, 3).forEach(p => { p.is_parlay_pick = true; });
    }

    if (allPicks.length === 0) {
      await sendAlert('fetch-picks returned zero games', 'Check Odds API quota/keys.');
      return res.status(200).json({ inserted: 0, note: 'No games returned — check quota/sport keys.' });
    }

    // Pull the candidate data out before upsert — daily_picks has no such
    // column, and PostgREST rejects unknown keys. Keyed by natural key so
    // it can be re-attached to the correct row once we have real pick ids.
    // Compare as actual timestamps, not raw strings — Postgres returns
    // "2026-09-16 02:00:00+00" while the odds feed gives us
    // "2026-09-16T02:00:00Z". Those never match character-for-character,
    // which silently broke every candidate lookup below.
    const keyOf = p => `${p.sport}|${p.away_team}|${p.home_team}|${new Date(p.commence_time).getTime()}`;
    const candidatesByKey = {};
    allPicks.forEach(p => {
      candidatesByKey[keyOf(p)] = p._candidateRecords;
      delete p._candidateRecords;
    });

    const { data: upsertedPicks, error } = await supabase
      .from('daily_picks')
      .upsert(allPicks, { onConflict: 'sport,away_team,home_team,commence_time' })
      .select('id,sport,away_team,home_team,commence_time');
    if (error) {
      console.error(error);
      return res.status(500).json({ error: 'Insert failed', detail: error.message });
    }

    // Replace this run's candidate rows for each pick rather than
    // accumulating duplicates across daily re-fetches of the same game.
    const pickIds = (upsertedPicks || []).map(p => p.id);
    if (pickIds.length) {
      await supabase.from('pick_candidates').delete().in('pick_id', pickIds);
    }
    const candidateRows = [];
    for (const p of upsertedPicks || []) {
      const records = candidatesByKey[keyOf(p)];
      if (!records) continue;
      for (const rec of records) candidateRows.push({ ...rec, pick_id: p.id });
    }
    if (candidateRows.length) {
      const CHUNK = 500;
      for (let i = 0; i < candidateRows.length; i += CHUNK) {
        const { error: candErr } = await supabase.from('pick_candidates').insert(candidateRows.slice(i, i + CHUNK));
        if (candErr) console.error('Candidate insert failed:', candErr.message);
      }
    }

    const parlayPickCount = allPicks.filter(p => p.is_parlay_pick).length;
    // Real numbers only for the homepage "market status" widget — never
    // fabricate a timestamp or count. books_max is the highest number of
    // sportsbooks seen backing any single game's line, not a fixed total.
    const booksMax = allPicks.reduce((m, p) => Math.max(m, p.books_counted || 0), 0);
    const { data: logRow } = await supabase
      .from('fetch_log')
      .insert({ games_processed: allPicks.length, books_max: booksMax })
      .select('id')
      .single();

    // Preserve the raw multi-book quotes this run was built from — the
    // prerequisite for ever reproducing a past pick exactly. Chunked to
    // stay well under any single-request size limit.
    if (logRow?.id && snapshotRows.length) {
      const taggedRows = snapshotRows.map(r => ({ ...r, fetch_run_id: logRow.id }));
      const CHUNK = 500;
      for (let i = 0; i < taggedRows.length; i += CHUNK) {
        const chunk = taggedRows.slice(i, i + CHUNK);
        const { error: snapErr } = await supabase.from('market_snapshots').insert(chunk);
        if (snapErr) console.error('Snapshot insert failed:', snapErr.message);
      }
    }

    // Shadow research storage — pure insert, never delete-then-replace.
    // Each row is tied to this specific fetch_run_id, so the same
    // candidate observed again in a future run creates a NEW row rather
    // than overwriting this one. ignoreDuplicates guards only against a
    // genuine accidental duplicate within this one run — it does not
    // and cannot suppress legitimate future observations, since those
    // carry a different fetch_run_id and are unaffected by this constraint.
    if (logRow?.id && shadowRows.length) {
      const taggedShadowRows = shadowRows.map(r => ({ ...r, fetch_run_id: logRow.id }));
      const CHUNK = 500;
      for (let i = 0; i < taggedShadowRows.length; i += CHUNK) {
        const chunk = taggedShadowRows.slice(i, i + CHUNK);
        const { error: shadowErr } = await supabase
          .from('shadow_candidates')
          .upsert(chunk, {
            onConflict: 'fetch_run_id,sport,away_team,home_team,commence_time,market_type,selection,point',
            ignoreDuplicates: true,
          });
        if (shadowErr) console.error('Shadow insert failed:', shadowErr.message);
      }
    }

    res.status(200).json({ inserted: allPicks.length, parlayPicks: parlayPickCount, snapshotRows: snapshotRows.length, shadowRows: shadowRows.length });
  } catch (err) {
    console.error(err);
    await sendAlert('fetch-picks cron failed', err.message || String(err));
    return res.status(500).json({ error: 'Internal error' });
  }
}
