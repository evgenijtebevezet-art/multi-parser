# Multi-parser — design

**Date:** 2026-05-31
**Status:** Draft, awaiting user review
**Repo to be renamed:** `evgenijtebevezet-art/china-content-bank` → `multi-parser`
**Stack:** TypeScript (Node 22), Turso (libSQL), GitHub Actions, Google Drive, yt-dlp, Gemini / Qwen / Groq LLMs

## 1. Goal

Build a domain-agnostic video parser that feeds three downstream consumer bots:
- `tech-shorts-bot` — China robotics / EV / megaprojects (existing, lives in `Auto-Shorts-Farm` repo)
- `price-bot` — price comparison RU vs China on consumer products (existing, `wabaoai-price-bot`)
- `top-things-bot` — viral interesting items (new)

Each consumer pulls candidates from a shared Turso DB and Google Drive, filtered by `domain` column. Multi-parser does not know about its consumers — clean separation through DB schema.

## 2. Non-goals

- Direct push to consumers (webhook/dispatch) — pull-only model.
- Modal/RunPod compute migration — explicit user constraint that bots run only in GitHub Actions.
- TaoBao API integration — deferred until user provides API credentials.
- bgutil POT provider for YouTube — Phase 2 after core pipeline ships.
- Subs auto-refresh cron — manual PR-driven for now.
- Telegram alerts — manual `gh run view` for now.

## 3. Layers

```
multi-parser/
  src/
    domains/                         ← static TS configs (PR-revised)
      _registry.ts
      _types.ts
      tech_shorts.ts
      product_reviews.ts
      top_things.ts
    sources/
      _factory.ts
      _types.ts
      video/                         ← VideoSource: search + download
        bilibili.ts
        youtube.ts
      discovery/                     ← DiscoverySource: trending feed only
        reddit.ts
        hackernews.ts
        bilibili_popular.ts
        weibo_rsshub.ts
    scout/
      run.ts                         ← --domain X --dry-run
      discovery_orchestrator.ts
      llm_picker.ts
      prompts.ts                     ← shared system prompt builder
    banker/
      run.ts                         ← --domain X --max-themes N --dry-run
      candidate_search.ts
      metadata_prefilter.ts
      thumbnail_vision.ts
      full_vision.ts
    shared/
      db.ts
      env.ts
      logger.ts
      llmCascade.ts
      ytdlp.ts
      storage.ts                     ← StorageBackend interface
      repositories.ts                ← typed DB queries
  .github/workflows/
    scout.yml
    banker.yml
    init-db.yml
  docs/superpowers/specs/
    2026-05-31-multi-parser-design.md
```

## 4. Domain registry

The central abstraction. A `Domain` defines what content a consumer bot wants. It does NOT define HOW to get it — that's the job of sources.

### 4.1 Interface

```typescript
// src/domains/_types.ts
export type VideoSourceName = 'bilibili' | 'youtube';
export type DiscoverySourceName = 'reddit' | 'hackernews' | 'bilibili_popular' | 'weibo_rsshub';

export interface Domain {
  /** kebab-case slug — used as DB foreign key + CLI --domain value */
  name: string;
  /** Human-readable, for logs and Telegram messages */
  displayName: string;
  /** System prompt for scout LLM. Frozen per domain, revised via PRs. */
  scoutPrompt: string;
  /** Where to search for actual videos */
  videoSources: VideoSourceName[];
  /** Where to read trending signals from */
  discoverySources: DiscoverySourceName[];
  /** Allowed niche values, validated against scout LLM output */
  niches: readonly string[];
  /** Per-domain banker tuning */
  banker: {
    minQuality: number;        // vision quality_score threshold (default 4)
    minAction: number;         // vision action_density threshold (default 4)
    maxDurationSec: number;
    minViewCount: number;
  };
}
```

### 4.2 Three concrete domains

#### `tech_shorts`
- displayName: "China Tech Insider"
- Niches: humanoid_robots, chinese_ev, drones_shows, mega_projects, factory_tours, flying_vehicles, wow_tech
- Banker: minQuality=4, minAction=4, maxDurationSec=300, minViewCount=5000
- Scout prompt is the autoshorts prompt ported verbatim, see [[autoshorts-ai-prompts]].

#### `product_reviews`
- displayName: "Product Reviews CN→RU"
- Niches: kitchen_gadgets, home_appliances, smart_home, everyday_tools, personal_care, outdoor_gear, pet_products, unboxings
- Banker: minQuality=4, minAction=3 (talking-head product reviews are static), maxDurationSec=180, minViewCount=1000
- Scout prompt biased towards items available BOTH in TaoBao/AliExpress AND in Russia (Wildberries/Ozon).

#### `top_things`
- displayName: "Top интересных вещей"
- Niches: inventions, oddly_satisfying, lifehacks, wow_moments, gadget_demos
- Banker: minQuality=5, minAction=5 (need viral-grade content), maxDurationSec=120, minViewCount=10000
- Scout prompt focused on WOW factor and novelty.

### 4.3 Registry helper

```typescript
// src/domains/_registry.ts
export const DOMAINS = [TECH_SHORTS, PRODUCT_REVIEWS, TOP_THINGS] as const;

export function getDomain(name: string): Domain {
  const d = DOMAINS.find(x => x.name === name);
  if (!d) throw new Error(`unknown domain: ${name}. Valid: ${DOMAINS.map(d => d.name).join(', ')}`);
  return d;
}
```

## 5. Sources layer

### 5.1 Two interfaces, not one

```typescript
// src/sources/_types.ts
export interface VideoCandidate {
  source_platform: 'bilibili' | 'youtube';
  source_url: string;
  source_video_id: string;
  title: string;
  duration_seconds: number;
  view_count: number;
  upload_date: string;       // YYYYMMDD
  uploader: string;
  like_count?: number;
  comment_count?: number;
  thumbnail_url?: string;
}

export interface TrendingSignal {
  source: string;
  title: string;
  url?: string;
  score: number;             // 0-1 normalized within source
  age_hours: number;
  meta: Record<string, unknown>;
}

export interface VideoSource {
  readonly name: string;
  searchByQuery(query: string, opts: { maxResults: number }): Promise<VideoCandidate[]>;
  downloadVideo(url: string, outPath: string): Promise<{ path: string; sha256: string; sizeBytes: number }>;
}

export interface DiscoverySource {
  readonly name: string;
  fetchTrending(opts: { seeds: string[]; mode?: 'hot' | 'top' | 'rising'; limitPerSeed?: number; totalLimit?: number }): Promise<TrendingSignal[]>;
}
```

### 5.2 VideoSource implementations

- **`bilibili.ts`** — yt-dlp `bilisearch:` for search, yt-dlp for download. Both wired with `--cookies $BILI_COOKIES_FILE` and `Referer`/`Origin`/`Accept-Language` headers (already shipped in PR #1).
- **`youtube.ts`** — yt-dlp `ytsearch:` and download. Optional `--cookies $YT_COOKIES_FILE` and bgutil POT extractor args when `YTDLP_POT_PROVIDER_URL` is set (Phase 2).

### 5.3 DiscoverySource implementations

- **`reddit.ts`** — `reddit.com/r/{sub}/{mode}.json?limit=N` per seed. NSFW/stickied/removed/crossposts filtered. Min-score gate per mode (hot=100, top=500, rising=25). 15s timeout via AbortController. UA: `multi-parser:0.1 (by /u/evgenijtebevezet-art)`.
- **`hackernews.ts`** — `hn.algolia.com/api/v1/search?tags=front_page` with optional `query=` from seeds. Filter `points >= 100`.
- **`bilibili_popular.ts`** — `api.bilibili.com/x/web-interface/popular?ps=30&pn=1`. Public, no cookies needed. Filter by topic keywords from seeds.
- **`weibo_rsshub.ts`** — `rsshub.app/weibo/keyword/{kw}` per seed with `rsshub.rssforever.com` fallback. Parse XML via `fast-xml-parser`. Filter posts that contain video media.

### 5.4 Source properties

- Stateless, no globals.
- Errors caught → logged → empty array returned (one bad source must not fail the run).
- 15s default per-request timeout, `AbortController`.
- Env-gated via `<NAME>_ENABLED=false` kill switches.
- Sources are domain-agnostic: same source can serve any domain via different `seeds`.

## 6. Scout pipeline

### 6.1 Flow

```
scout/run.ts(domain)
  1. gatherDiscoverySignals(domain) → parallel Promise.allSettled across domain.discoverySources
       reads seeds from DB: subreddits + keyword_bank WHERE domain = ?
  2. pickThemesWithLlm(domain, signals)
       buildPrompt(domain.scoutPrompt + JSON-stringified signals + JSON schema)
       callLlmCascade(CASCADE_SCOUT, { tools: ['google_search'], responseFormat: 'json' })
       parse with Zod schema → Theme[]
  3. validateNiches(themes, domain.niches) → reject themes whose niche is not in domain.niches
  4. insertThemes(validThemes.map(t => ({ ...t, domain: domain.name })))
  5. upsertKeywords(domain.name, validThemes) → adds new keywords to keyword_bank
  6. writeArtifact + finishRun
```

### 6.2 LLM cascade

```typescript
CASCADE_SCOUT: [
  { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview' },  // primary
  { provider: 'gemini', model: 'gemini-3.5-flash' },               // fallback 1
  { provider: 'groq',   model: 'qwen/qwen3-32b' },                 // fallback 2
]
```

Gemini Pro intentionally excluded — 429s immediately on free tier (see [[gemini-api-free-tier]]).

### 6.3 Cron schedule

- `tech_shorts`: 05:17 UTC daily
- `product_reviews`: 11:17 UTC daily
- `top_things`: 17:17 UTC daily

## 7. Banker pipeline

### 7.1 Flow (two-stage vision)

```
banker/run.ts(domain, maxThemes)
  themes = getFreshThemes(domain, withinHours=48, limit=maxThemes)
  for theme in themes:
    1. queries = buildQueries(theme, domain)
         theme.cn_keywords + theme.title + top-3 keyword_bank WHERE domain AND niche
    2. rawCandidates = parallel searchByQuery across domain.videoSources
    3. prefiltered = rawCandidates filter (minViewCount, maxDurationSec, no duplicates)
    4. topByViews = prefiltered.sort(byViews).slice(0, 6)
    5. thumbApproved = Promise.all(topByViews.map(thumbnailVisionCheck))
         thumbnailVisionCheck(candidate, theme):
           thumb = http.get(candidate.thumbnail_url)
           prompt = `Rate this thumbnail. Return ONLY JSON: {topic_match: 0-10, is_slideshow: bool, has_real_action: bool}. Theme: "${theme.title}"`
           result = callLlmCascade(CASCADE_VISION_THUMB, { image: thumb, responseFormat: 'json' })
           return result.topic_match >= 5 AND !result.is_slideshow
    6. for candidate in thumbApproved.slice(0, 3):
         try:
           // Stage A: partial download for full-vision (cheaper bandwidth)
           partialPath = videoSource.downloadVideo(candidate.url, outPath, { sections: '*0-30' })
           visionResult = fullVisionCheck(partialPath, theme)
             extract 5 frames via ffmpeg -ss N -frames:v 1
             callLlmCascade(CASCADE_VISION_FULL, { images: frames })
             return { quality_score, action_density, vozduhanstvo, category, passes }
           safeUnlink(partialPath)

           if visionResult.passes:
             // Stage B: full download for downstream consumers
             localPath = videoSource.downloadVideo(candidate.url, outPath)
             gdriveId = storage.upload(localPath, key)
             insertCandidate({ ..., quality_score, gdrive_file_id })

         except: log + continue
```

### 7.2 LLM cascades

```typescript
CASCADE_VISION_THUMB: [
  { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview' },
]

CASCADE_VISION_FULL: [
  { provider: 'nvidia', model: 'qwen/qwen3.5-397b-a17b' },          // primary
  { provider: 'nvidia', model: 'qwen/qwen2.5-vl-72b-instruct' },    // fallback 1
  { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview' },   // fallback 2 (Files API)
]
```

### 7.3 Cron schedule

- `tech_shorts`: 06:47 + 18:47 UTC
- `product_reviews`: 13:47 + 21:47 UTC
- `top_things`: 09:47 + 22:47 UTC (offset to spread load)

## 8. Storage

```typescript
export interface StorageBackend {
  upload(localPath: string, key: string): Promise<{ id: string; uri: string }>;
  download(uri: string, localPath: string): Promise<void>;
  delete(uri: string): Promise<void>;
}

class GDriveBackend implements StorageBackend { /* googleapis + service account JWT */ }
class R2Backend implements StorageBackend { /* aws-sdk-v3 for R2 */ }
class LocalFsBackend implements StorageBackend { /* dev only */ }

export function getStorage(): StorageBackend {
  if (process.env.R2_ACCOUNT_ID) return new R2Backend();
  if (process.env.GDRIVE_SA_JSON) return new GDriveBackend();
  return new LocalFsBackend();
}
```

GDrive key pattern: `multi-parser/{domain}/{niche}/{video_id}.mp4`. R2 ready for future migration but not deployed.

## 9. DB schema changes

### 9.1 Added columns

```sql
ALTER TABLE themes ADD COLUMN domain TEXT NOT NULL DEFAULT 'tech_shorts';
ALTER TABLE candidates ADD COLUMN domain TEXT NOT NULL DEFAULT 'tech_shorts';
CREATE INDEX themes_domain_fresh_idx ON themes(domain, created_at DESC);
CREATE INDEX candidates_domain_status_idx ON candidates(domain, status, created_at DESC);
```

### 9.2 New tables

```sql
CREATE TABLE subreddits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  subscriber_count INTEGER,
  last_validated_at TEXT,
  added_by TEXT DEFAULT 'seed',     -- seed | llm | manual
  notes TEXT,
  UNIQUE(domain, name)
);
CREATE INDEX subreddits_domain_idx ON subreddits(domain, active);

CREATE TABLE keyword_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  niche TEXT,
  keyword TEXT NOT NULL,
  language TEXT NOT NULL,            -- zh | en | ru
  score REAL DEFAULT 0.5,            -- search success rate
  last_used_at TEXT,
  use_count INTEGER DEFAULT 0,
  UNIQUE(domain, keyword, language)
);
CREATE INDEX keyword_bank_domain_score_idx ON keyword_bank(domain, score DESC);

CREATE TABLE discovery_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  source TEXT NOT NULL,
  signal_hash TEXT NOT NULL,
  title TEXT,
  url TEXT,
  score REAL,
  seen_at TEXT NOT NULL,
  UNIQUE(domain, source, signal_hash)
);
CREATE INDEX discovery_signals_seen_idx ON discovery_signals(domain, seen_at DESC);
-- TTL: scout/run.ts runs DELETE FROM discovery_signals WHERE seen_at < datetime('now', '-30 days')
-- at the end of every successful run, capping table size.
```

### 9.3 Seed migration

Bootstrap subreddits and keyword_bank with curated initial values per domain. Applied via `init-db.yml` workflow_dispatch on first deploy and on any schema migration.

## 10. CI workflows

### 10.1 `scout.yml`

- Per-domain cron triggers (3 cron lines).
- `workflow_dispatch` input `domain` (choice) + `dry_run` (boolean).
- Job conditional on cron match or dispatch input.
- Steps: checkout, setup-node, `npm ci`, run scout with secrets, upload `runs/**/scout/*.json` as artifacts.

### 10.2 `banker.yml`

- Per-domain cron triggers (6 cron lines: 2x per domain).
- `workflow_dispatch` inputs: `domain`, `max_themes`, `dry_run`.
- Steps: checkout, setup-node, setup-python, install yt-dlp + ffmpeg, materialize Bilibili cookies (from PR #1), `npm ci`, run banker, upload `runs/**/banker/*.json` + `data/videos/**` artifacts.

### 10.3 `init-db.yml`

- `workflow_dispatch` only.
- Applies `src/shared/schema.sql` + seed inserts to Turso.

## 11. Error handling

- **LLM cascade** — primary 429/timeout/server-error falls through to next model in cascade.
- **Source failure** — caught + logged + returns empty array. Run continues.
- **Download failure** — try/catch per candidate. Continue to next.
- **DB failure** — fatal. Run marked `error` in `runs` table.
- **Vision failure** — falls through cascade. If all vision models fail, candidate skipped (NOT inserted with NULL score).
- **GDrive failure** — **FATAL**. Run marked `error`. Rationale: downstream bots are pull-only and would silently see 0 new videos if upload fails but DB row inserted with `local_path` only. Better to fail the run loud than degrade silently.

## 12. Observability

- Structured JSON logs through `log(level, event, data)` helper.
- Event naming: `<stage>.<action>.<outcome>` (e.g. `banker.thumb_vision.passed`).
- `run_id` and `domain` injected via `setLogContext`.
- Each run writes summary artifact to `runs/<date>/<stage>/<run_id>.json`.
- `gh run view` is the primary debugging interface for now.

## 13. Acceptance criteria

The multi-parser is considered "production-ready" for handoff to tech-shorts work when:

1. `init-db.yml` successfully creates all new tables and indexes on Turso.
2. For each of the 3 domains, `scout.yml --dry-run` returns 5+ themes whose `niche` is valid for that domain.
3. For each of the 3 domains, `banker.yml --max-themes=1` inserts at least 1 candidate with `quality_score >= 4` into the DB and `gdrive_file_id IS NOT NULL`.
4. New CLI command `npm run validate:e2e -- --domain X` runs automatically per domain:
   - Picks one fresh candidate from DB.
   - Re-downloads from `gdrive_file_id` to a temp file.
   - Sends 5 frames to Qwen3.5-397B via NVIDIA NIM with relevance + quality prompt.
   - Sends same 5 frames to Gemini Flash-Lite Vision with the same prompt.
   - Asserts both return `quality >= 4 AND action >= 4 AND is_slideshow=false`.
   - Exits 0 on pass, non-zero on fail. Logs full vision responses for review.
   Claude runs this command per domain after banker E2E and reports.
5. Memory updated to reflect new state.
6. Spec, plan, and PRs ready for review.

## 14. Out of scope (Phase 2+)

- bgutil POT provider container for YouTube anti-bot.
- TaoBao API integration via RapidAPI or Apify.
- `subs_refresh.yml` cron for AI-driven subreddit list maintenance.
- Telegram alerts for failed runs.
- Vitest test suite (only test directory structure is created).
- R2 storage migration.

## 15. Implementation phases

To be expanded by writing-plans skill after this design is approved.

1. **Phase 0** — repo rename `china-content-bank` → `multi-parser` via `gh repo rename`. Update memory.
2. **Phase 1** — Domain registry + types + 3 domain configs.
3. **Phase 2** — Sources layer refactor (VideoSource + DiscoverySource interfaces, 2 + 4 implementations).
4. **Phase 3** — DB schema migration + seed inserts + `init-db.yml` update.
5. **Phase 4** — Scout pipeline (orchestrator + llm_picker + prompts).
6. **Phase 5** — Banker pipeline (candidate_search + metadata_prefilter + thumbnail_vision + full_vision).
7. **Phase 6** — Workflows (scout.yml + banker.yml + init-db.yml).
8. **Phase 7** — End-to-end validation (Claude runs each domain, validates via independent Vision API call).

## 16. Linked memories

- [[china-content-bank-project-status]] — current state of repo
- [[auto-shorts-farm-reference-repo]] — source patterns + bugs to avoid
- [[autoshorts-reuse-plan]] — prioritized port list
- [[autoshorts-ai-prompts]] — verbatim scout + Qwen Vision prompts
- [[video-scraping-2026]] — Bilibili 412 / YouTube anti-bot research
- [[gemini-api-free-tier]] — model availability constraints
- [[nvidia-nim-catalog]] — Qwen Vision endpoint
- [[multi-parser-tech-shorts-naming]] — rename + sequence + quality bar
