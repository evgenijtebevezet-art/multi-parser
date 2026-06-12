-- china-content-bank schema (libsql / Turso compatible)

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('scout', 'banker', 'editor')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  log_artifact_path TEXT
);

CREATE INDEX IF NOT EXISTS runs_kind_started_idx ON runs(kind, started_at DESC);

CREATE TABLE IF NOT EXISTS themes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  cn_keywords TEXT NOT NULL,
  why_hot TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  niche TEXT NOT NULL DEFAULT 'general',
  daily_pick_date TEXT,
  created_at TEXT NOT NULL,
  scout_run_id INTEGER REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS themes_created_idx ON themes(created_at DESC);
CREATE INDEX IF NOT EXISTS themes_niche_idx ON themes(niche);
CREATE INDEX IF NOT EXISTS themes_daily_pick_idx ON themes(daily_pick_date);
CREATE UNIQUE INDEX IF NOT EXISTS themes_title_uidx ON themes(title);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  theme_id TEXT NOT NULL REFERENCES themes(id),
  source_platform TEXT NOT NULL CHECK (source_platform IN ('bilibili', 'douyin', 'xiaohongshu', 'youtube', 'reddit', 'weibo', 'instagram')),
  source_url TEXT NOT NULL,
  source_video_id TEXT NOT NULL,
  title_original TEXT NOT NULL,
  title_translated_ru TEXT,
  duration_seconds INTEGER,
  view_count INTEGER,
  upload_date TEXT,
  local_path TEXT,
  gdrive_file_id TEXT,
  sha256 TEXT,
  embedding F32_BLOB(3072),
  quality_score REAL CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
  watermark_flag INTEGER NOT NULL DEFAULT 0 CHECK (watermark_flag IN (0, 1)),
  license_note TEXT,
  banker_run_id INTEGER REFERENCES runs(id),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'consumed', 'rejected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS candidates_platform_video_uidx ON candidates(source_platform, source_video_id);
CREATE INDEX IF NOT EXISTS candidates_theme_idx ON candidates(theme_id);
CREATE INDEX IF NOT EXISTS candidates_status_idx ON candidates(status);
CREATE INDEX IF NOT EXISTS candidates_sha256_idx ON candidates(sha256);
CREATE INDEX IF NOT EXISTS candidates_embedding_idx ON candidates(libsql_vector_idx(embedding));

CREATE TABLE IF NOT EXISTS consumptions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  bot_id TEXT NOT NULL,
  bot_run_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS consumptions_candidate_idx ON consumptions(candidate_id);
CREATE INDEX IF NOT EXISTS consumptions_bot_idx ON consumptions(bot_id, consumed_at DESC);

CREATE TABLE IF NOT EXISTS whitelisted_channels (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('bilibili', 'douyin', 'xiaohongshu', 'youtube')),
  channel_id TEXT NOT NULL,
  channel_name_cn TEXT,
  niche TEXT NOT NULL DEFAULT 'general',
  priority_weight REAL NOT NULL DEFAULT 1.0
);

CREATE UNIQUE INDEX IF NOT EXISTS whitelisted_channels_uidx ON whitelisted_channels(platform, channel_id);
CREATE INDEX IF NOT EXISTS whitelisted_channels_niche_idx ON whitelisted_channels(niche);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
