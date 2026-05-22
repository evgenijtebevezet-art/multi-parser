import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { getDb, now, uuid } from '../shared/db.js';
import { insertScoutRun, finishRun, getFreshThemes, setDailyPicks } from '../shared/repositories.js';

async function main(): Promise<void> {
  const samplePath = resolve('data/videos/sample_bg.mp4');
  const stats = await stat(samplePath);
  console.log('[manual-seed] sample MP4:', samplePath, stats.size, 'bytes');

  const themes = await getFreshThemes(48);
  if (themes.length === 0) {
    throw new Error('no themes found — run `pnpm seed` first');
  }
  const theme = themes[0];
  console.log('[manual-seed] using theme:', theme.id, theme.title);

  const today = new Date().toISOString().slice(0, 10);
  await setDailyPicks([theme.id], today);
  console.log('[manual-seed] daily-pick set for', today);

  const runId = await insertScoutRun('banker');
  console.log('[manual-seed] banker run id:', runId);

  const db = getDb();
  const candId = uuid();
  const embedding = new Array(3072).fill(0).map(() => Math.random() * 0.001);
  const vectorLiteral = `[${embedding.join(',')}]`;

  await db.execute({
    sql: `INSERT INTO candidates
          (id, theme_id, source_platform, source_url, source_video_id,
           title_original, title_translated_ru, duration_seconds, view_count,
           upload_date, local_path, sha256, embedding,
           quality_score, watermark_flag, license_note, banker_run_id, created_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, vector(?), ?, ?, ?, ?, ?, 'available')`,
    args: [
      candId,
      theme.id,
      'youtube',
      'https://test-videos.co.uk/bigbuckbunny/mp4-h264',
      'sample_bg',
      '【大虾沉浸式试车】新一代小米SU7 MAX版',
      'Тест-драйв нового Xiaomi SU7 MAX от 大虾',
      10,
      1180584,
      '20260320',
      samplePath,
      'sample-placeholder-sha',
      vectorLiteral,
      0.85,
      0,
      'placeholder for end-to-end render test (Big Buck Bunny 360p)',
      runId,
      now(),
    ],
  });
  console.log('[manual-seed] candidate inserted id:', candId);

  await finishRun(runId, 'ok', 'manual-seed');
  console.log('[manual-seed] done');
}

main().catch((err) => {
  console.error('[manual-seed] failed:', err);
  process.exit(1);
});
