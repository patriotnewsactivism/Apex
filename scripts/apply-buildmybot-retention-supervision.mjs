import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, search, replacement) {
  const source = readFileSync(path, 'utf8');
  if (source.includes(replacement)) return false;
  const first = source.indexOf(search);
  if (first < 0) throw new Error(`Patch anchor not found in ${path}: ${search.slice(0, 120)}`);
  if (source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Patch anchor is ambiguous in ${path}: ${search.slice(0, 120)}`);
  }
  writeFileSync(path, source.slice(0, first) + replacement + source.slice(first + search.length));
  return true;
}

const registry = 'packages/core/src/tool-registry.ts';
replaceOnce(
  registry,
  `import { buildMyBotConfigured, createBuildMyBotTools } from './buildmybot-connector.js';`,
  `import { buildMyBotConfigured, createBuildMyBotTools } from './buildmybot-connector.js';\nimport { createBuildMyBotRetentionTools } from './buildmybot-retention-tools.js';`,
);
replaceOnce(
  registry,
  `    if (buildMyBotConfigured()) {\n      for (const tool of createBuildMyBotTools()) {\n        _registry.register(tool);\n      }\n    }`,
  `    if (buildMyBotConfigured()) {\n      for (const tool of [...createBuildMyBotTools(), ...createBuildMyBotRetentionTools()]) {\n        _registry.register(tool);\n      }\n    }`,
);

const indexPath = 'packages/core/src/index.ts';
const index = readFileSync(indexPath, 'utf8');
if (!index.includes("export * from './buildmybot-retention-tools.js';")) {
  const anchor = "export * from './buildmybot-connector.js';";
  if (!index.includes(anchor)) throw new Error('buildmybot connector export anchor missing');
  writeFileSync(
    indexPath,
    index.replace(anchor, `${anchor}\nexport * from './buildmybot-retention-tools.js';`),
  );
}

console.log('Applied BuildMyBot retention supervision registration patch.');
