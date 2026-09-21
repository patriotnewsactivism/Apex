/**
 * Guard: the keyless lead-source fallback actually queries something real,
 * and a failed search reports why instead of blaming the query.
 *
 * Two production failures this locks down, both found 2026-09-21 in live logs:
 *
 *  1. searchBusinessDirectory's OSM fallback regex-matched the query against
 *     the OSM `name` tag across all of the US. Businesses are named "Aable
 *     Bail Bonds", not "bail bonds agency", so the "no key, always works"
 *     provider returned zero on every sweep. OSM models what a business IS in
 *     its tags (office=bail_bond), so the query must be tag-based.
 *
 *  2. webSearch swallowed non-ok HTTP responses — the catch only fires on
 *     thrown exceptions — then told the agent "try a more specific query".
 *     With Tavily and Brave both failing auth, the agent reworded the same
 *     search ten times against a dead chain and burned scarce LLM capacity.
 *
 * Pure: the tag/location parsing is executed directly. No network, no DB.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}`);
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail)}`);
}

async function main(): Promise<void> {
  console.log('Verifying lead-source tools...\n');

  const mod = (await import(
    path.join(root, 'packages/core/src/tool-registry.ts')
  )) as typeof import('../packages/core/src/tool-registry.js');
  const { osmTagFiltersForQuery, osmLocationFromQuery } = mod;

  // ── 1. Category → real OSM tags ──────────────────────────────────────────
  console.log('── query → OSM category tags ──');
  const bail = osmTagFiltersForQuery('bail bonds agency California');
  check(
    'bail bonds maps to office=bail_bond (the tag OSM actually uses)',
    bail.tags.includes('office=bail_bond'),
    bail,
  );
  const law = osmTagFiltersForQuery('Tampa FL personal injury law firm phone website');
  check('personal injury maps to office=lawyer', law.tags.includes('office=lawyer'), law);
  const auto = osmTagFiltersForQuery('auto body collision repair shop Charlotte North Carolina');
  check('auto body maps to shop=car_repair', auto.tags.includes('shop=car_repair'), auto);
  const vet = osmTagFiltersForQuery('Portland Oregon veterinary clinic contact phone');
  check('veterinary maps to amenity=veterinary', vet.tags.includes('amenity=veterinary'), vet);

  const unknown = osmTagFiltersForQuery('artisanal widget refurbishment Springfield');
  check(
    'an unrecognized category yields NO tags (so the caller reports it instead of guessing)',
    unknown.tags.length === 0,
    unknown,
  );

  // ── 2. Location survives category stripping ──────────────────────────────
  console.log('\n── query → geocodable place ──');
  for (const [query, expected] of [
    ['bail bonds agency California', 'california'],
    ['auto body collision repair shop Charlotte North Carolina', 'charlotte north carolina'],
    ['Portland Oregon veterinary clinic contact phone', 'portland oregon'],
    ['pest control company Orlando FL family owned official website contact', 'orlando fl'],
  ] as const) {
    const { matchedKeywords } = osmTagFiltersForQuery(query);
    const place = osmLocationFromQuery(query, matchedKeywords);
    check(`"${query}" → place "${expected}"`, place === expected, { got: place });
  }

  const placeless = osmLocationFromQuery(
    'bail bonds agency',
    osmTagFiltersForQuery('bail bonds agency').matchedKeywords,
  );
  check(
    'a query with no place resolves to empty (caller must ask for a city/state, not scan the planet)',
    placeless === '',
    { got: placeless },
  );

  // ── 3. Source-structural: the old broken shapes are gone ────────────────
  console.log('\n── regressions that must stay fixed ──');
  const src = fs.readFileSync(path.join(root, 'packages/core/src/tool-registry.ts'), 'utf8');

  check(
    'OSM no longer name-regex-matches the query across all of the United States',
    !/area\["name"="United States"\]/.test(src),
  );
  check(
    'OSM queries by tag selector inside a bounding box',
    /nwr\["\$\{key\}"="\$\{value\}"\]\(\$\{bbox\}\)/.test(src),
  );
  check(
    'Nominatim is called with an identifying User-Agent (its usage policy requires one)',
    /nominatim\.openstreetmap\.org[\s\S]{0,400}'User-Agent'/.test(src),
  );
  check(
    'searchBusinessDirectory reports per-provider attempts when it finds nothing',
    /attempts:\s*\[/.test(src),
  );
  check(
    'Overpass fails over across multiple public endpoints (a single one 503s under load)',
    /const OVERPASS_ENDPOINTS = \[/.test(src) &&
      /for \(const endpoint of OVERPASS_ENDPOINTS\)/.test(src),
  );

  // webSearch: non-ok responses must be recorded, not silently dropped.
  const webSearchStart = src.indexOf("name: 'webSearch'");
  const webSearchSrc = src.slice(webSearchStart, webSearchStart + 16000);
  check(
    'webSearch logs Tavily non-ok HTTP status',
    /if \(!tavilyRes\.ok\)/.test(webSearchSrc),
  );
  check(
    'webSearch logs Brave non-ok HTTP status',
    /if \(!braveRes\.ok\)/.test(webSearchSrc),
  );
  check(
    'webSearch sends the current Tavily bearer header',
    /Authorization: `Bearer \$\{tavilyKey\}`/.test(webSearchSrc),
  );
  check(
    'Tavily and Brave calls are bounded by a timeout',
    (webSearchSrc.match(/AbortSignal\.timeout/g) ?? []).length >= 2,
  );
  check(
    'webSearch returns diagnostics to the agent',
    /diagnostics,/.test(webSearchSrc),
  );
  check(
    'a provider-side failure does NOT tell the agent to reword the query',
    /Rewording will not help/.test(webSearchSrc),
  );

  if (failures > 0) {
    console.error(`\n${failures} lead-source-tool check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll lead-source-tool checks passed.');
}

main();
