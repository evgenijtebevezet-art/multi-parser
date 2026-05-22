import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { log } from './logger.js';

export type SearchPlatform = 'bilibili' | 'douyin' | 'youtube';

export type SearchResult = {
  source_platform: 'bilibili' | 'douyin' | 'xiaohongshu' | 'youtube';
  source_url: string;
  source_video_id: string;
  title: string;
  duration_seconds: number;
  view_count: number;
  upload_date: string;
  uploader: string;
};

const SEARCH_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

function execFileAsync(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          reject(
            new Error(
              `yt-dlp failed (code=${e.code ?? '?'} signal=${e.signal ?? '?'}): ${String(stderr).slice(0, 800)}`,
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.on('error', (e) => reject(e));
  });
}

function platformFromUrl(url: string): SearchResult['source_platform'] {
  if (/bilibili\.com|b23\.tv/i.test(url)) return 'bilibili';
  if (/douyin\.com|iesdouyin\.com/i.test(url)) return 'douyin';
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return 'xiaohongshu';
  return 'youtube';
}

function buildSearchTarget(
  platform: SearchPlatform,
  query: string,
  maxResults: number,
): { target: string; effectivePlatform: SearchPlatform } {
  if (platform === 'bilibili') {
    return { target: `bilisearch${maxResults}:${query}`, effectivePlatform: 'bilibili' };
  }
  if (platform === 'douyin') {
    log('warn', 'ytdlp.douyin_unsupported_fallback_youtube', { query });
    return { target: `ytsearch${maxResults}:${query}`, effectivePlatform: 'youtube' };
  }
  return { target: `ytsearch${maxResults}:${query}`, effectivePlatform: 'youtube' };
}

type RawEntry = {
  id?: string;
  title?: string;
  duration?: number;
  view_count?: number;
  upload_date?: string;
  uploader?: string;
  channel?: string;
  webpage_url?: string;
  original_url?: string;
  extractor?: string;
  extractor_key?: string;
};

function normalizeEntry(raw: RawEntry, defaultPlatform: SearchResult['source_platform']): SearchResult | null {
  const url = raw.webpage_url ?? raw.original_url ?? '';
  if (!url) return null;
  const id = raw.id ?? '';
  if (!id) return null;
  const platform = platformFromUrl(url) ?? defaultPlatform;
  return {
    source_platform: platform,
    source_url: url,
    source_video_id: id,
    title: raw.title ?? '',
    duration_seconds: Math.round(raw.duration ?? 0),
    view_count: raw.view_count ?? 0,
    upload_date: raw.upload_date ?? '',
    uploader: raw.uploader ?? raw.channel ?? '',
  };
}

export async function searchVideos(opts: {
  platform: SearchPlatform;
  query: string;
  maxResults: number;
}): Promise<SearchResult[]> {
  const { platform, query, maxResults } = opts;
  if (maxResults <= 0) return [];
  const { target, effectivePlatform } = buildSearchTarget(platform, query, maxResults);
  const args = ['--dump-json', '--no-warnings', '--skip-download', '--flat-playlist', target];

  const t0 = Date.now();
  log('info', 'ytdlp.search', { platform, effectivePlatform, query, maxResults });

  let stdout = '';
  try {
    const r = await execFileAsync('yt-dlp', args, SEARCH_TIMEOUT_MS);
    stdout = r.stdout;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', 'ytdlp.search_failed', { platform, query, error: msg.slice(0, 400) });
    throw new Error(`yt-dlp search failed for ${platform}:${query}: ${msg}`);
  }

  const results: SearchResult[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: RawEntry;
    try {
      raw = JSON.parse(trimmed) as RawEntry;
    } catch {
      continue;
    }
    const norm = normalizeEntry(raw, effectivePlatform);
    if (norm) results.push(norm);
  }

  log('info', 'ytdlp.search_ok', {
    platform,
    query,
    found: results.length,
    ms: Date.now() - t0,
  });
  return results.slice(0, maxResults);
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function downloadVideo(
  url: string,
  outPath: string,
): Promise<{ path: string; sha256: string; sizeBytes: number }> {
  const args = [
    '-o',
    outPath,
    '-f',
    'bestvideo[height<=1080]+bestaudio/best',
    '--merge-output-format',
    'mp4',
    '--no-warnings',
    '--no-playlist',
    url,
  ];

  const t0 = Date.now();
  log('info', 'ytdlp.download', { url, outPath });
  try {
    await execFileAsync('yt-dlp', args, DOWNLOAD_TIMEOUT_MS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', 'ytdlp.download_failed', { url, error: msg.slice(0, 400) });
    throw new Error(`yt-dlp download failed for ${url}: ${msg}`);
  }

  let sizeBytes = 0;
  try {
    sizeBytes = statSync(outPath).size;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`yt-dlp finished but output file missing at ${outPath}: ${msg}`);
  }

  const sha256 = await sha256File(outPath);
  log('info', 'ytdlp.download_ok', {
    url,
    sizeBytes,
    sha256: sha256.slice(0, 12),
    ms: Date.now() - t0,
  });

  return { path: outPath, sha256, sizeBytes };
}
