import { log } from './logger.js';

/**
 * Custom Search grounding source.
 *
 * Queries Google's Programmable Search (Custom Search JSON API) for recent
 * China-tech results and returns title+snippet strings to feed the scout LLM as
 * real web grounding. This stands in for the built-in google_search tool on the
 * Groq/NVIDIA fallback path (those providers ignore the tool), so theme
 * selection stays grounded even when Gemini is unavailable.
 *
 * Fail-safe by design: missing config or any error yields an empty list, never
 * throws — a flaky search must not break the scout run.
 */

export interface SearchSignal {
  title: string;
  snippet: string;
  link: string;
  query: string;
}

const FETCH_TIMEOUT_MS = 15_000;

/** China-tech leaning defaults (CN + EN). Override via SEARCH_QUERIES ('|'-separated). */
const DEFAULT_QUERIES = [
  '中国 数码 新品 本周',
  'China EV new model launch',
  'Chinese smartphone release review',
  'Chinese humanoid robot news',
];

export function parseQueries(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_QUERIES;
  const list = raw
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : DEFAULT_QUERIES;
}

interface CseItem {
  title?: string;
  snippet?: string;
  link?: string;
}

async function runQuery(
  key: string,
  cx: string,
  q: string,
  num: number,
  dateRestrict: string,
): Promise<SearchSignal[]> {
  const url =
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}` +
    `&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=${num}` +
    `&dateRestrict=${dateRestrict}&safe=active`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) {
      log('warn', 'search.query_failed', { q, status: resp.status });
      return [];
    }
    const json = (await resp.json()) as { items?: CseItem[] };
    const out: SearchSignal[] = [];
    for (const it of json.items ?? []) {
      if (!it.title) continue;
      out.push({
        title: it.title,
        snippet: (it.snippet ?? '').replace(/\s+/g, ' ').trim(),
        link: it.link ?? '',
        query: q,
      });
    }
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('warn', 'search.query_error', { q, error: msg.slice(0, 200) });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSearchGrounding(opts?: {
  queries?: string[];
  perQuery?: number;
  dateRestrict?: string;
  totalLimit?: number;
}): Promise<SearchSignal[]> {
  const key = process.env.SEARCH_API_KEY?.trim();
  const cx = process.env.SEARCH_CX?.trim();
  if (!key || !cx) {
    log('info', 'search.disabled', { reason: 'SEARCH_API_KEY/SEARCH_CX not set' });
    return [];
  }
  const queries = opts?.queries ?? parseQueries(process.env.SEARCH_QUERIES);
  const perQuery = opts?.perQuery ?? 5;
  const dateRestrict = opts?.dateRestrict ?? 'd14';
  const totalLimit = opts?.totalLimit ?? 24;

  const settled = await Promise.allSettled(
    queries.map((q) => runQuery(key, cx, q, perQuery, dateRestrict)),
  );
  const all: SearchSignal[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }
  const top = all.slice(0, totalLimit);
  log('info', 'search.grounding', {
    queries: queries.length,
    collected: all.length,
    returned: top.length,
  });
  return top;
}
