export const SYSTEM_PROMPT = `You are a China-tech content scout. Your job: find 3-5 currently hot themes about Chinese tech / EVs / smartphones / robots / smart home / drones / consumer electronics that would make compelling short-form video content for a Russian-speaking audience.

Rules:
- Each theme must be a real, specific product or event (e.g. "Xiaomi SU7 Ultra Nürburgring lap", "Huawei Mate 70 Pro vs iPhone 16 Pro Max camera", "Unitree G1 humanoid update")
- Prefer themes that have recent video content on Bilibili / Douyin / YouTube
- Avoid: politics, military, crypto, gambling, scams, gaming livestreams
- Niche must be one of: "ev" | "smartphone" | "robot" | "smart_home" | "drone" | "wearable" | "general"`;

export function buildUserPrompt(
  date: string,
  redditSignals: string[] = [],
  searchSignals: string[] = [],
): string {
  const signalsBlock =
    redditSignals.length > 0
      ? `\nReal trending Reddit posts from the last week (use as HINTS — keep only ones fitting Chinese tech / EV / robot / gadget topics, ignore the rest):\n${redditSignals
          .map((s, i) => `${i + 1}. ${s}`)
          .join('\n')}\n`
      : '';
  const searchBlock =
    searchSignals.length > 0
      ? `\nRecent web search results (Custom Search, last 14 days — use as grounding, prefer specific products/events, ignore irrelevant hits):\n${searchSignals
          .map((s, i) => `${i + 1}. ${s}`)
          .join('\n')}\n`
      : '';
  const hasSignals = redditSignals.length > 0 || searchSignals.length > 0;
  return `Today is ${date}. Use google_search grounding${hasSignals ? ' and the real signals below' : ''} to find what is HOT in Chinese tech right now (within the last 14 days).
${signalsBlock}${searchBlock}Return JSON with shape:
{
  "themes": [
    {
      "title": "string — punchy Russian title for a shorts video",
      "title_cn": "string — original Chinese name of the product/event",
      "cn_keywords": ["3-6 Chinese search keywords for Bilibili/Douyin search"],
      "why_hot": "1-sentence reason (release just dropped / viral video / record set / etc)",
      "sources": ["urls of the most relevant news articles or videos found via google_search"],
      "niche": "one of: ev|smartphone|robot|smart_home|drone|wearable|general"
    }
  ]
}
Return 3-5 themes. No prose outside the JSON.`;
}
