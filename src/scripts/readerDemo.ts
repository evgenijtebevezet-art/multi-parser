import { getNextCandidate } from '../reader/index.js';

async function main(): Promise<void> {
  const result = await getNextCandidate({
    niche: '*',
    botId: 'demo',
    botRunId: 'demo-run-1',
    preferDailyPick: false,
    minDurationSec: 5,
  });
  if (!result) {
    console.log('[reader-demo] no available candidate');
    return;
  }
  console.log('[reader-demo] claimed candidate:');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('[reader-demo] failed:', err);
  process.exit(1);
});
