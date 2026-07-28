/**
 * Verifies the text-encoded tool call detector against REAL observed output
 * plus the false-positive cases that matter.
 *
 * A false positive here is expensive: it would reject a legitimate final
 * answer and fail a task that actually succeeded. The prose cases below are
 * therefore as important as the detection cases.
 *
 *   pnpm --filter @workspace/api-server exec tsx ../../scripts/verify-malformed-tool-calls.ts
 */
import { detectMalformedToolCall } from '../packages/core/src/malformed-tool-calls.js';

const TOOLS = ['runInSandbox', 'sendMessage', 'webSearch', 'readFile', 'get_delegation_status', 'health_check'];

let failures = 0;
function expect(label: string, content: string, shouldDetect: boolean, tools = TOOLS) {
  const got = detectMalformedToolCall(content, tools);
  const ok = shouldDetect ? got !== null : got === null;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ` — got ${JSON.stringify(got)}`}`);
  if (!ok) failures++;
  return got;
}

console.log('── MUST DETECT (these silently "completed" tasks) ──');

// The exact line captured from the live DevOps agent on 2026-07-28.
const real =
  '<function.runInSandbox [{"language": "python", "code": "import requests\\nresponse = ' +
  "requests.get('https://tubescribe-service.com/health')\\nprint(response.status_code)\" , \"timeoutMs\": 10000}]</function";
const hit = expect('REAL live output: <function.runInSandbox [...]', real, true);
console.log(`      → tool=${hit?.toolName} pattern=${hit?.pattern}`);

expect('<tool_call> JSON block', '<tool_call>{"name": "webSearch", "arguments": {"q": "x"}}</tool_call>', true);
expect('<invoke name="...">', '<invoke name="readFile"><parameter name="path">a.ts</parameter></invoke>', true);
expect('harmony channel routing', '<|channel|>commentary to=functions.health_check<|message|>{}', true);
expect('functions.NAME( call form', 'I will now run functions.readFile({"path":"src/index.ts"})', true);
expect('llama python_tag', '<|python_tag|>{"name":"webSearch"}', true);
expect('<function=NAME> variant', '<function=sendMessage>{"toAgentId":"apex-cto-001"}</function>', true);

console.log('\n── MUST NOT DETECT (legitimate final answers) ──');

expect(
  'manager prose naming a tool it really called',
  '**Delegation Complete** — I used sendMessage to delegate to the CTO (apex-cto-001). ' +
    'Task ID 12c8c4dd. The CTO will report back once the investigation concludes.',
  false,
);
expect(
  'report mentioning get_delegation_status in prose',
  'I called get_delegation_status and 2 of 3 children succeeded; the Florida sweep failed with 0 results.',
  false,
);
expect('plain narrative result', 'Saved 32 qualifying HVAC leads across Texas. No blockers.', false);
expect('markdown code block of unrelated code', '```python\nimport requests\nprint(requests.get(url))\n```', false);
expect('empty content', '', false);
expect(
  'structural syntax naming a tool the agent does NOT have',
  '<function.someOtherThing [{}]</function>',
  false,
);

console.log('\n── Unknown-tool guard is scoped, not blanket ──');
expect('same syntax detected when tool list is not supplied', '<function.someOtherThing [{}]</function>', true, []);

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
