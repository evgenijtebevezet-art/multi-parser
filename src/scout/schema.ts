import { z } from 'zod';

export const NICHES = ['ev', 'smartphone', 'robot', 'smart_home', 'drone', 'wearable', 'general'] as const;

export const ThemeLlmSchema = z.object({
  title: z.string().min(3).max(200),
  title_cn: z.string().min(1).max(200),
  cn_keywords: z.array(z.string().min(1).max(60)).min(1).max(12),
  why_hot: z.string().min(3).max(400),
  sources: z.array(z.string().url()).max(12).default([]),
  niche: z.enum(NICHES),
});

export type ThemeLlm = z.infer<typeof ThemeLlmSchema>;

export const ScoutResponseSchema = z.object({
  themes: z.array(ThemeLlmSchema).min(1).max(8),
});

export type ScoutResponse = z.infer<typeof ScoutResponseSchema>;

export const SCOUT_JSON_SCHEMA: object = {
  type: 'object',
  properties: {
    themes: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          title_cn: { type: 'string' },
          cn_keywords: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 12,
          },
          why_hot: { type: 'string' },
          sources: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 12,
          },
          niche: {
            type: 'string',
            enum: [...NICHES],
          },
        },
        required: ['title', 'title_cn', 'cn_keywords', 'why_hot', 'sources', 'niche'],
      },
    },
  },
  required: ['themes'],
};
