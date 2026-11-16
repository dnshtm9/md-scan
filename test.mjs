// Local correctness check: renders every practice case and compares the
// result, code unit for code unit, with the reference HTML.
import { readFileSync } from 'node:fs';
import { parse } from './parse.js';

const KIT = 'C:/Users/infer/makefun/kit/markdown-render-speed-02-kit/practice';
const cases = JSON.parse(readFileSync(`${KIT}/input/cases.json`, 'utf8'));
const ref = JSON.parse(readFileSync(`${KIT}/reference/expected.json`, 'utf8'));
const expected = new Map(ref.cases.map((c) => [c.id, c.html]));

let pass = 0;
const failures = [];
for (const c of cases) {
  const want = expected.get(c.id);
  let got;
  try {
    got = parse(c.markdown);
  } catch (e) {
    failures.push({ id: c.id, got: `THREW: ${e && e.message}`, want });
    continue;
  }
  if (got === want) pass++;
  else failures.push({ id: c.id, got, want });
}

console.log(`cases_passed ${pass} / ${cases.length}`);
const show = Number(process.env.SHOW ?? 10);
for (const f of failures.slice(0, show)) {
  let at = 0;
  const n = Math.min(f.got.length, f.want.length);
  while (at < n && f.got[at] === f.want[at]) at++;
  const ctx = (s) => JSON.stringify(s.slice(Math.max(0, at - 60), at + 120));
  console.log(`\nFAIL ${f.id} at ${at}`);
  console.log('  want', ctx(f.want));
  console.log('  got ', ctx(f.got));
}
if (failures.length > show) console.log(`\n(${failures.length - show} more failures)`);