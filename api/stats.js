import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  // Only count picks a bettor would realistically take. Heavy favorites
  // (worse than -200) were featured before the odds cap shipped and would
  // otherwise inflate the published win rate.
  const MAX_STRAIGHT_ODDS = -200;
  const { data: rows, error } = await supabase
    .from('daily_picks')
    .select('game_date, correct, odds')
    .eq('graded', true)
    .or(`odds.is.null,odds.gt.${MAX_STRAIGHT_ODDS}`)
    .order('game_date', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const { data: parlayRows, error: parlayError } = await supabase
    .from('daily_picks')
    .select('game_date, graded, parlay_correct')
    .eq('is_parlay_pick', true)
    .order('game_date', { ascending: false });

  if (parlayError) {
    return res.status(500).json({ error: parlayError.message });
  }

  // Flat 1-unit stake per pick. Win rate alone doesn't show whether picks
  // are profitable — a high hit rate on heavy favorites can still lose money.
  function unitProfit(row) {
    if (row.odds == null) return 0;
    if (!row.correct) return -1;
    return row.odds > 0 ? row.odds / 100 : 100 / -row.odds;
  }

  const byDate = {};
  for (const row of rows) {
    const date = row.game_date;
    if (!byDate[date]) byDate[date] = { hits: 0, misses: 0, profit: 0, staked: 0 };
    if (row.correct) byDate[date].hits++;
    else byDate[date].misses++;
    if (row.odds != null) {
      byDate[date].profit += unitProfit(row);
      byDate[date].staked += 1;
    }
  }

  const parlayByDate = {};
  for (const row of parlayRows) {
    const date = row.game_date;
    if (!parlayByDate[date]) parlayByDate[date] = [];
    parlayByDate[date].push(row);
  }

  function parlayResultForDate(date) {
    const legs = parlayByDate[date];
    if (!legs || legs.length === 0) return null;
    const allGraded = legs.every(l => l.graded);
    if (!allGraded) return 'pending';
    const allHit = legs.every(l => l.parlay_correct === true);
    return allHit ? 'hit' : 'loss';
  }

  const allDates = new Set([...Object.keys(byDate), ...Object.keys(parlayByDate)]);

  const summary = Array.from(allDates).sort((a, b) => b.localeCompare(a)).map((date) => {
    const counts = byDate[date] || { hits: 0, misses: 0, profit: 0, staked: 0 };
    const total = counts.hits + counts.misses;
    return {
      date,
      hits: counts.hits,
      misses: counts.misses,
      total,
      winRate: total > 0 ? ((counts.hits / total) * 100).toFixed(1) : null,
      roi: counts.staked > 0 ? ((counts.profit / counts.staked) * 100).toFixed(1) : null,
      parlayResult: parlayResultForDate(date),
    };
  });

  res.status(200).json(summary);
}
