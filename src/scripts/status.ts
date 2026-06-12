import 'dotenv/config';
import { getDb } from '../shared/db.js';

type JsonRow = Record<string, unknown>;

async function query(sql: string): Promise<JsonRow[]> {
  const result = await getDb().execute(sql);
  return result.rows.map((row) => ({ ...row }));
}

async function main(): Promise<void> {
  const [
    candidatesByStatus,
    candidatesByPlatform,
    themes,
    latestRuns,
    nextAvailable,
  ] = await Promise.all([
    query(`SELECT status, COUNT(*) AS count
           FROM candidates
           GROUP BY status
           ORDER BY status`),
    query(`SELECT source_platform, status, COUNT(*) AS count
           FROM candidates
           GROUP BY source_platform, status
           ORDER BY source_platform, status`),
    query(`SELECT COUNT(*) AS count, MIN(created_at) AS oldest, MAX(created_at) AS newest
           FROM themes`),
    query(`SELECT kind, status, COUNT(*) AS count, MAX(started_at) AS latest
           FROM runs
           GROUP BY kind, status
           ORDER BY kind, status`),
    query(`SELECT c.id, c.source_platform, c.title_original, c.title_translated_ru,
                  c.local_path, c.gdrive_file_id, c.quality_score, c.created_at,
                  t.niche, t.title AS theme_title
           FROM candidates c
           JOIN themes t ON t.id = c.theme_id
           WHERE c.status = 'available'
           ORDER BY c.quality_score DESC NULLS LAST, c.created_at ASC
           LIMIT 10`),
  ]);

  const available = Number(candidatesByStatus.find((row) => row.status === 'available')?.count ?? 0);
  const consumed = Number(candidatesByStatus.find((row) => row.status === 'consumed')?.count ?? 0);
  const rejected = Number(candidatesByStatus.find((row) => row.status === 'rejected')?.count ?? 0);

  console.log(JSON.stringify({
    summary: {
      available,
      consumed,
      rejected,
      total: available + consumed + rejected,
    },
    candidatesByStatus,
    candidatesByPlatform,
    themes: themes[0] ?? null,
    latestRuns,
    nextAvailable,
  }, null, 2));
}

await main();
