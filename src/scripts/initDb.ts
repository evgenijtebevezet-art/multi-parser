import { getDb, runSchema } from '../shared/db.js';

const TABLES = [
  'runs',
  'themes',
  'candidates',
  'consumptions',
  'whitelisted_channels',
  'settings',
];

async function main(): Promise<void> {
  console.log('[init-db] applying schema...');
  await runSchema();
  console.log('[init-db] schema applied');

  const db = getDb();
  for (const table of TABLES) {
    const res = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    const n = res.rows[0]?.n;
    console.log(`[init-db] ${table}: ${String(n)} rows`);
  }
}

main().catch((err) => {
  console.error('[init-db] failed:', err);
  process.exit(1);
});
