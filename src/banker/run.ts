import 'dotenv/config';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { env } from '../shared/env.js';
import { CASCADE_TRANSLATOR, callLlmCascade, getEmbedding } from '../shared/llmFallback.js';
import { log, setLogContext } from '../shared/logger.js';
import {
  finishRun,
  getFreshThemes,
  insertCandidate,
  insertScoutRun,
  type Theme,
} from '../shared/repositories.js';
import { downloadVideo } from '../shared/ytdlp.js';
import { getStorage } from '../shared/storage.js';
import { searchAcrossPlatforms, type RankedCandidate } from './searchAndRank.js';

type CliArgs = {
  maxThemes: number;
  dryRun: boolean;
  themeId: string | null;
};

type ThemeSummary = {
  theme_id: string;
  title: string;
  niche: string;
  candidatesConsidered: number;
  inserted: number;
  skipped: number;
};

type RunSummary = {
  runId: number;
  themesProcessed: number;
  candidatesInserted: number;
  candidatesSkipped: number;
  errors: string[];
  themes: ThemeSummary[];
  dryRun: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { maxThemes: 5, dryRun: false, themeId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--max-themes') {
      const v = argv[++i];
      if (!v) throw new Error('--max-themes requires a value');
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --max-themes: ${v}`);
      out.maxThemes = Math.floor(n);
    } else if (a === '--theme-id') {
      const v = argv[++i];
      if (!v) throw new Error('--theme-id requires a value');
      out.themeId = v;
    }
  }
  return out;
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('warn', 'banker.unlink.failed', { path, error: msg.slice(0, 200) });
  }
}

async function translateTitle(title: string): Promise<string | null> {
  try {
    const r = await callLlmCascade(CASCADE_TRANSLATOR, {
      prompt: `Переведи на русский (1 строка, без кавычек): ${title}`,
      maxOutputTokens: 256,
    });
    const firstLine = r.text.trim().split(/\r?\n/)[0] ?? '';
    const cleaned = firstLine.replace(/^["'«]+|["'»]+$/g, '').trim();
    return cleaned ? cleaned : null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('warn', 'banker.translate.failed', {
      title: title.slice(0, 120),
      error: msg.slice(0, 300),
    });
    return null;
  }
}

async function processCandidate(
  theme: Theme,
  cand: RankedCandidate,
  runId: number,
  themeSummary: ThemeSummary,
  summary: RunSummary,
): Promise<void> {
  const niche = theme.niche || 'general';
  const fileName = `${cand.source_platform}_${cand.source_video_id}.mp4`;
  const localPath = join(env.CONTENT_BANK_VIDEOS_DIR, niche, fileName);

  try {
    await mkdir(dirname(localPath), { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('warn', 'banker.mkdir.failed', { localPath, error: msg.slice(0, 200) });
  }

  let downloaded: { path: string; sha256: string; sizeBytes: number };
  try {
    downloaded = await downloadVideo(cand.source_url, localPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('warn', 'banker.download.skip', { url: cand.source_url, error: msg.slice(0, 300) });
    themeSummary.skipped++;
    summary.candidatesSkipped++;
    return;
  }

  const titleRu = await translateTitle(cand.title);

  let embedding: Float32Array;
  try {
    const embText = [cand.title, theme.title, titleRu ?? ''].filter((s) => s.length > 0).join(' ');
    embedding = await getEmbedding(embText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('warn', 'banker.embed.failed_skip', { url: cand.source_url, error: msg.slice(0, 300) });
    await safeUnlink(downloaded.path);
    themeSummary.skipped++;
    summary.candidatesSkipped++;
    return;
  }

  // Push to durable storage (GDrive when configured, else a local-fs copy) so the
  // banked video survives beyond the ephemeral CI runner and consumers can fetch it
  // by gdrive_file_id. On a DURABLE backend (Drive) an upload failure is fatal for
  // this candidate: banking it with gdrive_file_id=null would hand consumers a row
  // pointing at a file that vanishes with the runner, so we skip it and record an
  // error (turns the run red instead of silently green). On local-fs (dev) we keep
  // going — there is no durable target to miss.
  const storage = getStorage();
  const storageKey = `${niche}/${fileName}`;
  let gdriveFileId: string | null = null;
  try {
    const up = await storage.upload(downloaded.path, storageKey);
    gdriveFileId = up.id;
    log('info', 'banker.storage.uploaded', { key: storageKey, id: up.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (storage.durable) {
      log('error', 'banker.storage.upload_failed', { key: storageKey, error: msg.slice(0, 200) });
      await safeUnlink(downloaded.path);
      themeSummary.skipped++;
      summary.candidatesSkipped++;
      summary.errors.push(`storage upload failed for ${storageKey}: ${msg.slice(0, 200)}`);
      return;
    }
    log('warn', 'banker.storage.upload_failed', { key: storageKey, error: msg.slice(0, 200) });
  }

  const result = await insertCandidate({
    theme_id: theme.id,
    source_platform: cand.source_platform,
    source_url: cand.source_url,
    source_video_id: cand.source_video_id,
    title_original: cand.title,
    title_translated_ru: titleRu,
    duration_seconds: cand.duration_seconds,
    view_count: cand.view_count,
    upload_date: cand.upload_date || null,
    local_path: downloaded.path,
    gdrive_file_id: gdriveFileId,
    sha256: downloaded.sha256,
    embedding: Array.from(embedding),
    quality_score: cand.quality_score,
    watermark_flag: cand.watermark_flag,
    license_note: null,
    banker_run_id: runId,
  });

  if (result.inserted) {
    themeSummary.inserted++;
    summary.candidatesInserted++;
    log('info', 'banker.candidate.inserted', {
      theme_id: theme.id,
      id: result.id,
      url: cand.source_url,
      quality_score: cand.quality_score,
      bytes: downloaded.sizeBytes,
    });
  } else {
    themeSummary.skipped++;
    summary.candidatesSkipped++;
    log('info', 'banker.candidate.skipped', {
      theme_id: theme.id,
      reason: result.reason,
      url: cand.source_url,
    });
    await safeUnlink(downloaded.path);
  }
}

async function processTheme(
  theme: Theme,
  runId: number,
  dryRun: boolean,
  summary: RunSummary,
): Promise<void> {
  const themeSummary: ThemeSummary = {
    theme_id: theme.id,
    title: theme.title,
    niche: theme.niche,
    candidatesConsidered: 0,
    inserted: 0,
    skipped: 0,
  };

  log('info', 'banker.theme.start', {
    theme_id: theme.id,
    niche: theme.niche,
    title: theme.title,
  });

  let ranked: RankedCandidate[];
  try {
    ranked = await searchAcrossPlatforms(theme);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', 'banker.theme.search_failed', { theme_id: theme.id, error: msg.slice(0, 300) });
    summary.errors.push(`theme=${theme.id} search: ${msg.slice(0, 200)}`);
    summary.themes.push(themeSummary);
    return;
  }

  themeSummary.candidatesConsidered = ranked.length;

  for (const cand of ranked) {
    if (dryRun) {
      log('info', 'banker.dry_run.candidate', {
        theme_id: theme.id,
        source_url: cand.source_url,
        quality_score: cand.quality_score,
        title: cand.title,
        reason: cand.filter_reason,
      });
      themeSummary.inserted++;
      summary.candidatesInserted++;
      continue;
    }
    try {
      await processCandidate(theme, cand, runId, themeSummary, summary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('error', 'banker.candidate.unhandled', {
        theme_id: theme.id,
        url: cand.source_url,
        error: msg.slice(0, 300),
      });
      summary.errors.push(`candidate=${cand.source_url} unhandled: ${msg.slice(0, 200)}`);
      themeSummary.skipped++;
      summary.candidatesSkipped++;
    }
  }

  log('info', 'banker.theme.done', {
    theme_id: theme.id,
    candidatesConsidered: themeSummary.candidatesConsidered,
    inserted: themeSummary.inserted,
    skipped: themeSummary.skipped,
  });
  summary.themes.push(themeSummary);
}

async function writeArtifact(path: string, summary: RunSummary): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(summary, null, 2), 'utf8');
  log('info', 'banker.artifact.written', { path });
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', 'banker.args.invalid', { error: msg });
    process.exitCode = 1;
    return;
  }

  const runId = await insertScoutRun('banker');
  setLogContext({ run_id: String(runId), stage: 'banker' });

  const summary: RunSummary = {
    runId,
    themesProcessed: 0,
    candidatesInserted: 0,
    candidatesSkipped: 0,
    errors: [],
    themes: [],
    dryRun: args.dryRun,
  };

  const date = new Date().toISOString().slice(0, 10);
  const artifactPath = join('runs', date, 'banker', `${runId}.json`);

  try {
    const allThemes = await getFreshThemes(48);
    let themes = allThemes;
    if (args.themeId) {
      themes = allThemes.filter((t) => t.id === args.themeId);
      if (themes.length === 0) {
        log('warn', 'banker.theme_id.not_found', { theme_id: args.themeId });
      }
    }
    themes = themes.slice(0, args.maxThemes);

    if (themes.length === 0) {
      log('warn', 'banker.no_themes', { fresh_count: allThemes.length });
      await writeArtifact(artifactPath, summary);
      await finishRun(runId, 'ok', artifactPath);
      return;
    }

    log('info', 'banker.run.start', {
      themes: themes.length,
      dry_run: args.dryRun,
      max_themes: args.maxThemes,
      theme_id: args.themeId,
    });

    for (const theme of themes) {
      try {
        await processTheme(theme, runId, args.dryRun, summary);
        summary.themesProcessed++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('error', 'banker.theme.unhandled', { theme_id: theme.id, error: msg.slice(0, 400) });
        summary.errors.push(`theme=${theme.id} unhandled: ${msg.slice(0, 200)}`);
      }
    }

    await writeArtifact(artifactPath, summary);
    // Non-fatal per-candidate failures (notably durable-storage upload failures)
    // accumulate in summary.errors. If any occurred, finish the run as 'error' and
    // exit non-zero so a broken Drive/upload path shows up RED in Actions instead
    // of a green run that banked nothing deliverable.
    const status: 'ok' | 'error' = summary.errors.length > 0 ? 'error' : 'ok';
    await finishRun(runId, status, artifactPath);
    log(status === 'error' ? 'error' : 'info', 'banker.run.done', {
      status,
      themesProcessed: summary.themesProcessed,
      candidatesInserted: summary.candidatesInserted,
      candidatesSkipped: summary.candidatesSkipped,
      errors: summary.errors.length,
    });
    if (status === 'error') process.exitCode = 1;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', 'banker.run.error', { error: msg.slice(0, 400) });
    summary.errors.push(`fatal: ${msg.slice(0, 300)}`);
    try {
      await writeArtifact(artifactPath, summary);
    } catch (writeErr) {
      const wm = writeErr instanceof Error ? writeErr.message : String(writeErr);
      log('error', 'banker.artifact.write_failed', { error: wm.slice(0, 200) });
    }
    try {
      await finishRun(runId, 'error', artifactPath);
    } catch (finErr) {
      const fm = finErr instanceof Error ? finErr.message : String(finErr);
      log('error', 'banker.finish_run.failed', { error: fm.slice(0, 200) });
    }
    process.exitCode = 1;
  }
}

await main();
