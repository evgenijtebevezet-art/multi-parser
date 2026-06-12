import type { InValue, Row } from '@libsql/client';
import { getDb, now, uuid } from './db.js';

export interface Theme {
  id: string;
  title: string;
  cn_keywords: string[];
  why_hot: string | null;
  sources: string[];
  niche: string;
  daily_pick_date: string | null;
  created_at: string;
  scout_run_id: number | null;
}

export interface ThemeInput {
  title: string;
  cn_keywords: string[];
  why_hot?: string | null;
  sources?: string[];
  niche?: string;
}

export type SourcePlatform =
  | 'bilibili'
  | 'douyin'
  | 'xiaohongshu'
  | 'youtube'
  | 'reddit'
  | 'weibo'
  | 'instagram';
export type CandidateStatus = 'available' | 'consumed' | 'rejected';

export interface Candidate {
  id: string;
  theme_id: string;
  source_platform: SourcePlatform;
  source_url: string;
  source_video_id: string;
  title_original: string;
  title_translated_ru: string | null;
  duration_seconds: number | null;
  view_count: number | null;
  upload_date: string | null;
  local_path: string | null;
  gdrive_file_id: string | null;
  sha256: string | null;
  quality_score: number | null;
  watermark_flag: 0 | 1;
  license_note: string | null;
  banker_run_id: number | null;
  created_at: string;
  status: CandidateStatus;
}

export interface CandidateInput {
  theme_id: string;
  source_platform: SourcePlatform;
  source_url: string;
  source_video_id: string;
  title_original: string;
  title_translated_ru?: string | null;
  duration_seconds?: number | null;
  view_count?: number | null;
  upload_date?: string | null;
  local_path?: string | null;
  gdrive_file_id?: string | null;
  sha256?: string | null;
  embedding: number[];
  quality_score?: number | null;
  watermark_flag?: 0 | 1;
  license_note?: string | null;
  banker_run_id: number;
}

export interface WhitelistedChannel {
  id: string;
  platform: SourcePlatform;
  channel_id: string;
  channel_name_cn: string | null;
  niche: string;
  priority_weight: number;
}

export type RunKind = 'scout' | 'banker' | 'editor';
export type RunStatus = 'ok' | 'error';
export type InsertCandidateResult = { inserted: true; id: string } | { inserted: false; reason: string };

const DUPLICATE_COSINE_THRESHOLD = 0.15;

function asString(v: unknown): string {
  if (typeof v !== 'string') throw new Error(`expected string, got ${typeof v}`);
  return v;
}

function asStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return asString(v);
}

function asNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  throw new Error(`expected number, got ${typeof v}`);
}

function asNumber(v: unknown): number {
  const n = asNumberOrNull(v);
  if (n === null) throw new Error('expected number, got null');
  return n;
}

function parseJsonArray(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  const s = asString(v);
  const parsed: unknown = JSON.parse(s);
  if (!Array.isArray(parsed)) throw new Error('expected JSON array');
  return parsed.map((x) => String(x));
}

function rowToTheme(row: Row): Theme {
  return {
    id: asString(row.id),
    title: asString(row.title),
    cn_keywords: parseJsonArray(row.cn_keywords),
    why_hot: asStringOrNull(row.why_hot),
    sources: parseJsonArray(row.sources),
    niche: asString(row.niche),
    daily_pick_date: asStringOrNull(row.daily_pick_date),
    created_at: asString(row.created_at),
    scout_run_id: asNumberOrNull(row.scout_run_id),
  };
}

function rowToCandidate(row: Row): Candidate {
  const watermark = asNumber(row.watermark_flag);
  return {
    id: asString(row.id),
    theme_id: asString(row.theme_id),
    source_platform: asString(row.source_platform) as SourcePlatform,
    source_url: asString(row.source_url),
    source_video_id: asString(row.source_video_id),
    title_original: asString(row.title_original),
    title_translated_ru: asStringOrNull(row.title_translated_ru),
    duration_seconds: asNumberOrNull(row.duration_seconds),
    view_count: asNumberOrNull(row.view_count),
    upload_date: asStringOrNull(row.upload_date),
    local_path: asStringOrNull(row.local_path),
    gdrive_file_id: asStringOrNull(row.gdrive_file_id),
    sha256: asStringOrNull(row.sha256),
    quality_score: asNumberOrNull(row.quality_score),
    watermark_flag: watermark === 1 ? 1 : 0,
    license_note: asStringOrNull(row.license_note),
    banker_run_id: asNumberOrNull(row.banker_run_id),
    created_at: asString(row.created_at),
    status: asString(row.status) as CandidateStatus,
  };
}

function rowToChannel(row: Row): WhitelistedChannel {
  return {
    id: asString(row.id),
    platform: asString(row.platform) as SourcePlatform,
    channel_id: asString(row.channel_id),
    channel_name_cn: asStringOrNull(row.channel_name_cn),
    niche: asString(row.niche),
    priority_weight: asNumber(row.priority_weight),
  };
}

function embeddingToVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export async function insertScoutRun(kind: RunKind): Promise<number> {
  const db = getDb();
  const result = await db.execute({
    sql: 'INSERT INTO runs (kind, started_at, status) VALUES (?, ?, ?)',
    args: [kind, now(), 'running'],
  });
  if (result.lastInsertRowid === undefined) {
    throw new Error('failed to insert run: no lastInsertRowid');
  }
  return Number(result.lastInsertRowid);
}

export async function finishRun(runId: number, status: RunStatus, logPath?: string): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: 'UPDATE runs SET finished_at = ?, status = ?, log_artifact_path = ? WHERE id = ?',
    args: [now(), status, logPath ?? null, runId],
  });
}

export async function insertThemes(themes: ThemeInput[], scoutRunId: number): Promise<string[]> {
  if (themes.length === 0) return [];
  const db = getDb();
  const createdAt = now();
  const genIds = themes.map(() => uuid());
  const stmts = themes.map((t, i) => ({
    sql: `INSERT OR IGNORE INTO themes
          (id, title, cn_keywords, why_hot, sources, niche, created_at, scout_run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      genIds[i],
      t.title,
      JSON.stringify(t.cn_keywords),
      t.why_hot ?? null,
      JSON.stringify(t.sources ?? []),
      t.niche ?? 'general',
      createdAt,
      scoutRunId,
    ] as InValue[],
  }));
  const results = await db.batch(stmts, 'write');
  // INSERT OR IGNORE skips titles that already exist (themes_title_uidx). Return
  // only the IDs of rows actually inserted — matching each statement's result by
  // index — so the caller's "themes_inserted" count and the returned IDs are
  // truthful (previously every generated UUID was returned, over-counting
  // re-discovered themes and yielding IDs that map to no row).
  const ids: string[] = [];
  results.forEach((res, i) => {
    if (res.rowsAffected > 0) ids.push(genIds[i]);
  });
  return ids;
}

export async function getFreshThemes(maxAgeHours = 48): Promise<Theme[]> {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
  const res = await db.execute({
    sql: 'SELECT * FROM themes WHERE created_at >= ? ORDER BY created_at DESC',
    args: [cutoff],
  });
  return res.rows.map(rowToTheme);
}

export async function insertCandidate(c: CandidateInput): Promise<InsertCandidateResult> {
  const db = getDb();
  const vectorLiteral = embeddingToVectorLiteral(c.embedding);

  const dupRes = await db.execute({
    sql: `SELECT id, vector_distance_cos(embedding, vector(?)) AS dist
          FROM candidates
          WHERE theme_id = ? AND status != 'rejected' AND embedding IS NOT NULL
          ORDER BY dist ASC
          LIMIT 1`,
    args: [vectorLiteral, c.theme_id],
  });
  if (dupRes.rows.length > 0) {
    const dist = asNumberOrNull(dupRes.rows[0].dist);
    if (dist !== null && dist < DUPLICATE_COSINE_THRESHOLD) {
      return { inserted: false, reason: 'duplicate' };
    }
  }

  const id = uuid();
  try {
    await db.execute({
      sql: `INSERT INTO candidates
            (id, theme_id, source_platform, source_url, source_video_id,
             title_original, title_translated_ru, duration_seconds, view_count,
             upload_date, local_path, gdrive_file_id, sha256, embedding,
             quality_score, watermark_flag, license_note, banker_run_id, created_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, vector(?), ?, ?, ?, ?, ?, 'available')`,
      args: [
        id,
        c.theme_id,
        c.source_platform,
        c.source_url,
        c.source_video_id,
        c.title_original,
        c.title_translated_ru ?? null,
        c.duration_seconds ?? null,
        c.view_count ?? null,
        c.upload_date ?? null,
        c.local_path ?? null,
        c.gdrive_file_id ?? null,
        c.sha256 ?? null,
        vectorLiteral,
        c.quality_score ?? null,
        c.watermark_flag ?? 0,
        c.license_note ?? null,
        c.banker_run_id,
        now(),
      ],
    });
    return { inserted: true, id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(msg)) {
      return { inserted: false, reason: 'unique_violation' };
    }
    throw err;
  }
}

export async function pickAvailableCandidate(
  niche: string,
  botId: string,
  botRunId: string,
): Promise<Candidate | null> {
  const db = getDb();
  const tx = await db.transaction('write');
  try {
    const sel = await tx.execute({
      sql: `SELECT c.* FROM candidates c
            JOIN themes t ON t.id = c.theme_id
            WHERE c.status = 'available' AND t.niche = ?
            ORDER BY c.quality_score DESC NULLS LAST, c.created_at ASC
            LIMIT 1`,
      args: [niche],
    });
    if (sel.rows.length === 0) {
      await tx.commit();
      return null;
    }
    const candidate = rowToCandidate(sel.rows[0]);
    const upd = await tx.execute({
      sql: `UPDATE candidates SET status = 'consumed'
            WHERE id = ? AND status = 'available'`,
      args: [candidate.id],
    });
    if (upd.rowsAffected !== 1) {
      await tx.rollback();
      return null;
    }
    await tx.execute({
      sql: `INSERT INTO consumptions (id, candidate_id, bot_id, bot_run_id, consumed_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [uuid(), candidate.id, botId, botRunId, now()],
    });
    await tx.commit();
    return { ...candidate, status: 'consumed' };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function getDailyPicks(date: string): Promise<Theme[]> {
  const db = getDb();
  const res = await db.execute({
    sql: 'SELECT * FROM themes WHERE daily_pick_date = ? ORDER BY created_at ASC',
    args: [date],
  });
  return res.rows.map(rowToTheme);
}

export async function setDailyPicks(themeIds: string[], date: string): Promise<void> {
  if (themeIds.length === 0) return;
  const db = getDb();
  const placeholders = themeIds.map(() => '?').join(',');
  await db.execute({
    sql: `UPDATE themes SET daily_pick_date = ? WHERE id IN (${placeholders})`,
    args: [date, ...themeIds],
  });
}

export async function getWhitelistedChannels(niche?: string): Promise<WhitelistedChannel[]> {
  const db = getDb();
  const res = niche
    ? await db.execute({
        sql: 'SELECT * FROM whitelisted_channels WHERE niche = ? ORDER BY priority_weight DESC',
        args: [niche],
      })
    : await db.execute('SELECT * FROM whitelisted_channels ORDER BY priority_weight DESC');
  return res.rows.map(rowToChannel);
}

export async function getSetting(key: string): Promise<string | null> {
  const db = getDb();
  const res = await db.execute({
    sql: 'SELECT value FROM settings WHERE key = ?',
    args: [key],
  });
  if (res.rows.length === 0) return null;
  return asStringOrNull(res.rows[0].value);
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [key, value, now()],
  });
}
