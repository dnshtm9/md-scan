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
const firstPass = [];
for (const c of cases) {
  const want = expected.get(c.id);
  let got;
  try {
    got = parse(c.markdown);
  } catch (e) {
    got = `THREW: ${e && e.message}`;
    failures.push({ id: c.id, got, want });
    firstPass.push(null);
    continue;
  }
  firstPass.push(got);
  if (got === want) pass++;
  else failures.push({ id: c.id, got, want });
}

console.log(`cases_passed ${pass} / ${cases.length}`);

// Determinism: a second full pass over all cases in the same process must
// reproduce the first pass byte for byte. This guards module-level scan state
// (TEXT_ESC) from leaking within a parse or between parse calls.
let stable = 0;
for (let i = 0; i < cases.length; i++) {
  const a = firstPass[i];
  if (a === null) continue;
  const b = parse(cases[i].markdown);
  if (a === b) stable++;
  else failures.push({ id: `nondeterministic ${cases[i].id}`, got: 'second pass differs', want: 'identical to first pass' });
}
console.log(`determinism ${stable} / ${cases.length}`);

// Audit regressions: shapes found by differential probing that once failed.
// Expected HTML is marked's (the reference) for general parser shapes, not
// anything tied to the practice set.
const regressions = [
  ['~~🙂a🙂~~', '<p><del>🙂a🙂</del></p>\n'],
  ['~~🙂a~~', '<p><del>🙂a</del></p>\n'],
  ['**🙂a**', '<p><strong>🙂a</strong></p>\n'],
  ['**🙂a🙂**', '<p><strong>🙂a🙂</strong></p>\n'],
  ['__🙂a__', '<p><strong>🙂a</strong></p>\n'],
  ['__🙂a🙂__', '<p><strong>🙂a🙂</strong></p>\n'],
  ['_🙂a_', '<p><em>🙂a</em></p>\n'],
  ['*🙂a*', '<p><em>🙂a</em></p>\n'],
  ['~~🙂~~', '<p><del>🙂</del></p>\n'],
  ['~~🙂a~~ and ~~b~~', '<p><del>🙂a</del> and <del>b</del></p>\n'],
  ['***🙂a***', '<p><em><strong>🙂a</strong></em></p>\n'],
  ['**𝐀a**', '<p><strong>𝐀a</strong></p>\n'],
  ['~~𝐀a~~', '<p><del>𝐀a</del></p>\n'],
  ['_𝐀a_', '<p><em>𝐀a</em></p>\n'],
  ['*🙂a* + ~~🙂b~~', '<p><em>🙂a</em> + <del>🙂b</del></p>\n'],
  // The text run ends on a mailto: trigger; the trigger's preceding escape
  // character is still part of the run and must be escaped.
  ['*>mailto:', '<p>*&gt;mailto:</p>\n'],
];
let regPass = 0;
for (const [md, want] of regressions) {
  let got;
  try {
    got = parse(md);
  } catch (e) {
    got = `THREW: ${e && e.message}`;
  }
  if (got === want) regPass++;
  else {
    failures.push({ id: `regression ${JSON.stringify(md)}`, got, want });
    console.log(`\nREGRESSION FAIL ${JSON.stringify(md)}`);
    console.log('  want', JSON.stringify(want));
    console.log('  got ', JSON.stringify(got));
  }
}
console.log(`audit_regressions ${regPass} / ${regressions.length}`);

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