# china-content-bank

Shared content-parsing service that feeds China-niche content bots (wabaoai-price-bot and future siblings). Decouples video parsing (frequent) from video rendering (slow).

## Architecture

Three independent stages, each a self-contained cron entrypoint:

1. **Scout** (`pnpm scout`, cron ~6h) — Gemini-flash + `google_search` grounding finds 3-5 hot Chinese tech/EV/gadget themes → inserts into `themes` table.
2. **Banker** (`pnpm banker`, cron ~4h) — for each fresh theme: yt-dlp searches Bilibili/Douyin/YouTube → Gemini Vision pre-filter via `Part.from_uri` → top-K downloaded → stored locally (or GDrive) → inserted into `candidates` with embedding for dedup.
3. **Editor-in-Chief** (`pnpm editor`, daily) — picks 3 themes/day from the banker pool to surface for rendering.

Downstream bots call `reader.pickAvailableCandidate(niche, botId)` — returns one unused candidate atomically, marks it consumed.

## Storage

- **DB**: libsql (Turso in prod, local file in dev). Schema: `src/shared/schema.sql`.
- **Videos**: local-fs (`./data/videos/`) or Google Drive (if `GDRIVE_SA_JSON` set).
- **Embeddings**: 3072d `gemini-embedding-001` stored in `candidates.embedding` (`F32_BLOB`), libsql vector index for cosine-distance dedup.

## Model fallback cascades

All LLM calls use `callLlmCascade(CASCADE_*, opts)` — see `src/shared/llmFallback.ts`. Pro-tier Gemini deliberately excluded (free-tier 429s on first request).

## Run locally

```sh
cp .env.example .env  # fill in keys
pnpm install
pnpm init-db          # creates ./data/content-bank.db with schema
pnpm seed             # inserts one fallback theme
pnpm banker           # downloads ~1 candidate video
```

## Run in GitHub Actions

Workflows in `.github/workflows/` — see `cron-scout.yml`, `cron-banker.yml`, `cron-editor.yml`.

## CI-only constraint

Production execution happens only in GitHub Actions. The author's local IP is geo-blocked from Gemini API. Local dev runs through cascade fallbacks (Groq / NVIDIA) and yt-dlp-only paths.
