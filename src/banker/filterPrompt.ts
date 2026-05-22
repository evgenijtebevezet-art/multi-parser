import { z } from 'zod';
import type { Theme } from '../shared/repositories.js';

export const FilterResponseSchema = z.object({
  relevant: z.boolean(),
  quality_score: z.number().min(0).max(1),
  has_watermark: z.boolean(),
  language_cn: z.boolean(),
  reason: z.string(),
});

export type FilterResponse = z.infer<typeof FilterResponseSchema>;

export const filterResponseJsonSchema = {
  type: 'object',
  properties: {
    relevant: { type: 'boolean' },
    quality_score: { type: 'number', minimum: 0, maximum: 1 },
    has_watermark: { type: 'boolean' },
    language_cn: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['relevant', 'quality_score', 'has_watermark', 'language_cn', 'reason'],
} as const;

export function filterPrompt(theme: Theme): string {
  return `Ты модератор китайского видео-контента. Тема: "${theme.title}" (китайские ключи: ${theme.cn_keywords.join(', ')}).

Посмотри видео и ответь в JSON:
{
  "relevant": boolean — действительно ли видео про эту тему,
  "quality_score": number 0..1 — качество съёмки и подача (не любительская трясущаяся камера),
  "has_watermark": boolean — есть ли видимый watermark/логотип канала который займёт >5% кадра,
  "language_cn": boolean — звуковая дорожка на китайском,
  "reason": "одна короткая фраза"
}
Никаких других полей, без prose.`;
}
