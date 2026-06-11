# multi-parser (repo: china-content-bank)

Multi-niche content **producer**: discovers hot themes, banks source video, and exposes a
content bank that downstream bots (tech-shorts-bot, wabaoai-price-bot) consume.
Runs only in GitHub Actions.

## Stack
- TypeScript (ESM, Node ≥20), executed via `tsx`.
- libsql / Turso (`@libsql/client`) — content-bank DB.
- Gemini (`@google/genai`) — theme scouting + scoring.
- Google Drive (`googleapis`) — media storage backend.
- zod (config/validation), dotenv.
- Package manager: **pnpm locally, but CI uses npm** (pnpm v11 ignored-builds blocker —
  see commit f80d746). Keep behaviour identical across both.

## Commands
- `npm run typecheck`  — `tsc --noEmit`. There is no separate test runner; **typecheck is the gate**.
- `npm run init-db`    — create schema (src/scripts/initDb.ts).
- `npm run scout`      — discover themes (Gemini + search).
- `npm run banker`     — download candidates (yt-dlp; Bilibili/Douyin).
- `npm run seed` / `npm run reader:demo` — seed a theme / reader demo.

## Architecture
- `src/scout/`   — theme discovery + source policy (Gemini).
- `src/banker/`  — candidate download + storage (yt-dlp + GDrive).
- `src/reader/`  — content-bank read API for consumers.
- `src/scripts/` — ops scripts (initDb, seedTheme, readerDemo, mintDriveToken).
- `src/shared/`  — schema.sql (runs / themes / ...), DB client, config.
- `.github/workflows/` — scout.yml (6h cron), banker.yml (4h cron), init-db.yml.

## Rules
- CI-only execution; local = edit + push.
- **Bilibili 412** is mitigated via cookies + headers (NOT a Wbi bug) — keep that path intact;
  reference branch `feat/bilibili-cookies-headers`.
- Secrets via GH Actions: `GEMINI_API_KEY`, `GDRIVE_SA_JSON`, GROQ / NVIDIA keys.
- Do NOT downgrade quality gates just to make CI pass.

## Naming
- Project name is **multi-parser**; the GitHub repo is already `multi-parser`
  (local dir still `china-content-bank`; GH redirects preserve history).
