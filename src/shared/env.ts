import { z } from 'zod';
import 'dotenv/config';

const Env = z.object({
  TURSO_URL: z.string().optional(),
  TURSO_TOKEN: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
  // Embedding model used for candidate dedup. MUST stay fixed for a deployment:
  // dedup compares vectors by cosine distance, which is only meaningful between
  // vectors from the SAME model — there is intentionally no cross-model fallback.
  // Default gemini (gemini-embedding-001): the GH GEMINI_API_KEY works for
  // embeddings in CI (verified) and every vector already banked on master is
  // gemini, so the dedup space stays consistent. NVIDIA baai/bge-m3 currently
  // 500s on every call, which silently skipped every candidate (0 banked).
  EMBEDDING_PROVIDER: z.enum(['gemini', 'nvidia']).default('gemini'),
  CONTENT_BANK_DATA_DIR: z.string().default('./data'),
  CONTENT_BANK_VIDEOS_DIR: z.string().default('./data/videos'),
  YOUTUBE_API_KEY: z.string().optional(),
  SEARCH_API_KEY: z.string().optional(),
  SEARCH_CX: z.string().optional(),
  SEARCH_QUERIES: z.string().optional(),
  GDRIVE_SA_JSON: z.string().optional(),
  GDRIVE_OAUTH_CLIENT_ID: z.string().optional(),
  GDRIVE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GDRIVE_OAUTH_REFRESH_TOKEN: z.string().optional(),
  GDRIVE_QUOTA_PROJECT: z.string().optional(),
  REDDIT_ENABLED: z.string().optional(),
  REDDIT_SUBREDDITS: z.string().optional(),
});

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;
