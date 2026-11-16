// Benchmark over the practice set: this parser vs marked 18.1.3.
// Rounds are interleaved so machine noise hits both sides alike; the ratio of
// each round is what matters, reported as median and best.
import { readFileSync } from 'node:fs';
import { parse } from './parse.js';
import { pathToFileURL } from 'node:url';
const { marked } = await import(pathToFileURL('C:/Users/infer/makefun/kit/markdown-render-speed-02-kit/baselines/vendor/marked/marked.esm.js').href);

const KIT = 'C:/Users/infer/makefun/kit/markdown-render-speed-02-kit/practice';
const cases = JSON.parse(readFileSync(`${KIT}/input/cases.json`, 'utf8'));
const ref = JSON.parse(readFileSync(`${KIT}/reference/expected.json`, 'utf8'));
const want = ref.cases.map((c) => c.html);
const inputs = cases.map((c) => c.markdown);

const { performance } = await import('node:perf_hooks');

function run(fn) {
  let n = 0;
  for (let i = 0; i < inputs.length; i++) n += fn(inputs[i]).length;
  return n;
}

let same = 0;
for (let i = 0; i < inputs.length; i++) if (parse(inputs[i]) === want[i]) same++;

const base = (md) => marked.parse(md);
run(parse);
run(base);
const mine = [];
const baseT = [];
for (let r = 0; r < 21; r++) {
  const t0 = performance.now();
  run(parse);
  const t1 = performance.now();
  run(base);
  const t2 = performance.now();
  mine.push(t1 - t0);
  baseT.push(t2 - t1);
}
const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], p25: s[s.length >> 2], med: s[(s.length - 1) >> 1] };
};
const ratios = mine.map((m, i) => baseT[i] / m).sort((a, b) => a - b);
console.log(`cases_passed ${same} / ${inputs.length}`);
console.log(`wall mine     min ${stat(mine).min.toFixed(1)}  median ${stat(mine).med.toFixed(1)} ms`);
console.log(`wall baseline min ${stat(baseT).min.toFixed(1)}  median ${stat(baseT).med.toFixed(1)} ms`);
console.log(`speedup       median ${ratios[ratios.length >> 1].toFixed(2)}x  best ${ratios[ratios.length - 1].toFixed(2)}x  p25 ${ratios[ratios.length >> 2].toFixed(2)}x`);