import assert from 'node:assert/strict';
import {
  dedupeDiscoveredBusinesses,
  generateSearchShards,
  normalizeLeadDomain,
  simulateStreamingPipeline,
} from '../packages/background-jobs/src/index.js';

const records: Array<{ name: string; passed: boolean; detail: string }> = [];

function record(name: string, passed: boolean, detail: string) {
  records.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
}

async function main() {
  const shards = generateSearchShards(['Roofing'], ['Dallas TX'], {
    liveDemoMode: true,
    shardsPerCell: 8,
  });
  record(
    'aggressive query sharding',
    shards.length === 8 && new Set(shards.map((s) => `${s.subcategory}:${s.searchIntent}`)).size === 8,
    `${shards.length} shards for one industry/city cell`,
  );

  record(
    'domain normalization',
    normalizeLeadDomain('https://www.Example.com/path?q=1') === 'example.com',
    String(normalizeLeadDomain('https://www.Example.com/path?q=1')),
  );

  const dedupe = dedupeDiscoveredBusinesses(
    [
      { companyName: 'Apex Roofing', website: 'https://apexroof.example', city: 'Dallas' },
      { companyName: 'Apex Roofing Duplicate', website: 'http://www.apexroof.example', city: 'Dallas' },
      { companyName: 'Known HVAC', website: 'https://known.example', city: 'Dallas' },
      { companyName: 'Fresh Dental', website: 'https://fresh.example', city: 'Dallas' },
    ],
    new Set(['known.example']),
  );
  record(
    'duplicate suppression',
    dedupe.fresh.length === 2 && dedupe.duplicates === 2,
    `${dedupe.fresh.length} fresh, ${dedupe.duplicates} suppressed`,
  );

  const benchmark = await simulateStreamingPipeline({
    totalCandidates: 48,
    duplicateEvery: 6,
    discoveryConcurrency: 8,
    stageConcurrency: 5,
    discoveryDelayMs: 12,
    stageDelayMs: 8,
  });

  record(
    'time to first lead',
    benchmark.timeToFirstLeadMs < 80,
    `${benchmark.timeToFirstLeadMs}ms`,
  );
  record(
    'worker concurrency ceiling',
    benchmark.maxDiscoveryConcurrency <= 8 && benchmark.maxStageConcurrency <= 5,
    `discovery=${benchmark.maxDiscoveryConcurrency}, stage=${benchmark.maxStageConcurrency}`,
  );
  record(
    'throughput measured',
    benchmark.throughputPerSecond > 20,
    `${benchmark.throughputPerSecond.toFixed(1)} leads/sec`,
  );
  record(
    'campaign-ready latency measured',
    benchmark.campaignReadyLatencyMs > 0 && benchmark.campaignReadyLatencyMs < 2000,
    `${benchmark.campaignReadyLatencyMs}ms for ${benchmark.uniqueDiscovered} unique leads`,
  );

  assert.equal(records.every((r) => r.passed), true);
  console.log(JSON.stringify({ benchmark, records }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
