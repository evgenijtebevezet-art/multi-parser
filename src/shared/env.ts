import { z } from 'zod';
import 'dotenv/config';

const Env = z.object({
  TURSO_URL: z.string().optional(),
  TURSO_TOKEN: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
  CONTENT_BANK_DATA_DIR: z.string().default('./data'),
  CONTENT_BANK_VIDEOS_DIR: z.string().default('./data/videos'),
  YOUTUBE_API_KEY: z.string().optional(),
  GDRIVE_SA_JSON: z.string().optional(),
});

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;
