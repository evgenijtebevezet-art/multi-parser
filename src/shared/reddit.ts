import { log } from './logger.js';

/**
 * Reddit discovery source.
 *
 * Pulls trending post titles from a configurable set of subreddits via Reddit's
 * public JSON endpoint (no auth, no cookies — within the project's scraper rules).
 * These titles are fed to the scout LLM as real-world "what's hot" signals so theme
 * selection is grounded in actual trends rather than relying solely on the model's
 * google_search grounding (which is flaky on the Groq fallback path).
 *
 * Fail-safe by design: any error yields an empty list, never throws — a dead Reddit
 * must not break the scout run.
 */

export interface RedditSignal {
  subreddit: string;
  title: string;
  score: number;
  url: string;
  permalink: string;
  created_utc: number;
}

/** China-tech / gadget / robotics leaning defaults. Override via REDDIT_SUBREDDITS. */
const DEFAULT_SUBREDDITS = [
  'electricvehicles',
  'BYD',
  'Huawei',
  'Xiaomi',
  'gadgets',
  'robotics',
  'singularity',
  'Damnthatsinteresting',
];

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'multi-parser:0.1 (content scout; +https://github.com/evgenijtebevezet-art/multi-parser)';

interface RedditChild {
  data?: {
    title?: string;
    score?: number;
    over_18?: boolean;
    stickied?: boolean;
    pinned?: boolean;
    removed_by_category?: string | null;
    crosspost_parent?: string;
    permalink?: string;
    url?: string;
    created_utc?: number;
  };
}

export function parseSubreddits(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_SUBREDDITS;
  const list = raw
    .split(',')
    .map((s) => s.trim().replace(/^\/?r\//i, ''))
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : DEFAULT_SUBREDDITS;
}

async function fetchSubreddit(
  sub: string,
  mode: 'hot' | 'top',
  limit: number,
  minScore: number,
): Promise<RedditSignal[]> {
  const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/${mode}.json?limit=${limit}&t=week&raw_json=1`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: ac.signal });
    if (!resp.ok) {
      log('warn', 'reddit.fetch_failed', { sub, status: resp.status });
      return [];
    }
    const json = (await resp.json()) as { data?: { children?: RedditChild[] } };
    const children = json.data?.children ?? [];
    const out: RedditSignal[] = [];
    for (const c of children) {
      const d = c.data;
      if (!d?.title) continue;
      if (d.over_18 || d.stickied || d.pinned || d.crosspost_parent || d.removed_by_category) continue;
      if ((d.score ?? 0) < minScore) continue;
      out.push({
        subreddit: sub,
        title: d.title,
        score: d.score ?? 0,
        url: d.url ?? '',
        permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : '',
        created_utc: d.created_utc ?? 0,
      });
    }
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('warn', 'reddit.fetch_error', { sub, error: msg.slice(0, 200) });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchRedditTrending(opts?: {
  subreddits?: string[];
  mode?: 'hot' | 'top';
  perSubLimit?: number;
  minScore?: number;
  totalLimit?: number;
}): Promise<RedditSignal[]> {
  const subs = opts?.subreddits ?? parseSubreddits(process.env.REDDIT_SUBREDDITS);
  const mode = opts?.mode ?? 'hot';
  const perSubLimit = opts?.perSubLimit ?? 10;
  const minScore = opts?.minScore ?? 50;
  const totalLimit = opts?.totalLimit ?? 40;

  const settled = await Promise.allSettled(
    subs.map((s) => fetchSubreddit(s, mode, perSubLimit, minScore)),
  );
  const all: RedditSignal[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }
  all.sort((a, b) => b.score - a.score);
  const top = all.slice(0, totalLimit);
  log('info', 'reddit.trending', {
    subs: subs.length,
    mode,
    collected: all.length,
    returned: top.length,
  });
  return top;
}
