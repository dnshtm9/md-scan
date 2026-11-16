import { readFileSync } from 'node:fs';
import { parse } from './parse.js';

const KIT = 'C:/Users/infer/makefun/kit/markdown-render-speed-02-kit/practice';
const cases = JSON.parse(readFileSync(`${KIT}/input/cases.json`, 'utf8'));
const inputs = cases.filter((c) => c.id.startsWith('doc-')).map((c) => c.markdown);
for (let round = 0; round < 6; round++) {
  for (let i = 0; i < inputs.length; i++) parse(inputs[i]);
}
console.log('done');
