import { CASCADE_VIDEO_FILTER, callLlmCascade } from '../shared/llmFallback.js';
import { log } from '../shared/logger.js';
import type { Theme } from '../shared/repositories.js';
import { searchVideos, type SearchPlatform, type SearchResult } from '../shared/ytdlp.js';
import {
  FilterResponseSchema,
  filterPrompt,
  filterResponseJsonSchema,
  type FilterResponse,
} from './filterPrompt.js';

const MIN_DURATION_S = 15;
const MAX_DURATION_S = 900;
const MIN_VIEW_COUNT = 1000;
const MAX_QUERIES_PER_THEME = 4;
const SEARCH_PLATFORMS: SearchPlatform[] = ['bilibili', 'youtube'];
const SEARCH_MAX_RESULTS = 5;
// Evaluate top-by-views per platform so Bilibili candidates are never starved out
// by YouTube's higher view counts. Bilibili download works on CI (cookies+headers);
// YouTube download is blocked on datacenter IPs (bot-check), so keep fewer of it.
const EVAL_TOP_BILIBILI = 6;
const EVAL_TOP_YOUTUBE = 4;
const QUALITY_SCORE_MIN = 0.4;
// Return several ranked candidates (Bilibili first) so the banker has working
// fallbacks when a given download is blocked.
const TOP_AFTER_FILTER = 5;

export type RankedCandidate = SearchResult & {
  quality_score: number;
  watermark_flag: 0 | 1;
  filter_reason: string;
  language_cn: boolean;
};

export function buildQueries(theme: Theme): string[] {
  const queries: string[] = [];
  const push = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (queries.includes(trimmed)) return;
    if (queries.length >= MAX_QUERIES_PER_THEME) return;
    queries.push(trimmed);
  };
  for (const kw of theme.cn_keywords) push(kw);
  push(theme.title);
  return queries;
}

function dedupByVideoId(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = `${r.source_platform}:${r.source_video_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function passesPrefilter(r: SearchResult): boolean {
  // duration/view_count are frequently absent (0) from --flat-playlist search results
  // (notably Bilibili), so only reject when the value is KNOWN and out of range —
  // otherwise every Bilibili candidate is dropped before it can be ranked/downloaded.
  if (
    r.duration_seconds > 0 &&
    (r.duration_seconds < MIN_DURATION_S || r.duration_seconds > MAX_DURATION_S)
  ) {
    return false;
  }
  if (r.view_count > 0 && r.view_count < MIN_VIEW_COUNT) return false;
  return true;
}

async function visionFilter(candidate: SearchResult, theme: Theme): Promise<FilterResponse | null> {
  try {
    const result = await callLlmCascade(CASCADE_VIDEO_FILTER, {
      prompt: filterPrompt(theme),
      responseFormat: 'json',
      jsonSchema: filterResponseJsonSchema,
      videoUri: candidate.source_url,
      maxOutputTokens: 256,
    });
    let json: unknown = result.json;
    if (json === undefined && result.text) {
      try {
        json = JSON.parse(result.text);
      } catch {
        json = undefined;
      }
    }
    const parsed = FilterResponseSchema.safeParse(json);
    if (!parsed.success) {
      log('warn', 'banker.filter.invalid_json', {
        url: candidate.source_url,
        error: parsed.error.message.slice(0, 200),
      });
      return null;
    }
    return parsed.data;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('warn', 'banker.filter.failed', { url: candidate.source_url, error: msg.slice(0, 300) });
    return null;
  }
}

function heuristicScore(c: SearchResult, theme: Theme): FilterResponse {
  // The candidate already came back from a TARGETED keyword search for this theme,
  // so it is topically relevant by construction. Exact title-substring matching is
  // unreliable for Chinese titles (it over-rejected real Bilibili hits), so we no
  // longer hard-reject on it — we just bias quality toward keyword hits + popularity.
  let hits = 0;
  for (const kw of theme.cn_keywords) {
    if (kw && c.title.includes(kw)) hits++;
  }
  const titleHit = theme.title.length > 0 && c.title.includes(theme.title);
  const popularity = Math.min(1, Math.log10(Math.max(c.view_count, 10)) / 7);
  const relevanceBoost = hits > 0 || titleHit ? 0.1 : 0;
  const quality = Math.min(1, Math.max(0.45, popularity * 0.8 + 0.2 + relevanceBoost));
  return {
    relevant: true,
    quality_score: quality,
    has_watermark: false,
    language_cn: true,
    reason: hits > 0 || titleHit ? 'search-match+title' : 'search-match',
  };
}

export async function searchAcrossPlatforms(theme: Theme): Promise<RankedCandidate[]> {
  const queries = buildQueries(theme);
  if (queries.length === 0) {
    log('warn', 'banker.search.no_queries', { theme_id: theme.id });
    return [];
  }

  const all: SearchResult[] = [];
  for (const query of queries) {
    const settled = await Promise.allSettled(
      SEARCH_PLATFORMS.map((platform) =>
        searchVideos({ platform, query, maxResults: SEARCH_MAX_RESULTS }),
      ),
    );
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        all.push(...r.value);
      } else {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        log('warn', 'banker.search.failed', {
          platform: SEARCH_PLATFORMS[i],
          query,
          error: reason.slice(0, 300),
        });
      }
    }
  }

  const deduped = dedupByVideoId(all);
  const prefiltered = deduped.filter(passesPrefilter);
  log('info', 'banker.search.summary', {
    theme_id: theme.id,
    raw: all.length,
    deduped: deduped.length,
    after_prefilter: prefiltered.length,
  });

  const byViews = (platform: SearchResult['source_platform']): SearchResult[] =>
    prefiltered
      .filter((c) => c.source_platform === platform)
      .sort((a, b) => b.view_count - a.view_count);
  const topByViews = [
    ...byViews('bilibili').slice(0, EVAL_TOP_BILIBILI),
    ...byViews('youtube').slice(0, EVAL_TOP_YOUTUBE),
  ];

  const evaluated: RankedCandidate[] = [];
  for (const cand of topByViews) {
    let verdict: FilterResponse | null = null;
    if (cand.source_platform === 'youtube') {
      verdict = await visionFilter(cand, theme);
    }
    if (!verdict) {
      verdict = heuristicScore(cand, theme);
    }
    if (!verdict.relevant) {
      log('info', 'banker.filter.rejected', {
        url: cand.source_url,
        reason: verdict.reason,
        relevant: false,
      });
      continue;
    }
    if (verdict.quality_score < QUALITY_SCORE_MIN) {
      log('info', 'banker.filter.low_quality', {
        url: cand.source_url,
        score: verdict.quality_score,
        reason: verdict.reason,
      });
      continue;
    }
    evaluated.push({
      ...cand,
      quality_score: verdict.quality_score,
      watermark_flag: verdict.has_watermark ? 1 : 0,
      filter_reason: verdict.reason,
      language_cn: verdict.language_cn,
    });
  }

  // Bilibili first (its download succeeds on CI), then by quality. This stops the
  // banker from wasting all its attempts on YouTube URLs that 403 on datacenter IPs.
  evaluated.sort((a, b) => {
    const ap = a.source_platform === 'bilibili' ? 0 : 1;
    const bp = b.source_platform === 'bilibili' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return b.quality_score - a.quality_score;
  });
  return evaluated.slice(0, TOP_AFTER_FILTER);
}
