import { getDb, now, uuid } from '../shared/db.js';

const FALLBACK_THEME = {
  title: '小米 SU7 Ultra тесты 2026',
  cn_keywords: ['小米SU7 Ultra', '小米汽车 测评', '小米SU7 加速'],
  niche: 'ev',
  sources: [] as string[],
  why_hot:
    'fallback seed for offline dev — Xiaomi SU7 Ultra is current China EV halo product',
};

async function main(): Promise<void> {
  const db = getDb();
  const existing = await db.execute({
    sql: 'SELECT id FROM themes WHERE title = ? LIMIT 1',
    args: [FALLBACK_THEME.title],
  });
  if (existing.rows.length > 0) {
    console.log(`[seed] theme already exists (id=${String(existing.rows[0].id)}); skipping`);
    return;
  }
  const id = uuid();
  await db.execute({
    sql: `INSERT INTO themes
          (id, title, cn_keywords, why_hot, sources, niche, created_at, scout_run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    args: [
      id,
      FALLBACK_THEME.title,
      JSON.stringify(FALLBACK_THEME.cn_keywords),
      FALLBACK_THEME.why_hot,
      JSON.stringify(FALLBACK_THEME.sources),
      FALLBACK_THEME.niche,
      now(),
    ],
  });
  console.log(`[seed] inserted fallback theme id=${id}`);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
