import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../shared/env.js';
import { log } from '../shared/logger.js';
import { getStorage } from '../shared/storage.js';
import { getDailyPicks } from '../shared/repositories.js';
import type { Candidate, Theme } from '../shared/repositories.js';
import {
  claimNextCandidate,
  getThemeById,
  listCandidatesByThemeId,
  releaseClaim,
} from './queries.js';

export type { Candidate, Theme } from '../shared/repositories.js';

export interface NextCandidateOptions {
  niche: string;
  botId: string;
  botRunId: string;
  preferDailyPick?: boolean;
  minDurationSec?: number;
  maxDurationSec?: number;
}

export interface NextCandidateResult {
  candidate: Candidate;
  theme: Theme;
  videoExists: boolean;
}

export type ReleaseReason = 'rejected' | 'failed_render' | 'manual';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fileExists(path: string | null): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function getNextCandidate(
  opts: NextCandidateOptions,
): Promise<NextCandidateResult | null> {
  const preferDailyPick = opts.preferDailyPick ?? true;
  const minDurationSec = opts.minDurationSec ?? 15;
  const maxDurationSec = opts.maxDurationSec ?? 900;
  const dailyPickDate = todayIsoDate();

  const baseClaim = {
    niche: opts.niche,
    minDurationSec,
    maxDurationSec,
    botId: opts.botId,
    botRunId: opts.botRunId,
    dailyPickDate,
  };

  let candidate: Candidate | null = null;
  if (preferDailyPick) {
    candidate = await claimNextCandidate({ ...baseClaim, dailyPickOnly: true });
  }
  if (!candidate) {
    candidate = await claimNextCandidate({ ...baseClaim, dailyPickOnly: false });
  }
  if (!candidate) return null;

  const theme = await getThemeById(candidate.theme_id);
  if (!theme) {
    log('error', 'reader: claimed candidate has no theme — releasing', {
      candidate_id: candidate.id,
      theme_id: candidate.theme_id,
    });
    await releaseClaim(candidate.id);
    return null;
  }

  // The banker ran on a different (ephemeral) machine, so candidate.local_path
  // rarely exists here. If the media was durably stored (gdrive_file_id set), pull
  // it down from storage so the consumer gets a usable local file. The storage key
  // mirrors what the banker uploaded: `${niche}/${platform}_${videoId}.mp4`.
  let localPath = candidate.local_path;
  let videoExists = await fileExists(localPath);
  if (!videoExists && candidate.gdrive_file_id) {
    const key = `${theme.niche || 'general'}/${candidate.source_platform}_${candidate.source_video_id}.mp4`;
    const dest = join(env.CONTENT_BANK_VIDEOS_DIR, key);
    try {
      await getStorage().downloadTo(key, dest);
      localPath = dest;
      videoExists = true;
      log('info', 'reader: media fetched from storage', { candidate_id: candidate.id, key, dest });
    } catch (e) {
      log('warn', 'reader: media fetch from storage failed', {
        candidate_id: candidate.id,
        key,
        gdrive_file_id: candidate.gdrive_file_id,
        error: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
    }
  }
  if (!videoExists) {
    log('warn', 'reader: media unavailable (no local file, no durable copy)', {
      candidate_id: candidate.id,
      local_path: candidate.local_path,
      gdrive_file_id: candidate.gdrive_file_id,
    });
  }

  return { candidate: { ...candidate, local_path: localPath }, theme, videoExists };
}

export async function releaseCandidate(
  candidateId: string,
  reason: ReleaseReason,
): Promise<void> {
  // 'rejected' means the consumer judged the content unusable — make it terminal so
  // it is never re-served. 'failed_render'/'manual' are transient: return it to the
  // pool ('available') so another bot/run can claim it.
  const terminal = reason === 'rejected';
  const updated = await releaseClaim(candidateId, terminal);
  log(updated ? 'info' : 'warn', 'reader: release candidate', {
    candidate_id: candidateId,
    reason,
    terminal,
    updated,
  });
}

export async function listDailyPicks(
  date?: string,
): Promise<{ theme: Theme; candidates: Candidate[] }[]> {
  const d = date ?? todayIsoDate();
  const themes = await getDailyPicks(d);
  const results: { theme: Theme; candidates: Candidate[] }[] = [];
  for (const theme of themes) {
    const candidates = await listCandidatesByThemeId(theme.id);
    results.push({ theme, candidates });
  }
  return results;
}
