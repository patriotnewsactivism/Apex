import { readFileSync } from 'fs';
import { normalizeIndustry, isIcpIndustry, ICP_INDUSTRIES } from './packages/core/src/industry-taxonomy.js';

const rows: Array<[string, number, number]> = JSON.parse(readFileSync('/tmp/icp-rows.json', 'utf8'));

const canon = new Map<string, number>();
let selected = 0, excludedOffIcp = 0, excludedNoSite = 0;
const excludedSamples = new Map<string, number>();

for (const [raw, n, withSite] of rows) {
  const value = raw === '(null)' ? null : raw;
  const c = normalizeIndustry(value) ?? '(none)';
  canon.set(c, (canon.get(c) ?? 0) + n);
  const noSite = n - withSite;
  excludedNoSite += noSite;
  if (isIcpIndustry(value)) selected += withSite;
  else { excludedOffIcp += withSite; excludedSamples.set(c, (excludedSamples.get(c) ?? 0) + withSite); }
}

console.log('\n== taxonomy collapse ==');
console.log('raw distinct strings in sample :', rows.length);
console.log('canonical buckets after        :', canon.size);

console.log('\n== ICP selection (what a backlog push would take) ==');
console.log('SELECTED (ICP + has website)   :', selected);
console.log('excluded, off-ICP              :', excludedOffIcp);
console.log('excluded, no website           :', excludedNoSite);

console.log('\n== what gets SELECTED, by canonical industry ==');
const sel = [...canon].filter(([k]) => ICP_INDUSTRIES.includes(k)).sort((a,b)=>b[1]-a[1]);
for (const [k, v] of sel) console.log('  ' + k.padEnd(16) + v);

console.log('\n== biggest EXCLUSIONS (sanity-check these are right) ==');
for (const [k, v] of [...excludedSamples].sort((a,b)=>b[1]-a[1]).slice(0, 12)) console.log('  ' + k.padEnd(24) + v);

console.log('\n== avoid-list check (BUSINESS_PROFILE: no restaurants/retail) ==');
for (const probe of ['Restaurant', 'Mexican', 'Retail', 'Hair Salon', 'Day Spa', 'Medical', 'Urgent Care', 'Title Company']) {
  console.log('  ' + probe.padEnd(16) + '-> ' + String(normalizeIndustry(probe)).padEnd(20) + (isIcpIndustry(probe) ? 'SELECTED  <-- WRONG' : 'excluded  ok'));
}
console.log('\n== ICP positives must all select ==');
for (const probe of ['Heating & Air Conditioning/HVAC', 'roofing contractor', 'Personal Injury Law', 'General Dentistry, Cosmetic Dentists', 'medical spa', 'real estate agency', 'Solar Installation / Energy', 'Family Law']) {
  console.log('  ' + probe.slice(0,34).padEnd(36) + '-> ' + String(normalizeIndustry(probe)).padEnd(14) + (isIcpIndustry(probe) ? 'SELECTED ok' : 'excluded  <-- WRONG'));
}
