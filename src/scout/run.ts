import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { env } from '../shared/env.js';
import { log, setLogContext } from '../shared/logger.js';
import { insertScoutRun, finishRun, insertThemes, type ThemeInput } from '../shared/repositories.js';
import { callLlmCascade, CASCADE_SCOUT, type LlmResult } from '../shared/llmFallback.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';
import { fetchRedditTrending } from '../shared/reddit.js';
import { ScoutResponseSchema, SCOUT_JSON_SCHEMA, type ScoutResponse } from './schema.js';

const DRY_RUN = process.argv.includes('--dry-run');
const ALLOW_FALLBACK_SEED = process.argv.includes('--allow-fallback-seed');

const MOCK_RESPONSE: ScoutResponse = {
  themes: [
    {
      title: 'Xiaomi SU7 Ultra ставит рекорд на Нюрбургринге',
      title_cn: '小米SU7 Ultra 纽北圈速',
      cn_keywords: ['小米SU7 Ultra', '纽北圈速', '小米汽车', '电动超跑', 'SU7 Ultra'],
      why_hot: 'Xiaomi только что опубликовала видео официального заезда',
      sources: ['https://example.com/mock-su7-ultra'],
      niche: 'ev',
    },
    {
      title: 'Huawei Mate 70 Pro против iPhone 16 Pro Max — слепой тест камеры',
      title_cn: '华为Mate 70 Pro vs iPhone 16 Pro Max 相机',
      cn_keywords: ['华为Mate70Pro', 'Mate70Pro相机', '华为对比苹果', 'Mate 70 Pro 评测'],
      why_hot: 'Серия Mate 70 вышла на этой неделе, активные обзоры',
      sources: ['https://example.com/mock-mate70'],
      niche: 'smartphone',
    },
  ],
};

const FALLBACK_SEED_THEME: ThemeInput = {
  title: 'Xiaomi SU7 Ultra: китайский Porsche за полцены',
  cn_keywords: ['小米SU7 Ultra', '小米汽车', '电动超跑', 'SU7 Ultra 评测'],
  why_hot: 'Fallback seed — реальный LLM-скаут недоступен, тема-заглушка',
  sources: ['https://www.mi.com/su7'],
  niche: 'ev',
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function artifactPathFor(runId: number, date: string): string {
  return resolve(env.CONTENT_BANK_DATA_DIR, '..', 'runs', date, 'scout', `${runId}.json`);
}

async function writeArtifact(
  runId: number,
  llmInfo: { provider: string; model: string } | null,
  themes: ThemeInput[],
  date: string,
): Promise<string> {
  const path = artifactPathFor(runId, date);
  await mkdir(dirname(path), { recursive: true });
  const payload = {
    runId,
    llmProvider: llmInfo?.provider ?? null,
    llmModel: llmInfo?.model ?? null,
    themesCount: themes.length,
    themes,
  };
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
  return path;
}

async function getScoutResponse(): Promise<{ response: ScoutResponse; llm: LlmResult | null }> {
  if (DRY_RUN) {
    log('info', 'scout.dry_run', { themes: MOCK_RESPONSE.themes.length });
    return { response: MOCK_RESPONSE, llm: null };
  }
  let redditSignals: string[] = [];
  if (env.REDDIT_ENABLED !== 'false') {
    try {
      const signals = await fetchRedditTrending();
      redditSignals = signals.map((s) => `[r/${s.subreddit} ${s.score}^] ${s.title}`);
      log('info', 'scout.reddit_signals', { count: redditSignals.length });
    } catch (e) {
      log('warn', 'scout.reddit_failed', {
        error: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
    }
  }
  const llm = await callLlmCascade(CASCADE_SCOUT, {
    prompt: buildUserPrompt(todayIso(), redditSignals),
    systemPrompt: SYSTEM_PROMPT,
    responseFormat: 'json',
    jsonSchema: SCOUT_JSON_SCHEMA,
    tools: ['google_search'],
    maxOutputTokens: 4096,
    temperature: 0.7,
  });

  const raw: unknown = llm.json ?? safeParseJson(llm.text);
  if (raw === undefined) {
    throw new Error(`scout: LLM returned non-JSON body (provider=${llm.provider} model=${llm.model})`);
  }
  const parsed = ScoutResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`scout: LLM JSON failed schema: ${parsed.error.message}`);
  }
  return { response: parsed.data, llm };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
}

function toThemeInputs(response: ScoutResponse): ThemeInput[] {
  return response.themes.map((t) => ({
    title: t.title,
    cn_keywords: t.cn_keywords,
    why_hot: t.why_hot,
    sources: t.sources,
    niche: t.niche,
  }));
}

async function main(): Promise<void> {
  const runId = await insertScoutRun('scout');
  setLogContext({ run_id: String(runId), stage: 'scout' });
  log('info', 'scout.start', { dryRun: DRY_RUN, allowFallbackSeed: ALLOW_FALLBACK_SEED });

  const date = todayIso();
  try {
    let themes: ThemeInput[];
    let llmInfo: { provider: string; model: string } | null = null;
    let usedFallbackSeed = false;

    try {
      const { response, llm } = await getScoutResponse();
      themes = toThemeInputs(response);
      llmInfo = llm ? { provider: llm.provider, model: llm.model } : null;
    } catch (llmErr) {
      const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
      log('error', 'scout.llm_failed', { error: msg });
      if (!ALLOW_FALLBACK_SEED) throw llmErr;
      log('warn', 'scout.using_fallback_seed', {});
      themes = [FALLBACK_SEED_THEME];
      llmInfo = { provider: 'fallback', model: 'hardcoded-seed' };
      usedFallbackSeed = true;
    }

    const ids = await insertThemes(themes, runId);
    log('info', 'scout.themes_inserted', { count: ids.length, usedFallbackSeed });

    const artifact = await writeArtifact(runId, llmInfo, themes, date);
    log('info', 'scout.artifact_written', { path: artifact });

    await finishRun(runId, 'ok', artifact);
    log('info', 'scout.done', { runId, themes: themes.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'scout.failed', { error: msg, stack: err instanceof Error ? err.stack : undefined });
    try {
      await finishRun(runId, 'error');
    } catch (finishErr) {
      const fm = finishErr instanceof Error ? finishErr.message : String(finishErr);
      log('error', 'scout.finish_run_failed', { error: fm });
    }
    process.exitCode = 1;
  }
}

await main();
