import type { InValue, Row } from '@libsql/client';
import { getDb, now, uuid } from '../shared/db.js';
import type { Candidate, CandidateStatus, SourcePlatform, Theme } from '../shared/repositories.js';

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

export interface ClaimOptions {
  niche: string;
  dailyPickOnly: boolean;
  dailyPickDate: string;
  minDurationSec: number;
  maxDurationSec: number;
  botId: string;
  botRunId: string;
}

export async function claimNextCandidate(opts: ClaimOptions): Promise<Candidate | null> {
  const db = getDb();
  const where: string[] = [`c.status = 'available'`];
  const args: InValue[] = [];

  if (opts.niche !== '*') {
    where.push('t.niche = ?');
    args.push(opts.niche);
  }
  if (opts.dailyPickOnly) {
    where.push('t.daily_pick_date = ?');
    args.push(opts.dailyPickDate);
  }
  where.push('(c.duration_seconds IS NULL OR c.duration_seconds >= ?)');
  args.push(opts.minDurationSec);
  where.push('(c.duration_seconds IS NULL OR c.duration_seconds <= ?)');
  args.push(opts.maxDurationSec);

  const selectSql = `SELECT c.* FROM candidates c
                     JOIN themes t ON t.id = c.theme_id
                     WHERE ${where.join(' AND ')}
                     ORDER BY c.created_at ASC
                     LIMIT 1`;

  const tx = await db.transaction('write');
  try {
    const sel = await tx.execute({ sql: selectSql, args });
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
      args: [uuid(), candidate.id, opts.botId, opts.botRunId, now()],
    });
    await tx.commit();
    return { ...candidate, status: 'consumed' };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function releaseClaim(candidateId: string): Promise<boolean> {
  const db = getDb();
  const res = await db.execute({
    sql: `UPDATE candidates SET status = 'available'
          WHERE id = ? AND status = 'consumed'`,
    args: [candidateId],
  });
  return res.rowsAffected === 1;
}

export async function getThemeById(themeId: string): Promise<Theme | null> {
  const db = getDb();
  const res = await db.execute({
    sql: 'SELECT * FROM themes WHERE id = ?',
    args: [themeId],
  });
  if (res.rows.length === 0) return null;
  return rowToTheme(res.rows[0]);
}

export async function listCandidatesByThemeId(themeId: string): Promise<Candidate[]> {
  const db = getDb();
  const res = await db.execute({
    sql: 'SELECT * FROM candidates WHERE theme_id = ? ORDER BY created_at ASC',
    args: [themeId],
  });
  return res.rows.map(rowToCandidate);
}
