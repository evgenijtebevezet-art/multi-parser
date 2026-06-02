import { GoogleGenAI } from '@google/genai';
import { env } from './env.js';
import { log } from './logger.js';

export type Provider = 'gemini' | 'groq' | 'nvidia';

export type ModelSpec = {
  provider: Provider;
  model: string;
};

export type LlmTool = 'google_search' | 'url_context' | 'code_execution';

export type LlmCall = {
  prompt: string;
  systemPrompt?: string;
  responseFormat?: 'text' | 'json';
  jsonSchema?: object;
  tools?: LlmTool[];
  videoUri?: string;
  maxOutputTokens?: number;
  temperature?: number;
};

export type LlmResult = {
  text: string;
  json?: unknown;
  provider: string;
  model: string;
  ms: number;
};

const DEFAULT_TIMEOUT_MS = 40_000;

export const CASCADE_SCOUT: ModelSpec[] = [
  { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview' },
  { provider: 'gemini', model: 'gemini-3.5-flash' },
  { provider: 'gemini', model: 'gemini-flash-lite-latest' },
  { provider: 'groq', model: 'qwen/qwen3-32b' },
];

export const CASCADE_VIDEO_FILTER: ModelSpec[] = [
  { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview' },
  { provider: 'gemini', model: 'gemini-3.5-flash' },
  { provider: 'nvidia', model: 'nvidia/cosmos-reason2-8b' },
];

export const CASCADE_TRANSLATOR: ModelSpec[] = [
  { provider: 'gemini', model: 'gemini-3.5-flash' },
  { provider: 'gemini', model: 'gemini-3-flash-preview' },
  { provider: 'nvidia', model: 'qwen/qwen3.5-122b-a10b' },
];

export const CASCADE_EMBEDDING: ModelSpec[] = [
  { provider: 'gemini', model: 'gemini-embedding-001' },
  { provider: 'nvidia', model: 'baai/bge-m3' },
];

class LlmError extends Error {
  constructor(
    message: string,
    public kind: 'rate_limit' | 'server' | 'timeout' | 'auth' | 'geo' | 'unknown',
    public status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

function classifyError(status: number | undefined, bodyText: string): LlmError['kind'] {
  if (status === 429) return 'rate_limit';
  if (status !== undefined && status >= 500 && status < 600) return 'server';
  if (status === 401 || status === 403) {
    if (/User location is not supported/i.test(bodyText)) return 'geo';
    return 'auth';
  }
  if (/User location is not supported/i.test(bodyText)) return 'geo';
  return 'unknown';
}

function isRetryable(kind: LlmError['kind']): boolean {
  return kind === 'rate_limit' || kind === 'server' || kind === 'timeout' || kind === 'geo' || kind === 'auth';
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LlmError(`${label} timed out after ${ms}ms`, 'timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getGeminiClient(): GoogleGenAI {
  if (!env.GEMINI_API_KEY) {
    throw new LlmError('GEMINI_API_KEY missing', 'auth');
  }
  return new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
}

type GenAiPart = { text: string } | { fileData: { fileUri: string; mimeType: string } };

async function callGemini(spec: ModelSpec, call: LlmCall): Promise<LlmResult> {
  const ai = getGeminiClient();
  const start = Date.now();

  let contents: string | Array<{ role: string; parts: GenAiPart[] }>;
  if (call.videoUri) {
    const parts: GenAiPart[] = [
      { fileData: { fileUri: call.videoUri, mimeType: 'video/*' } },
      { text: call.prompt },
    ];
    contents = [{ role: 'user', parts }];
  } else {
    contents = call.prompt;
  }

  const config: Record<string, unknown> = {};
  if (call.systemPrompt) config.systemInstruction = call.systemPrompt;
  if (call.responseFormat === 'json') config.responseMimeType = 'application/json';
  if (call.jsonSchema) config.responseSchema = call.jsonSchema;
  if (call.tools && call.tools.length > 0) {
    config.tools = call.tools.map((t) => ({ [t]: {} }));
  }
  if (call.maxOutputTokens !== undefined) config.maxOutputTokens = call.maxOutputTokens;
  if (call.temperature !== undefined) config.temperature = call.temperature;

  let resp: unknown;
  try {
    resp = await withTimeout(
      ai.models.generateContent({
        model: spec.model,
        contents: contents as never,
        config: config as never,
      }),
      DEFAULT_TIMEOUT_MS,
      `gemini:${spec.model}`,
    );
  } catch (e) {
    if (e instanceof LlmError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const statusMatch = /\b(\d{3})\b/.exec(msg);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;
    throw new LlmError(msg, classifyError(status, msg), status);
  }

  const r = resp as { text?: string; candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  let text = r.text ?? '';
  if (!text && r.candidates && r.candidates[0]?.content?.parts) {
    text = r.candidates[0].content.parts.map((p) => p.text ?? '').join('');
  }

  let json: unknown;
  if (call.responseFormat === 'json' && text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  return {
    text,
    json,
    provider: 'gemini',
    model: spec.model,
    ms: Date.now() - start,
  };
}

async function callOpenAiCompat(
  spec: ModelSpec,
  call: LlmCall,
  url: string,
  apiKey: string | undefined,
  providerName: Provider,
): Promise<LlmResult> {
  if (!apiKey) {
    throw new LlmError(`${providerName.toUpperCase()}_API_KEY missing`, 'auth');
  }
  const start = Date.now();
  const messages: Array<{ role: string; content: string }> = [];
  if (call.systemPrompt) messages.push({ role: 'system', content: call.systemPrompt });
  messages.push({ role: 'user', content: call.prompt });

  const body: Record<string, unknown> = {
    model: spec.model,
    messages,
  };
  if (call.temperature !== undefined) body.temperature = call.temperature;
  if (call.maxOutputTokens !== undefined) body.max_tokens = call.maxOutputTokens;
  if (call.responseFormat === 'json') body.response_format = { type: 'json_object' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (ac.signal.aborted) throw new LlmError(`${providerName}:${spec.model} timeout`, 'timeout');
    throw new LlmError(msg, 'unknown');
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await resp.text();
  if (!resp.ok) {
    throw new LlmError(
      `${providerName} ${resp.status}: ${bodyText.slice(0, 500)}`,
      classifyError(resp.status, bodyText),
      resp.status,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new LlmError(`${providerName} returned non-JSON body`, 'unknown');
  }

  const p = parsed as { choices?: Array<{ message?: { content?: string } }> };
  const text = p.choices?.[0]?.message?.content ?? '';

  let json: unknown;
  if (call.responseFormat === 'json' && text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  return {
    text,
    json,
    provider: providerName,
    model: spec.model,
    ms: Date.now() - start,
  };
}

async function callGroq(spec: ModelSpec, call: LlmCall): Promise<LlmResult> {
  return callOpenAiCompat(
    spec,
    call,
    'https://api.groq.com/openai/v1/chat/completions',
    env.GROQ_API_KEY,
    'groq',
  );
}

async function callNvidia(spec: ModelSpec, call: LlmCall): Promise<LlmResult> {
  return callOpenAiCompat(
    spec,
    call,
    'https://integrate.api.nvidia.com/v1/chat/completions',
    env.NVIDIA_API_KEY,
    'nvidia',
  );
}

async function callOne(spec: ModelSpec, call: LlmCall): Promise<LlmResult> {
  switch (spec.provider) {
    case 'gemini':
      return callGemini(spec, call);
    case 'groq':
      return callGroq(spec, call);
    case 'nvidia':
      return callNvidia(spec, call);
  }
}

export async function callLlmCascade(cascade: ModelSpec[], call: LlmCall): Promise<LlmResult> {
  if (cascade.length === 0) {
    throw new Error('callLlmCascade: empty cascade');
  }
  const errors: Array<{ spec: ModelSpec; error: string; kind: string }> = [];

  for (const spec of cascade) {
    const t0 = Date.now();
    log('info', 'llm.attempt', { provider: spec.provider, model: spec.model });
    try {
      const result = await callOne(spec, call);
      log('info', 'llm.ok', {
        provider: spec.provider,
        model: spec.model,
        ms: result.ms,
        chars: result.text.length,
      });
      return result;
    } catch (e) {
      const kind = e instanceof LlmError ? e.kind : 'unknown';
      const msg = e instanceof Error ? e.message : String(e);
      const ms = Date.now() - t0;
      log('warn', 'llm.fail', { provider: spec.provider, model: spec.model, kind, ms, error: msg.slice(0, 300) });
      errors.push({ spec, error: msg, kind });
      if (e instanceof LlmError && !isRetryable(e.kind)) {
        throw new Error(
          `LLM cascade non-retryable error on ${spec.provider}:${spec.model}: ${msg}`,
        );
      }
      continue;
    }
  }

  throw new Error(
    `LLM cascade exhausted (${cascade.length} models): ${errors
      .map((er) => `${er.spec.provider}:${er.spec.model}[${er.kind}]`)
      .join(', ')}`,
  );
}

const EMBEDDING_DIM = 3072;

async function geminiEmbed(text: string): Promise<Float32Array> {
  const ai = getGeminiClient();
  const resp = await withTimeout(
    ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: text,
      config: {
        taskType: 'SEMANTIC_SIMILARITY',
        outputDimensionality: EMBEDDING_DIM,
      } as never,
    }),
    DEFAULT_TIMEOUT_MS,
    'gemini-embed',
  );
  const r = resp as {
    embeddings?: Array<{ values?: number[] }>;
    embedding?: { values?: number[] };
  };
  const values = r.embeddings?.[0]?.values ?? r.embedding?.values;
  if (!values || values.length === 0) {
    throw new LlmError('gemini embedding returned no values', 'unknown');
  }
  return new Float32Array(values);
}

async function nvidiaEmbed(text: string): Promise<Float32Array> {
  if (!env.NVIDIA_API_KEY) throw new LlmError('NVIDIA_API_KEY missing', 'auth');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'baai/bge-m3',
        input: [text],
        input_type: 'query',
      }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const bodyText = await resp.text();
  if (!resp.ok) {
    throw new LlmError(`nvidia embed ${resp.status}: ${bodyText.slice(0, 300)}`, classifyError(resp.status, bodyText), resp.status);
  }
  const parsed = JSON.parse(bodyText) as { data?: Array<{ embedding?: number[] }> };
  const values = parsed.data?.[0]?.embedding;
  if (!values || values.length === 0) {
    throw new LlmError('nvidia embedding returned no values', 'unknown');
  }
  const padded = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < Math.min(values.length, EMBEDDING_DIM); i++) {
    padded[i] = values[i];
  }
  return padded;
}

export async function getEmbedding(text: string): Promise<Float32Array> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('getEmbedding: empty text');
  // Dedup correctness REQUIRES every stored vector come from the SAME embedding
  // model: cosine distance between vectors from different models — or a real
  // vector vs a zero-padded one — is meaningless. So we use exactly ONE provider
  // (env.EMBEDDING_PROVIDER) and intentionally do NOT fall back to a different
  // model. A transient failure throws; the banker catches it and skips the
  // candidate (re-discoverable next run), which is strictly better than poisoning
  // the dedup space with an incomparable vector.
  const provider = env.EMBEDDING_PROVIDER;
  const model = provider === 'gemini' ? 'gemini-embedding-001' : 'baai/bge-m3';
  const t0 = Date.now();
  log('info', 'embed.attempt', { provider, model });
  try {
    const v = provider === 'gemini' ? await geminiEmbed(trimmed) : await nvidiaEmbed(trimmed);
    log('info', 'embed.ok', { provider, model, ms: Date.now() - t0, dim: v.length });
    return v;
  } catch (e) {
    const kind = e instanceof LlmError ? e.kind : 'unknown';
    const msg = e instanceof Error ? e.message : String(e);
    log('error', 'embed.fail', { provider, model, kind, error: msg.slice(0, 300) });
    throw new Error(`getEmbedding: ${provider} failed (no cross-model fallback): ${msg}`);
  }
}
