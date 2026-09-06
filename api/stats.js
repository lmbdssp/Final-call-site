import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  const { data: rows, error } = await supabase
    .from('daily_picks')
    .select('game_date, correct')
    .eq('graded', true)
    .order('game_date', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const byDate = {};
  for (const row of rows) {
    const date = row.game_date;
    if (!byDate[date]) byDate[date] = { hits: 0, misses: 0 };
    if (row.correct) byDate[date].hits++;
    else byDate[date].misses++;
  }

  const summary = Object.entries(byDate).map(([date, counts]) => ({
    date,
    hits: counts.hits,
    misses: counts.misses,
    total: counts.hits + counts.misses,
    winRate: ((counts.hits / (counts.hits + counts.misses)) * 100).toFixed(1),
  }));

  res.status(200).json(summary);
}
