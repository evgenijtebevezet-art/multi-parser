import { access } from 'node:fs/promises';
import { log } from '../shared/logger.js';
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

  const videoExists = await fileExists(candidate.local_path);
  if (!videoExists) {
    log('warn', 'reader: local_path missing on disk', {
      candidate_id: candidate.id,
      local_path: candidate.local_path,
      gdrive_file_id: candidate.gdrive_file_id,
    });
  }

  return { candidate, theme, videoExists };
}

export async function releaseCandidate(
  candidateId: string,
  reason: ReleaseReason,
): Promise<void> {
  const updated = await releaseClaim(candidateId);
  log(updated ? 'info' : 'warn', 'reader: release candidate', {
    candidate_id: candidateId,
    reason,
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
