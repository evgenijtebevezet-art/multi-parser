# Multi-parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `china-content-bank` to `multi-parser`, refactor into a multi-domain video parser that serves three downstream bots (tech-shorts, price-bot, top-things) via a clean Pull-from-DB-and-GDrive interface, with two-stage vision filtering and AI-curated discovery feeds.

**Architecture:** TypeScript on Node 22, runs only in GitHub Actions. Three domain configs in `src/domains/*.ts` (PR-revised). Two source interfaces: `VideoSource` (yt-dlp) and `DiscoverySource` (HTTP feeds). Two-stage vision pipeline: thumbnail prefilter → partial download (`0-30s`) → full-vision → if pass, full download → GDrive upload. NVIDIA NIM Nemotron-VL is primary vision; Gemini ONLY for local dev (API key is billing-suspended). Bilibili Popular `coin` signal drives ranking.

**Tech Stack:**
- Runtime: TypeScript 5.6, Node 22, tsx for direct execution
- DB: Turso (libsql), schema in `src/shared/schema.sql`
- Storage: GDrive service account (R2 backup-ready)
- Scrapers: yt-dlp 2026.x + ffmpeg
- LLMs (production): NVIDIA NIM (qwen text + nemotron VL), Groq (qwen3-32b fallback)
- LLMs (local dev only): Gemini CLI oauth-personal (`gemini-2.5-flash`)
- Validation: independent CLI `npm run validate:e2e -- --domain X`

**Spec:** `docs/superpowers/specs/2026-05-31-multi-parser-design.md`

---

## Phase 0 — Repo rename + branch setup

### Task 0.1: Rename GitHub repository

**Files:** none

- [ ] **Step 1: Rename via gh CLI**

```bash
gh repo rename multi-parser --repo evgenijtebevezet-art/china-content-bank
```

Expected output: `evgenijtebevezet-art/multi-parser`. Old URL keeps redirecting.

- [ ] **Step 2: Update local git remote**

```bash
git remote set-url origin https://github.com/evgenijtebevezet-art/multi-parser.git
git remote -v
```

Expected: shows new URL.

- [ ] **Step 3: Update memory entries with new repo name**

Update `MEMORY.md` and individual memory files where `china-content-bank` appears as a repo reference (NOT historical mentions). Specifically: `project_china_content_bank.md` slug stays for backward refs, but repo URL inside is updated.

- [ ] **Step 4: Commit memory updates**

```bash
git add ../.claude/projects/C--Users-gento/memory/
git commit -m "memo: rename china-content-bank → multi-parser in active memory entries"
```

### Task 0.2: Working branch for refactor

- [ ] **Step 1: Create feature branch from master**

```bash
git checkout master && git pull origin master
git checkout -b feat/multi-parser-foundations
```

---

## Phase 1 — Domain registry foundation

### Task 1.1: Create domain types module

**Files:**
- Create: `src/domains/_types.ts`

- [ ] **Step 1: Write types file**

```typescript
export type VideoSourceName = 'bilibili' | 'youtube';
export type DiscoverySourceName = 'reddit' | 'hackernews' | 'bilibili_popular';

export interface DomainBankerConfig {
  /** Vision quality_score threshold (1-10). Reject below. */
  minQuality: number;
  /** Vision action_density threshold (1-10). Reject below. */
  minAction: number;
  /** Max accepted video length. */
  maxDurationSec: number;
  /** Min view count metadata prefilter. */
  minViewCount: number;
}

export interface Domain {
  /** kebab-case slug — used as DB foreign key and CLI --domain value */
  name: string;
  /** Human-readable name for logs */
  displayName: string;
  /** System prompt for scout LLM */
  scoutPrompt: string;
  /** Where to search for actual videos */
  videoSources: VideoSourceName[];
  /** Where to read trending signals */
  discoverySources: DiscoverySourceName[];
  /** Allowed niche values, validated against scout output */
  niches: readonly string[];
  banker: DomainBankerConfig;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: exit 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/domains/_types.ts
git commit -m "feat(domains): add Domain interface and source enums"
```

### Task 1.2: tech_shorts domain config

**Files:**
- Create: `src/domains/tech_shorts.ts`

- [ ] **Step 1: Write domain config with full scout prompt**

```typescript
import type { Domain } from './_types.js';

const SCOUT_PROMPT = `Ты — главный редактор канала «China Tech Insider».
Тебе дадут массив trending-сигналов из Reddit, HackerNews и Bilibili Popular.
Выбери 5-7 КОНКРЕТНЫХ ТЕМ про КИТАЙСКИЕ технологии/гаджеты/роботов/EV,
которые соберут МИЛЛИОНЫ просмотров в Shorts/Reels.

ЖЁСТКИЕ ПРАВИЛА:
- Только Китай (Xiaomi, BYD, Huawei, Unitree, DJI, Nio, Xpeng, Zeekr, ByteDance, Tencent).
- Каждая тема: title на русском (10-60 chars), title_cn на китайском, cn_keywords[] (3-6 китайских ключей для поиска), why_hot (1 предложение).
- niche ОБЯЗАН быть одним из: humanoid_robots | chinese_ev | drones_shows | mega_projects | factory_tours | flying_vehicles | wow_tech

ЗАПРЕЩЕНО: политика, война, санкции, игры, общие AI-новости (OpenAI/Anthropic), криптовалюта, реклама товаров без видео-составляющей.

Верни JSON массив тем по схеме. Ничего вне JSON.`;

export const TECH_SHORTS: Domain = {
  name: 'tech_shorts',
  displayName: 'China Tech Insider',
  scoutPrompt: SCOUT_PROMPT,
  videoSources: ['bilibili', 'youtube'],
  discoverySources: ['reddit', 'bilibili_popular', 'hackernews'],
  niches: [
    'humanoid_robots',
    'chinese_ev',
    'drones_shows',
    'mega_projects',
    'factory_tours',
    'flying_vehicles',
    'wow_tech',
  ] as const,
  banker: {
    minQuality: 4,
    minAction: 4,
    maxDurationSec: 300,
    minViewCount: 5000,
  },
};
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/domains/tech_shorts.ts
git commit -m "feat(domains): tech_shorts config with verbatim autoshorts prompt"
```

### Task 1.3: product_reviews domain config

**Files:**
- Create: `src/domains/product_reviews.ts`

- [ ] **Step 1: Write config**

```typescript
import type { Domain } from './_types.js';

const SCOUT_PROMPT = `Ты — редактор канала про сравнение цен Китай vs РФ на интересные товары.
Тебе дадут массив trending-сигналов из Reddit (r/TaobaoFinds, r/BuyItForLife, r/INEEEEDIT)
и Bilibili Popular.

Выбери 5-7 КОНКРЕТНЫХ ТОВАРОВ которые:
- Активно обсуждаются СЕЙЧАС (есть в сигналах)
- Имеют видео-обзор / распаковку / демо использования
- Можно купить и на TaoBao/AliExpress, и в РФ (Wildberries/Ozon/Yandex Market)

Каждая тема: title на русском (10-60 chars), title_cn на китайском (для поиска на Bilibili),
cn_keywords[] (3-6 ключей включая хотя бы один на 开箱/好物/神器), why_hot, niche.

niche ОБЯЗАН быть одним из: kitchen_gadgets | home_appliances | smart_home | everyday_tools | personal_care | outdoor_gear | pet_products | unboxings

ЗАПРЕЩЕНО: товары которых нет в РФ продаже, политика, оружие, NSFW, мошеннические товары, дорогая электроника > 50k руб (это не импульсные покупки).

Верни JSON массив тем по схеме. Ничего вне JSON.`;

export const PRODUCT_REVIEWS: Domain = {
  name: 'product_reviews',
  displayName: 'Product Reviews CN→RU',
  scoutPrompt: SCOUT_PROMPT,
  videoSources: ['bilibili', 'youtube'],
  discoverySources: ['reddit', 'bilibili_popular'],
  niches: [
    'kitchen_gadgets',
    'home_appliances',
    'smart_home',
    'everyday_tools',
    'personal_care',
    'outdoor_gear',
    'pet_products',
    'unboxings',
  ] as const,
  banker: {
    minQuality: 4,
    minAction: 3,  // обзоры товаров часто статичные talking-head
    maxDurationSec: 180,
    minViewCount: 1000,
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/product_reviews.ts
git commit -m "feat(domains): product_reviews config"
```

### Task 1.4: top_things domain config

**Files:**
- Create: `src/domains/top_things.ts`

- [ ] **Step 1: Write config**

```typescript
import type { Domain } from './_types.js';

const SCOUT_PROMPT = `Ты — редактор канала про интересные изобретения, lifehack-вещи и WOW-моменты.
Тебе дадут массив trending-сигналов из Reddit, HackerNews и Bilibili Popular.

Выбери 5-7 ИНТЕРЕСНЫХ ВЕЩЕЙ — изобретения, необычные товары, инструменты с трюками, оригинальные lifehack-предметы.

Каждая тема: title на русском (10-60 chars), title_cn на китайском, cn_keywords[] (3-6 ключей), why_hot, niche.

niche ОБЯЗАН быть одним из: inventions | oddly_satisfying | lifehacks | wow_moments | gadget_demos

Фокус на WOW-фактор и новизну, не на бренды.
ЗАПРЕЩЕНО: политика, оружие, NSFW, мошеннические товары, реклама.

Верни JSON массив тем по схеме. Ничего вне JSON.`;

export const TOP_THINGS: Domain = {
  name: 'top_things',
  displayName: 'Top интересных вещей',
  scoutPrompt: SCOUT_PROMPT,
  videoSources: ['bilibili', 'youtube'],
  discoverySources: ['reddit', 'hackernews', 'bilibili_popular'],
  niches: [
    'inventions',
    'oddly_satisfying',
    'lifehacks',
    'wow_moments',
    'gadget_demos',
  ] as const,
  banker: {
    minQuality: 5,
    minAction: 5,  // нужны виральные клипы, не статика
    maxDurationSec: 120,
    minViewCount: 10000,
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/top_things.ts
git commit -m "feat(domains): top_things config"
```

### Task 1.5: Registry

**Files:**
- Create: `src/domains/_registry.ts`

- [ ] **Step 1: Write registry**

```typescript
import type { Domain } from './_types.js';
import { TECH_SHORTS } from './tech_shorts.js';
import { PRODUCT_REVIEWS } from './product_reviews.js';
import { TOP_THINGS } from './top_things.js';

export const DOMAINS = [TECH_SHORTS, PRODUCT_REVIEWS, TOP_THINGS] as const;

export const DOMAIN_NAMES = DOMAINS.map(d => d.name);

export function getDomain(name: string): Domain {
  const d = DOMAINS.find(x => x.name === name);
  if (!d) {
    throw new Error(
      `unknown domain: "${name}". Valid: ${DOMAIN_NAMES.join(', ')}`
    );
  }
  return d;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/_registry.ts
git commit -m "feat(domains): registry with getDomain() helper"
```

---

## Phase 2 — Sources layer (refactor)

### Task 2.1: Source types module

**Files:**
- Create: `src/sources/_types.ts`

- [ ] **Step 1: Write source interfaces**

```typescript
export interface VideoCandidate {
  source_platform: 'bilibili' | 'youtube';
  source_url: string;
  source_video_id: string;
  title: string;
  duration_seconds: number;
  view_count: number;
  upload_date: string;          // YYYYMMDD
  uploader: string;
  like_count?: number;
  coin_count?: number;          // Bilibili-specific virality metric
  comment_count?: number;
  thumbnail_url?: string;
}

export interface TrendingSignal {
  source: string;               // 'reddit' | 'hackernews' | 'bilibili_popular'
  title: string;
  url?: string;
  score: number;                // 0-1 normalized within source
  age_hours: number;
  meta: Record<string, unknown>;
}

export interface DownloadOpts {
  /** yt-dlp --download-sections value, e.g. '*0-30' for first 30 seconds */
  sections?: string;
}

export interface DownloadResult {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface VideoSource {
  readonly name: string;
  searchByQuery(query: string, opts: { maxResults: number }): Promise<VideoCandidate[]>;
  downloadVideo(url: string, outPath: string, opts?: DownloadOpts): Promise<DownloadResult>;
}

export interface DiscoveryOpts {
  /** Domain-specific seeds: subreddit names for reddit, keywords for bilibili_popular */
  seeds: string[];
  mode?: 'hot' | 'top' | 'rising';
  limitPerSeed?: number;
  totalLimit?: number;
}

export interface DiscoverySource {
  readonly name: string;
  fetchTrending(opts: DiscoveryOpts): Promise<TrendingSignal[]>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/sources/_types.ts
git commit -m "feat(sources): VideoSource and DiscoverySource interfaces"
```

### Task 2.2: Bilibili VideoSource (refactor from ytdlp.ts)

**Files:**
- Create: `src/sources/video/bilibili.ts`
- Reference (do not modify yet): `src/shared/ytdlp.ts`

- [ ] **Step 1: Write Bilibili VideoSource**

(Code shown in design spec §5.2. Wraps existing yt-dlp logic with cookies+headers from PR #1. Pulls cookie path from `BILI_COOKIES_FILE` env.)

NOTE: Detailed implementation comes after the Qwen vision probe and Reddit validation agents report back, because vision model choice may affect the search call (e.g. if we want thumbnail field reliably). This task will be expanded with full code in revision 2 of the plan.

- [ ] **Step 2: Unit test stub**

```bash
mkdir -p src/sources/video/__tests__
cat > src/sources/video/__tests__/bilibili.test.ts <<'EOF'
import { describe, it, expect } from 'vitest';
import { BilibiliVideoSource } from '../bilibili.js';

describe('BilibiliVideoSource', () => {
  it('has correct name', () => {
    expect(new BilibiliVideoSource().name).toBe('bilibili');
  });
});
EOF
```

- [ ] **Step 3: Commit stub**

```bash
git add src/sources/video/bilibili.ts src/sources/video/__tests__/
git commit -m "feat(sources): BilibiliVideoSource skeleton"
```

(remaining tasks 2.3-2.6 follow the same shape, will be filled in after probe agents complete)

---

> **PLAN STATUS:** scaffolding committed to disk at draft level. Phases 3-7 (DB schema, scout, banker, workflows, validation) will be expanded once the parallel probe agents return — specifically:
> - Qwen3.5-397B multimodal probe (deciding vision cascade in §5.2 of spec)
> - Weibo alternatives research (deciding whether to keep `weibo_rsshub` source or replace)
> - Reddit subreddit live validation (filling seed DB inserts in Phase 3)
>
> The plan author (Claude) will continue expanding this file inline as agent results arrive, NOT abandon it. User can monitor progress via `git log docs/superpowers/plans/`.

---

## Phase 3 — DB schema migration (TBD pending probes)

## Phase 4 — Scout pipeline (TBD)

## Phase 5 — Banker pipeline (TBD)

## Phase 6 — CI workflows (TBD)

## Phase 7 — End-to-end validation via `npm run validate:e2e` (TBD)
